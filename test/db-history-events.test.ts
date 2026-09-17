jest.unmock('../src/db');

const mockMessageSave = jest.fn().mockResolvedValue(undefined);
const mockEventSave = jest.fn().mockResolvedValue(undefined);
const mockCounterFindOneAndUpdate = jest.fn();
const mockCounterFindOne = jest.fn();
const mockMessageFind = jest.fn();
const mockEventFind = jest.fn();
const mockEventFindOne = jest.fn();
const mockEventUpdateOne = jest.fn().mockResolvedValue({ modifiedCount: 1 });
const mockEventBulkWrite = jest.fn().mockResolvedValue({ modifiedCount: 1 });
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
AnalyticsEventModel.bulkWrite = mockEventBulkWrite;

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
      if (name === 'TicketCounter') return { findOne: mockCounterFindOne, findOneAndUpdate: mockCounterFindOneAndUpdate };
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
    await new Promise((resolve) => setImmediate(resolve));
    expect(TicketMessageModel).toHaveBeenCalledWith({ ticketId: 7, sender: 'user', sender_id: '123', text: 'hello' });
    expect(mockMessageSave).toHaveBeenCalledTimes(1);
    expect(mockMessageFind).not.toHaveBeenCalled();
    expect(mockEventSave).toHaveBeenCalledTimes(1);
  });

  it('persists authoritative history without emitting the replay mirror', async () => {
    await db.persistTicketMessage(8, 'user', '123', 'durable first');
    expect(mockMessageSave).toHaveBeenCalledTimes(1);
    expect(mockEventSave).not.toHaveBeenCalled();
  });

  it('serializes best-effort and acknowledged appends in call order', async () => {
    let releaseFirst: (() => void) | undefined;
    mockEventSave
      .mockImplementationOnce(() => new Promise<void>((resolve) => { releaseFirst = resolve; }))
      .mockResolvedValueOnce(undefined);

    db.recordAnalyticsEventBestEffort('ticket.message.staff', 7, 'agent-1');
    const replied = db.recordAnalyticsEvent('ticket.replied', 7, 'agent-1');
    await new Promise((resolve) => setImmediate(resolve));

    expect(mockEventSave).toHaveBeenCalledTimes(1);
    expect(capturedEvents.map((event) => event.type)).toEqual(['ticket.message.staff']);

    releaseFirst?.();
    await replied;

    expect(mockEventSave).toHaveBeenCalledTimes(2);
    expect(capturedEvents.map((event) => event.type)).toEqual([
      'ticket.message.staff',
      'ticket.replied',
    ]);
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


  it('does not reject persisted history when the mirrored event append fails', async () => {
    mockEventSave.mockRejectedValueOnce(new Error('event unavailable'));
    await expect(db.addTicketMessage(7, 'user', '123', 'hello')).resolves.toBeUndefined();
    await new Promise((resolve) => setImmediate(resolve));
    expect(mockMessageSave).toHaveBeenCalledTimes(1);
  });

  it('backfills legacy ids, sequences, and event names in bounded batches', async () => {
    const markerQuery: any = {};
    markerQuery.select = jest.fn().mockResolvedValue(null);
    mockCounterFindOne.mockReturnValue(markerQuery);
    mockEventFindOne.mockImplementation(() => latestSeq(7));

    const firstBatch: any = {};
    firstBatch.sort = jest.fn(() => firstBatch);
    firstBatch.limit = jest.fn().mockResolvedValue([
      { _id: 'legacy-1', event_id: undefined, seq: undefined, type: 'ticket_created' },
    ]);
    const emptyBatch: any = {};
    emptyBatch.sort = jest.fn(() => emptyBatch);
    emptyBatch.limit = jest.fn().mockResolvedValue([]);
    mockEventFind.mockReturnValueOnce(firstBatch).mockReturnValueOnce(emptyBatch);

    const migrated = await db.backfillLegacyEvents();

    expect(migrated).toBe(1);
    expect(firstBatch.limit).toHaveBeenCalledWith(1000);
    expect(mockEventBulkWrite).toHaveBeenCalledWith([
      {
        updateOne: {
          filter: { _id: 'legacy-1' },
          update: {
            $set: expect.objectContaining({
              event_id: expect.stringMatching(/^[0-9a-f-]{36}$/i),
              seq: 8,
              type: 'ticket.created',
            }),
          },
        },
      },
    ], { ordered: true });
    expect(mockCounterFindOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ _id: expect.stringContaining('legacyEventBackfillV3') }),
      { $set: { seq: 1 } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
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
