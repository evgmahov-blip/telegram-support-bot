jest.unmock('../src/db');
const q = (value: unknown): any => { const p: any = Promise.resolve(value); p.sort = () => p; p.select = () => p; p.lean = () => p; p.limit = () => p; return p; };
const resolution: any = { findOne: jest.fn(() => q(null)), findOneAndUpdate: jest.fn(() => q(null)), create: jest.fn(), updateOne: jest.fn() };
const intents: any = { findOne: jest.fn(() => q(null)), findOneAndUpdate: jest.fn(() => q(null)), updateOne: jest.fn(() => q(null)) };
const generic: any = { findOne: jest.fn(() => q(null)), find: jest.fn(() => q([])), findOneAndUpdate: jest.fn(), updateMany: jest.fn(), updateOne: jest.fn() };
jest.mock('mongoose', () => {
  const Schema: any = jest.fn(() => ({ index: jest.fn() })); Schema.Types = { Mixed: {}, ObjectId: {} };
  const module = { connect: jest.fn(), connection: { on: jest.fn() }, Schema, model: jest.fn((name: string) =>
    name === 'TicketResolution' ? resolution : name === 'ResolutionIntent' ? intents : generic) };
  return { __esModule: true, default: module, ...module };
});
jest.mock('../src/cache', () => ({ config: { owner_id: 'test' }, recoveryBaseline: 0 }));
import * as db from '../src/db';

describe('resolution persistence CAS and replay protection', () => {
  const intent: any = { token: 'once', ticketId: 8, actor_id: '42', base_version: 2,
    cause: 'c', actions: 'a', check: 'v' };
  beforeEach(() => { jest.clearAllMocks(); resolution.findOne.mockReturnValue(q(null)); resolution.findOneAndUpdate.mockReturnValue(q(null)); });

  it('claims preview by actor/chat/topic/version and expiry', async () => {
    await db.claimResolutionSave('once', '42', '-100', 9, 4);
    expect(intents.findOneAndUpdate.mock.calls[0][0]).toEqual(expect.objectContaining({ token: 'once', actor_id: '42',
      chat_id: '-100', thread_id: 9, version: 4, status: { $in: ['preview','saving'] }, expires_at: { $gt: expect.any(Date) } }));
  });

  it('appends an immutable next version only from the expected base version', async () => {
    resolution.findOneAndUpdate.mockReturnValueOnce(q({ ticketId: 8, current_version: 3, versions: [] }));
    await db.saveClaimedResolution(intent);
    const [filter, update] = resolution.findOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({ ticketId: 8, current_version: 2, 'versions.intent_token': { $ne: 'once' } });
    expect(update.$push.versions).toEqual(expect.objectContaining({ version: 3, author_id: '42', intent_token: 'once' }));
    expect(intents.updateOne).toHaveBeenCalledWith({ token: 'once', status: 'saving' }, { $set: { status: 'saved' } });
  });

  it('returns the already-written version on callback replay without another append', async () => {
    const existing = { ticketId: 8, current_version: 3, versions: [{ intent_token: 'once' }] };
    resolution.findOne.mockReturnValueOnce(q(existing));
    await expect(db.saveClaimedResolution(intent)).resolves.toBe(existing);
    expect(resolution.findOneAndUpdate).not.toHaveBeenCalled(); expect(resolution.create).not.toHaveBeenCalled();
  });

  it('fails closed on an edit race instead of overwriting newer history', async () => {
    resolution.findOne.mockReturnValue(q(null)); resolution.findOneAndUpdate.mockReturnValue(q(null));
    await expect(db.saveClaimedResolution(intent)).resolves.toBeNull();
    expect(intents.updateOne).not.toHaveBeenCalled();
  });
});
