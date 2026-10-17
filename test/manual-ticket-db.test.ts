jest.unmock('../src/db');

// Promise that also supports the mongoose query chain helpers used by db.ts.
const q = (value: unknown): any => { const p: any = Promise.resolve(value); p.sort = () => p; p.select = () => p; p.lean = () => p; p.limit = () => p; return p; };
const byKey = new Map<string, any>();
let seq = 100;
const mockSupportee: any = {
  findOne: jest.fn((query: any) => q(query?.manual_request_key ? byKey.get(query.manual_request_key) ?? null : null)),
  find: jest.fn(() => q([])),
  create: jest.fn(async (doc: any) => { byKey.set(doc.manual_request_key, doc); return doc; }),
  findOneAndUpdate: jest.fn(), updateMany: jest.fn(), updateOne: jest.fn(),
};
const mockMessages: any = { exists: jest.fn(() => q(null)), create: jest.fn(async (d: any) => d), find: jest.fn(), collection: { name: 'ticketmessages' } };
const mockEvents: any[] = [];
const mockEventModel: any = jest.fn(function (this: any, data: any) { Object.assign(this, data); mockEvents.push(data); this.save = jest.fn().mockResolvedValue(undefined); });
mockEventModel.findOne = jest.fn(() => q(null));
mockEventModel.exists = jest.fn(() => q(null));
mockEventModel.collection = { name: 'analyticsevents' };
const mockDrafts: any = { findOneAndUpdate: jest.fn(() => q(null)), updateMany: jest.fn(() => q(null)), create: jest.fn(async (d: any) => d) };

jest.mock('mongoose', () => {
  const Schema: any = jest.fn().mockImplementation(() => ({ index: jest.fn() }));
  Schema.Types = { Mixed: {}, ObjectId: {} };
  const module = {
    connect: jest.fn(), connection: { on: jest.fn() }, Schema,
    model: jest.fn((name: string) => {
      if (name === 'TicketMessage') return mockMessages;
      if (name === 'AnalyticsEvent') return mockEventModel;
      if (name === 'TicketCounter') return {
        findOneAndUpdate: jest.fn(async (_filter: unknown, update: any) => ({ seq: update.$inc ? ++seq : seq })),
        findOne: jest.fn(() => q(null)),
      };
      if (name === 'UserBan') return { findOne: jest.fn(() => q(null)) };
      if (name === 'ManualIntakeDraft') return mockDrafts;
      return mockSupportee;
    }),
  };
  return { __esModule: true, default: module, ...module };
});
jest.mock('../src/cache', () => ({ config: { owner_id: 'o' }, recoveryBaseline: 0 }));

import * as db from '../src/db';

const input = { source: 'phone' as const, client: 'ООО Ромашка', contact: '+7 900', description: 'Не работает', createdBy: '42' };

