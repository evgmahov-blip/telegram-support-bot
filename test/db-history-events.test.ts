jest.unmock('../src/db');

const mockMessageSave = jest.fn().mockResolvedValue(undefined);
const mockEventSave = jest.fn().mockResolvedValue(undefined);
const mockCounterFindOneAndUpdate = jest.fn();
const mockMessageFind = jest.fn();
const mockEventFind = jest.fn();
const mockEventFindOne = jest.fn();
const mockEventUpdateOne = jest.fn().mockResolvedValue({ modifiedCount: 1 });
const capturedEvents: any[] = [];

const TicketMessageModel: any = jest.fn(function (this: any, data: any) {
  Object.assign(this, data);
  this.save = mockMessageSave;
});
TicketMessageModel.find = mockMessageFind;

const AnalyticsEventModel: any = jest.fn(function (this: any, data: any) {
  Object.assign(this, data);
  capturedEvents.push(data);
  this.save = mockEventSave;
});
AnalyticsEventModel.find = mockEventFind;
AnalyticsEventModel.findOne = mockEventFindOne;
AnalyticsEventModel.updateOne = mockEventUpdateOne;

const SupporteeModel: any = {
  findOne: jest.fn(),
  find: jest.fn(),
  findOneAndUpdate: jest.fn(),
  updateMany: jest.fn(),
  create: jest.fn(),
};

jest.mock('mongoose', () => {
  const Schema = jest.fn().mockImplementation(() => ({ index: jest.fn() }));
  (Schema as any).Types = { Mixed: {}, ObjectId: {} };
  const module = {
    connect: jest.fn().mockResolvedValue({}),
    connection: { on: jest.fn() },
    Schema,
    model: jest.fn((name: string) => {
      if (name === 'TicketMessage') return TicketMessageModel;
      if (name === 'AnalyticsEvent') return AnalyticsEventModel;
      if (name === 'TicketCounter') return { findOneAndUpdate: mockCounterFindOneAndUpdate };
      if (name === 'InternalNote') return jest.fn();
      if (name === 'UserBan') return { findOne: jest.fn(), findOneAndUpdate: jest.fn(), deleteOne: jest.fn() };
      return SupporteeModel;
    }),
  };
  return { __esModule: true, default: module, ...module };
});

jest.mock('../src/cache', () => ({
  config: { mongodb_uri: 'mongodb://localhost/test', llm_memory_depth: 2 },
  recoveryBaseline: 0,
}));

import * as db from '../src/db';

function latestSeq(value: number | null) {
  const q: any = {};
  q.sort = jest.fn(() => q);
  q.select = jest.fn().mockResolvedValue(value === null ? null : { seq: value });
  return q;
}

describe('append-only ticket history and event log', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    capturedEvents.length = 0;
    mockEventFindOne.mockImplementation(() => latestSeq(0));
    mockEventSave.mockResolvedValue(undefined);
  });

  it('appends a ticket message without pruning older messages', async () => {
    await db.addTicketMessage(7, 'user', '123', 'hello');
    expect(TicketMessageModel).toHaveBeenCalledWith({ ticketId: 7, sender: 'user', sender_id: '123', text: 'hello' });
    expect(mockMessageSave).toHaveBeenCalledTimes(1);
    expect(mockMessageFind).not.toHaveBeenCalled();
    expect(mockEventSave).toHaveBeenCalledTimes(1);
  });

  it('keeps LLM context bounded at read time', async () => {
    const q: any = {};
    q.sort = jest.fn(() => q);
    q.limit = jest.fn(() => q);
    q.lean = jest.fn().mockResolvedValue([{ text: 'new' }, { text: 'old' }]);
    mockMessageFind.mockReturnValue(q);
    const result = await db.getConversationHistory(7);
    expect(q.limit).toHaveBeenCalledWith(2);
    expect(result).toHaveLength(2);
  });

  it('assigns the next committed sequence and UUID', async () => {
    mockEventFindOne.mockImplementation(() => latestSeq(41));
    await db.recordAnalyticsEvent('ticket.priority_changed', 7, 'agent-1', { to: 'high' });
    expect(capturedEvents[0]).toEqual(expect.objectContaining({
      seq: 42,
      type: 'ticket.priority_changed',
      ticketId: 7,
      agent_id: 'agent-1',
      metadata: { to: 'high' },
      event_id: expect.stringMatching(/^[0-9a-f-]{36}$/i),
    }));
  });

  it('retries duplicate seq without creating a hole', async () => {
    mockEventFindOne
      .mockImplementationOnce(() => latestSeq(4))
      .mockImplementationOnce(() => latestSeq(5));
    mockEventSave
      .mockRejectedValueOnce({ code: 11000, keyPattern: { seq: 1 } })
      .mockResolvedValueOnce(undefined);
    await db.recordAnalyticsEvent('ticket.closed', 7);
    expect(capturedEvents.map((event) => event.seq)).toEqual([5, 6]);
  });

  it('propagates event write failure', async () => {
    mockEventFindOne.mockImplementation(() => latestSeq(4));
    mockEventSave.mockRejectedValueOnce(new Error('mongo write failed'));
    await expect(db.recordAnalyticsEvent('ticket.closed', 7)).rejects.toThrow('mongo write failed');
  });

  it('stops replay at the first sequence hole', async () => {
    const q: any = {};
    q.sort = jest.fn(() => q);
    q.limit = jest.fn(() => q);
    q.lean = jest.fn().mockResolvedValue([{ seq: 11 }, { seq: 13 }, { seq: 14 }]);
    mockEventFind.mockReturnValue(q);
    const result = await db.getEventsSince(10, 25);
    expect(result).toEqual([{ seq: 11 }]);
  });
});
