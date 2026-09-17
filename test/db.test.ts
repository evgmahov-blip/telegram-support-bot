// test/mocks.ts (jest setupFiles) replaces ../src/db with stubs; this suite needs the real module.
jest.unmock('../src/db');

// Mock Mongoose first
const mockFindOne = jest.fn();
const mockUpdateMany = jest.fn();
const mockSupporteeFindOneAndUpdate = jest.fn();
const mockCounterFindOneAndUpdate = jest.fn();
const mockCreate = jest.fn();

/** Minimal chainable, awaitable query like mongoose returns from findOne(). */
const query = (result: unknown, reject = false) => {
  const q: Record<string, unknown> = {};
  q.sort = jest.fn(() => q);
  q.select = jest.fn(() => q);
  q.then = (onOk: (v: unknown) => unknown, onErr?: (e: unknown) => unknown) =>
    (reject ? Promise.reject(result) : Promise.resolve(result)).then(onOk, onErr);
  return q;
};

jest.mock('mongoose', () => {
  const Schema = jest.fn().mockImplementation(() => ({ plugin: jest.fn(), index: jest.fn() }));
  (Schema as unknown as { Types: unknown }).Types = { Mixed: {}, ObjectId: {} };

  const supporteeModel = {
    findOne: mockFindOne,
    updateMany: mockUpdateMany,
    findOneAndUpdate: mockSupporteeFindOneAndUpdate,
    create: mockCreate,
  };

  const counterModel = {
    findOneAndUpdate: mockCounterFindOneAndUpdate,
  };

  return {
    __esModule: true,
    default: undefined as unknown, // set below
    connect: jest.fn().mockResolvedValue({}),
    Schema,
    model: jest.fn((name: string) => name === 'TicketCounter' ? counterModel : supporteeModel),
    connection: {
      on: jest.fn(),
    },
  };
});
// db.ts uses the default import: make it the same object as the namespace
const mongooseMock = jest.requireMock('mongoose');
mongooseMock.default = mongooseMock;

// Mock cache
jest.mock('../src/cache', () => ({
  config: {
    mongodb_uri: 'mongodb://localhost:27017/test',
  },
  recoveryBaseline: 0,
}));

// Import the module after mocking
import * as db from '../src/db';