describe('manual ticket persistence', () => {
  beforeEach(() => { jest.clearAllMocks(); byKey.clear(); mockEvents.length = 0; seq = 100; });

  it('creates one normal Supportee ticket with a unique non-Telegram userid, description history and creation audit', async () => {
    const { ticket, created } = await db.createManualTicket('tok1', input);
    await db.drainAnalyticsEvents();
    expect(created).toBe(true);
    expect(mockSupportee.create).toHaveBeenCalledTimes(1);
    expect(ticket).toEqual(expect.objectContaining({ ticketId: 101, messenger: 'manual', status: 'open', manual_source: 'phone',
      external_client: 'ООО Ромашка', external_contact: '+7 900', created_by: '42', manual_request_key: 'tok1' }));
    expect(ticket.userid).toMatch(/^MANUAL:[0-9a-f-]{36}$/);
    expect(mockMessages.create).toHaveBeenCalledWith({ ticketId: 101, sender: 'user', sender_id: ticket.userid,
      text: 'Не работает', delivery_key: 'manual:tok1:description' });
    expect(mockEvents).toEqual([expect.objectContaining({ type: 'ticket.created', ticketId: 101, agent_id: '42',
      metadata: { source: 'manual', manual_source: 'phone' } })]);
    expect(JSON.stringify(mockEvents)).not.toContain('Ромашка');
  });

  it('gives every request its own synthetic client id', async () => {
    const a = await db.createManualTicket('tokA', input);
    const b = await db.createManualTicket('tokB', input);
    expect(a.ticket.userid).not.toBe(b.ticket.userid);
    expect(a.ticket.ticketId).not.toBe(b.ticket.ticketId);
  });

  it('a duplicate confirm returns the existing ticket without a second ticket, message or event', async () => {
    await db.createManualTicket('tok1', input);
    await db.drainAnalyticsEvents();
    jest.clearAllMocks(); mockEvents.length = 0;
    mockMessages.exists.mockReturnValueOnce(q({ _id: 'm' }));
    mockEventModel.exists.mockReturnValueOnce(q({ _id: 'e' }));
    const again = await db.createManualTicket('tok1', input);
    expect(again.created).toBe(false);
    expect(mockSupportee.create).not.toHaveBeenCalled();
    expect(mockMessages.create).not.toHaveBeenCalled();
    expect(mockEvents).toHaveLength(0);
  });

  it('a retry after a crash completes the missing description and audit for the same ticket', async () => {
    byKey.set('tok1', { ticketId: 77, userid: 'MANUAL:x', manual_request_key: 'tok1' });
    const { ticket, created } = await db.createManualTicket('tok1', input);
    await db.drainAnalyticsEvents();
    expect(created).toBe(false); expect(ticket.ticketId).toBe(77);
    expect(mockSupportee.create).not.toHaveBeenCalled();
    expect(mockMessages.create).toHaveBeenCalledWith(expect.objectContaining({ ticketId: 77, delivery_key: 'manual:tok1:description' }));
    expect(mockEvents).toEqual([expect.objectContaining({ type: 'ticket.created', ticketId: 77 })]);
  });

  it('a concurrent confirm that loses the unique-key race returns the winner and records no audit of its own', async () => {
    mockSupportee.create.mockImplementationOnce(async () => {
      byKey.set('tok1', { ticketId: 55, userid: 'MANUAL:winner', manual_request_key: 'tok1' });
      throw Object.assign(new Error('dup'), { code: 11000 });
    });
    const { ticket, created } = await db.createManualTicket('tok1', input);
    await db.drainAnalyticsEvents();
    expect(created).toBe(false); expect(ticket.ticketId).toBe(55);
    expect(mockEvents).toHaveLength(0);
  });

  it('records manual work as staff history that is never marked delivered, once per update key', async () => {
    await expect(db.recordStaffWork(9, '42', 'перезвонил', 'telegram:1:ticket:9')).resolves.toBe(true);
    expect(mockMessages.create).toHaveBeenCalledWith({ ticketId: 9, sender: 'staff', sender_id: '42', text: 'перезвонил',
      delivery_key: 'telegram:1:ticket:9' });
    mockMessages.exists.mockReturnValueOnce(q({ _id: 'm' }));
    await expect(db.recordStaffWork(9, '42', 'перезвонил', 'telegram:1:ticket:9')).resolves.toBe(false);
    expect(mockMessages.create).toHaveBeenCalledTimes(1);
  });

  it('never includes manual tickets in broadcast recipients', async () => {
    mockSupportee.find.mockReturnValueOnce(q([
      { userid: '700', messenger: 'telegram' }, { userid: 'MANUAL:x', messenger: 'manual' }, { userid: 'MANUAL:y', messenger: 'telegram' },
    ]));
    await expect(db.getAllUsers()).resolves.toEqual([{ userid: '700', messenger: 'telegram' }]);
  });

  it('binds confirmation to actor and nonce, allowing only a crash-retry past expiry', async () => {
    await db.claimManualDraftConfirm('tok1', '42', 'n1');
    const [filter, update] = mockDrafts.findOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({ token: 'tok1', actor_id: '42', confirm_nonce: 'n1', $or: [
      { status: 'preview', expires_at: { $gt: expect.any(Date) } }, { status: 'creating' }] });
    expect(update).toEqual({ $set: { status: 'creating' } });
  });

  it('starting a new draft supersedes the actor\'s unfinished drafts only', async () => {
    await db.startManualDraft('tok2', '42', '-100', 7, new Date(Date.now() + 1000));
    expect(mockDrafts.updateMany).toHaveBeenCalledWith({ actor_id: '42', status: { $in: ['source', 'input', 'form', 'preview'] } },
      { $set: { status: 'cancelled' } });
    expect(mockDrafts.create).toHaveBeenCalledWith(expect.objectContaining({ token: 'tok2', actor_id: '42', status: 'source', thread_id: 7 }));
  });

  it('advances a wizard step only for the exact version and state', async () => {
    await db.transitionManualDraft('tok', '42', 3, { status: 'input', step: 'contact' },
      { status: 'preview', step: null }, new Date(Date.now() + 1000));
    const [filter, update] = mockDrafts.findOneAndUpdate.mock.calls.at(-1);
    expect(filter).toEqual(expect.objectContaining({ token: 'tok', actor_id: '42', version: 3,
      status: 'input', step: 'contact', expires_at: { $gt: expect.any(Date) } }));
    expect(update.$inc).toEqual({ version: 1 });
  });

  it('consumes one message with actor/chat/topic/step/version and message dedup predicates', async () => {
    await db.consumeManualDraftInput('tok', '42', '-100', 7, 2, 'description', 900, 'много\nстрок', 'contact',
      new Date(Date.now() + 1000));
    const [filter, update] = mockDrafts.findOneAndUpdate.mock.calls.at(-1);
    expect(filter).toEqual(expect.objectContaining({ token: 'tok', actor_id: '42', chat_id: '-100', thread_id: 7,
      status: 'input', step: 'description', version: 2,
      $or: [{ last_consumed_message_id: { $exists: false } }, { last_consumed_message_id: null }, { last_consumed_message_id: { $lt: 900 } }] }));
    expect(update.$set).toEqual(expect.objectContaining({ description: 'много\nстрок', step: 'contact',
      last_consumed_message_id: 900 }));
  });
});

it('fences cancellation with the expected draft version in the Mongo predicate', async () => {
  await (db.cancelManualDraft as any)('tok', '42', 7);
  expect(mockDrafts.findOneAndUpdate.mock.calls.at(-1)[0]).toEqual(expect.objectContaining({
    token: 'tok', actor_id: '42', version: 7,
  }));
});
it('writes the preview nonce atomically with final input and its incremented version', async () => {
  await db.consumeManualDraftInput('tok', '42', '-100', 7, 8, 'contact', 901, 'mail', null, new Date(Date.now() + 1000));
  const [, update] = mockDrafts.findOneAndUpdate.mock.calls.at(-1);
  expect(update.$set).toEqual(expect.objectContaining({ status: 'preview', step: null, contact: 'mail', confirm_nonce: '9' }));
  expect(update.$inc).toEqual({ version: 1 });
});
