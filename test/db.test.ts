// test/mocks.ts (jest setupFiles) replaces ../src/db with stubs; this suite needs the real module.
jest.unmock('../src/db');

// Mock Mongoose first
const mockFindOne = jest.fn();
const mockUpdateMany = jest.fn();
const mockSupporteeFindOneAndUpdate = jest.fn();
const mockCounterFindOneAndUpdate = jest.fn();
const mockBanFindOne = jest.fn();
const mockBanFindOneAndUpdate = jest.fn();
const mockBanDeleteOne = jest.fn();
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

  const userBanModel = {
    findOne: mockBanFindOne,
    findOneAndUpdate: mockBanFindOneAndUpdate,
    deleteOne: mockBanDeleteOne,
  };

  return {
    __esModule: true,
    default: undefined as unknown, // set below
    connect: jest.fn().mockResolvedValue({}),
    Schema,
    model: jest.fn((name: string) => {
      if (name === 'TicketCounter') return counterModel;
      if (name === 'UserBan') return userBanModel;
      return supporteeModel;
    }),
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

  describe('ticket lifecycle', () => {
    it('moves OPEN to WAITING_USER with an atomic guarded update', async () => {
      mockSupporteeFindOneAndUpdate.mockResolvedValue({ ticketId: 5, status: 'waiting_user' });

      const result = await db.transitionTicketStatus(5, 'waiting_user');

      expect(result).toEqual({ ticketId: 5, status: 'waiting_user' });
      expect(mockSupporteeFindOneAndUpdate).toHaveBeenCalledWith(
        { ticketId: 5, status: { $in: ['open', 'waiting_user'] } },
        { $set: { status: 'waiting_user', closed_at: null } },
        { new: true },
      );
    });

    it('does not allow CLOSED as a source for WAITING_USER', async () => {
      mockSupporteeFindOneAndUpdate.mockResolvedValue(null);

      await db.transitionTicketStatus(8, 'waiting_user');

      const filter = mockSupporteeFindOneAndUpdate.mock.calls[0][0];
      expect(filter.status.$in).not.toContain('closed');
    });

    it('sets closed_at when closing a ticket', async () => {
      mockSupporteeFindOneAndUpdate.mockResolvedValue({ ticketId: 9, status: 'closed' });

      await db.transitionTicketStatus(9, 'closed');

      expect(mockSupporteeFindOneAndUpdate).toHaveBeenCalledWith(
        { ticketId: 9, status: { $in: ['open', 'waiting_user', 'closed'] } },
        { $set: { status: 'closed', closed_at: expect.any(Date) } },
        { new: true },
      );
    });
  });

  describe('user bans', () => {
    it('stores bans outside the ticket collection', async () => {
      mockBanFindOneAndUpdate.mockResolvedValue({ userid: 'user1', messenger: 'telegram' });

      await db.banUser('user1', 'telegram');

      expect(mockBanFindOneAndUpdate).toHaveBeenCalledWith(
        { messenger: 'telegram', userid: 'user1' },
        { $setOnInsert: { messenger: 'telegram', userid: 'user1' } },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      );
      expect(mockSupporteeFindOneAndUpdate).not.toHaveBeenCalled();
    });

    it('checks the dedicated ban collection first', async () => {
      const ban = { userid: 'user1', messenger: 'telegram' };
      mockBanFindOne.mockResolvedValue(ban);

      const result = await db.checkBan('user1', 'telegram');

      expect(result).toBe(ban);
      expect(mockBanFindOne).toHaveBeenCalledWith({ messenger: 'telegram', userid: 'user1' });
      expect(mockFindOne).not.toHaveBeenCalled();
    });

    it('unbans without reopening a ticket', async () => {
      mockBanDeleteOne.mockResolvedValue({ deletedCount: 1 });
      mockUpdateMany.mockResolvedValue({ modifiedCount: 0 });

      await db.unbanUser('user1', 'telegram');

      expect(mockBanDeleteOne).toHaveBeenCalledWith({ messenger: 'telegram', userid: 'user1' });
      expect(mockUpdateMany).toHaveBeenCalledWith(
        { messenger: 'telegram', userid: 'user1', status: 'banned' },
        { $set: { status: 'closed', category: null, closed_at: expect.any(Date) } },
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
    it('closes only active lifecycle states', async () => {
      await db.closeAll();
      expect(mockUpdateMany).toHaveBeenCalledWith(
        { status: { $in: ['open', 'waiting_user'] } },
        { $set: { status: 'closed', closed_at: expect.any(Date) } },
      );
    });
  });

  describe('reopen', () => {
    it('reopens only closed matching tickets', async () => {
      await db.reopen('user1', 'support', 'telegram');
      expect(mockUpdateMany).toHaveBeenCalledWith(
        {
          messenger: 'telegram',
          $or: [{ userid: 'user1' }, { ticketId: 'user1' }],
          status: 'closed',
          category: 'support',
        },
        { $set: { status: 'open', closed_at: null } },
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
          $set: { status: 'open', category: 'support', closed_at: null },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      );
    });

    it('closes only OPEN or WAITING_USER matches', async () => {
      mockUpdateMany.mockResolvedValue({ modifiedCount: 2 });
      const result = await db.add('user1', 'closed', 'support', 'telegram');
      expect(result).toBe(2);
      expect(mockUpdateMany).toHaveBeenCalledWith(
        {
          messenger: 'telegram',
          $or: [{ userid: 'user1' }, { ticketId: 'user1' }],
          status: { $in: ['open', 'waiting_user'] },
          category: 'support',
        },
        { $set: { status: 'closed', closed_at: expect.any(Date) } },
      );
    });

    it('keeps the legacy banned API but stores it in UserBan', async () => {
      mockBanFindOneAndUpdate.mockResolvedValue({ userid: 'user1', messenger: 'telegram' });

      const result = await db.add('user1', 'banned', null, 'telegram');

      expect(result).toBe(1);
      expect(mockBanFindOneAndUpdate).toHaveBeenCalled();
      expect(mockSupporteeFindOneAndUpdate).not.toHaveBeenCalled();
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