describe('Database Module', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getNextTicketId', () => {
    it('raises the counter to the DB baseline and increments it atomically', async () => {
      mockFindOne.mockReturnValue(query({ ticketId: 7 }));
      mockCounterFindOneAndUpdate
        .mockResolvedValueOnce({ seq: 7 })
        .mockResolvedValueOnce({ seq: 8 });

      const ticketId = await db.getNextTicketId();

      expect(ticketId).toBe(8);
      expect(mockCounterFindOneAndUpdate).toHaveBeenNthCalledWith(
        1,
        { _id: 'bot_support:ticketId' },
        { $max: { seq: 7 } },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      );
      expect(mockCounterFindOneAndUpdate).toHaveBeenNthCalledWith(
        2,
        { _id: 'bot_support:ticketId' },
        { $inc: { seq: 1 } },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      );
    });
  });

  describe('getTicketByUserId', () => {
    it('should find ticket by user ID and category', async () => {
      const mockTicket = { id: 1, userid: 'user1', category: 'support' };
      mockFindOne.mockReturnValue(query(mockTicket));

      const result = await db.getTicketByUserId('user1', 'support');
      expect(result).toEqual(mockTicket);
      expect(mockFindOne).toHaveBeenCalledWith({
        $or: [{ userid: 'user1' }],
        category: 'support',
      });
    });

    it('should match uncategorised tickets when category is null', async () => {
      const mockTicket = { id: 1, userid: 'user1' };
      mockFindOne.mockReturnValue(query(mockTicket));

      const result = await db.getTicketByUserId('user1', null);
      expect(result).toEqual(mockTicket);
      expect(mockFindOne).toHaveBeenCalledWith({
        $or: [{ userid: 'user1' }],
        category: null,
      });
    });
  });

  describe('closeAll', () => {
    it('does not turn banned records into closed tickets', async () => {
      await db.closeAll();
      expect(mockUpdateMany).toHaveBeenCalledWith(
        { status: { $ne: 'banned' } },
        { $set: { status: 'closed' } },
      );
    });
  });

  describe('reopen', () => {
    it('reopens matching tickets', async () => {
      await db.reopen('user1', 'support', 'telegram');
      expect(mockUpdateMany).toHaveBeenCalledWith(
        {
          messenger: 'telegram',
          $or: [{ userid: 'user1' }, { ticketId: 'user1' }],
          category: 'support',
        },
        { $set: { status: 'open' } },
      );
    });
  });

  describe('add', () => {
    it('opens without replacing an existing ticket document', async () => {
      mockFindOne.mockReturnValue(query(null));
      mockCounterFindOneAndUpdate
        .mockResolvedValueOnce({ seq: 0 })
        .mockResolvedValueOnce({ seq: 1 });
      mockSupporteeFindOneAndUpdate.mockResolvedValue({ ticketId: 1 });

      const result = await db.add('user1', 'open', 'support', 'telegram');

      expect(result).toBe(1);
      expect(mockSupporteeFindOneAndUpdate).toHaveBeenCalledWith(
        { messenger: 'telegram', userid: 'user1' },
        {
          $setOnInsert: { userid: 'user1', messenger: 'telegram', ticketId: 1 },
          $set: { status: 'open', category: 'support' },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      );
    });

    it('closes matching tickets', async () => {
      mockUpdateMany.mockResolvedValue({ modifiedCount: 2 });
      const result = await db.add('user1', 'closed', 'support', 'telegram');
      expect(result).toBe(2);
    });
  });

  describe('addNewTicket (ticket_per_message)', () => {
    it('inserts a new document instead of updating the existing one', async () => {
      mockFindOne.mockReturnValue(query({ ticketId: 7 }));
      mockCounterFindOneAndUpdate
        .mockResolvedValueOnce({ seq: 7 })
        .mockResolvedValueOnce({ seq: 8 });
      mockCreate.mockResolvedValue({});

      const ticketId = await db.addNewTicket('user1', 'support', 'telegram');

      expect(ticketId).toBe(8);
      expect(mockCreate).toHaveBeenCalledWith({
        userid: 'user1',
        messenger: 'telegram',
        ticketId: 8,
        status: 'open',
        category: 'support',
      });
      expect(mockSupporteeFindOneAndUpdate).not.toHaveBeenCalled();
    });

    it('stores a null category when none is given', async () => {
      mockFindOne.mockReturnValue(query(null));
      mockCounterFindOneAndUpdate
        .mockResolvedValueOnce({ seq: 0 })
        .mockResolvedValueOnce({ seq: 1 });
      mockCreate.mockResolvedValue({});

      await db.addNewTicket('user1', undefined as unknown as null, 'telegram');

      expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ ticketId: 1, category: null }));
    });
  });

  describe('getTicketByUserId ordering', () => {
    it('returns the newest ticket first so per-message tickets resolve to the latest one', async () => {
      const q = query({ ticketId: 3 });
      mockFindOne.mockReturnValue(q);
      await db.getTicketByUserId('user1', null);
      expect(q.sort).toHaveBeenCalledWith({ ticketId: -1 });
    });
  });

  describe('Error handling', () => {
    it('should handle database connection errors gracefully', async () => {
      mockFindOne.mockReturnValue(query(new Error('Database connection failed'), true));
      await expect(db.getTicketByUserId('user1', 'support')).rejects.toThrow('Database connection failed');
    });

    it('should handle null results gracefully', async () => {
      mockFindOne.mockReturnValue(query(null));
      const result = await db.getTicketByUserId('nonexistent', 'support');
      expect(result).toBeNull();
    });
  });
});
