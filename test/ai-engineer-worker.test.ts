const mockFind = jest.fn(), mockFindOne = jest.fn(), mockRepair = jest.fn(), mockClaim = jest.fn();
const mockPublish = jest.fn(), mockFail = jest.fn(), mockContinue = jest.fn(), mockIndexes = jest.fn();
const mockGenerate = jest.fn(), mockBinding = jest.fn(), mockCatalog = jest.fn();
const mockEpochFence = jest.fn();
let mockPolicy: any;
jest.mock('../src/db', () => ({ Supportee: { find: mockFind, findOne: mockFindOne, updateMany: mockEpochFence } }));
jest.mock('../src/ai-engineer-store', () => ({
  EngineerStore: jest.fn(() => ({ repair: mockRepair, claim: mockClaim, publishConclusion: mockPublish,
    failConclusion: mockFail, continueRevision: mockContinue })), initializeEngineerIndexes: mockIndexes,
}));
jest.mock('../src/ai-engineer-bridge', () => ({ engineerPolicy: () => mockPolicy }));
jest.mock('../src/ai-engineer-catalog', () => ({ requireCatalogBinding: mockBinding, readCatalog: mockCatalog }));
jest.mock('../src/addons/llm', () => ({ getEngineerConclusion: mockGenerate }));
import * as ai from '../src/ai-engineer';
import { EngineerWorker } from '../src/ai-engineer-worker';

describe('durable engineer worker', () => {
  const binding: ai.Binding = { binding_id: 'canary', binding_version: 1, display_label: 'Canary', profile_id: ai.PROFILE };
  let job: ai.EngineerTask;
  function chain(value: unknown) { const q: any = {}; q.sort = () => q; q.limit = () => q; q.lean = async () => value; return q; }
  beforeEach(() => {
    jest.clearAllMocks();
    mockPolicy = { enabled: true, scope: 'most-support-vm3902', staff: [{ telegram_id: '1', role: 'admin' }] };
    job = ai.createTask({ ticketId: 42, status: 'open', assigned_to: null }, mockPolicy, '1', binding, ai.snapshotInput('Проверить'), Date.now());
    job.state = 'summarizing'; job.projection_pending = null;
    mockFind.mockReturnValue(chain([])); mockFindOne.mockReturnValue(chain({ ticketId: 42, ai_engineer: job }));
    mockClaim.mockResolvedValue(job); mockPublish.mockResolvedValue(job); mockFail.mockResolvedValue(job);
    mockGenerate.mockResolvedValue({ summary: 'test' }); mockBinding.mockResolvedValue(undefined);
    mockCatalog.mockResolvedValue({ entries: [binding] }); mockRepair.mockResolvedValue(null);
    mockEpochFence.mockResolvedValue({ modifiedCount: 0 });
  });
  it('reserves one claim and publishes only after generation and binding recheck', async () => {
    await new EngineerWorker().tick();
    expect(mockClaim).toHaveBeenCalledWith(42, job.request_id, 'summarizer', expect.any(String));
    expect(mockGenerate).toHaveBeenCalledTimes(1); expect(mockBinding).toHaveBeenCalledTimes(2);
    expect(mockPublish).toHaveBeenCalledTimes(1);
  });
  it('repairs audit even while disabled, but never generates', async () => {
    mockPolicy.enabled = false; mockFind.mockReturnValue(chain([{ ticketId: 42, ai_engineer: job }]));
    await new EngineerWorker().tick();
    expect(mockRepair).toHaveBeenCalledWith(42); expect(mockGenerate).not.toHaveBeenCalled();
  });
  it('records a bounded failure after a model error without sending a client message', async () => {
    mockGenerate.mockRejectedValueOnce(new Error('private provider response'));
    await new EngineerWorker().tick();
    expect(mockFail).toHaveBeenCalledWith(42, job.request_id, expect.any(String), 'model_unavailable');
    expect(mockPublish).not.toHaveBeenCalled();
  });
  it('filters poisoned summary heads by active lifecycle, epoch, owner and current catalog', async () => {
    await new EngineerWorker().tick();
    const query = mockFindOne.mock.calls[0][0];
    expect(query.status).toEqual({ $in: ['open', 'waiting_user'] });
    expect(query['ai_engineer.policy_fingerprint']).toBe(ai.policyFingerprint(mockPolicy));
    expect(JSON.stringify(query.$and)).toMatch(/ticket_epoch/);
    expect(JSON.stringify(query.$and)).toMatch(/expected_owner/);
    expect(JSON.stringify(query.$and)).toMatch(/binding_version/);
  });
  it('does not publish after shutdown starts and drains the tracked request', async () => {
    let resolve: (v: any) => void = () => undefined;
    mockGenerate.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    const worker = new EngineerWorker(); worker.schedule();
    for (let n = 0; n < 10 && !mockGenerate.mock.calls.length; n++) await new Promise(r => setImmediate(r));
    const stopped = worker.stop(); resolve({ summary: 'late' }); await stopped;
    expect(mockGenerate.mock.calls[0][1].aborted).toBe(true);
    expect(mockPublish).not.toHaveBeenCalled(); worker.schedule();
    expect(mockGenerate).toHaveBeenCalledTimes(1);
  });
  it('round-robins beyond ten waiting jobs so a later pending revision gets repaired', async () => {
    const rows = Array.from({ length: 11 }, (_, i) => ({ _id: i + 1, ticketId: i + 1,
      ai_engineer: { ...job, state: i < 10 ? 'queued' : 'summarizing' } }));
    mockFind.mockImplementation(filter => {
      // Deliberately include idle candidates as well: the cursor must still
      // prevent a permanently unrepairable head from starving later work.
      let selected = rows.filter(r => !filter._id || r._id > filter._id.$gt);
      const q: any = { sort: () => q, limit: (n: number) => { selected = selected.slice(0, n); return q; }, lean: async () => selected };
      return q;
    });
    mockFindOne.mockReturnValue(chain(null));
    const worker = new EngineerWorker(); await worker.tick(); await worker.tick();
    expect(mockRepair).toHaveBeenCalledWith(11);
    expect(mockFind.mock.calls[1][0]._id).toEqual({ $gt: 10 });
  });
  it('revokes every outstanding request before disabled startup can stop or be re-enabled', async () => {
    const originalPolicy = structuredClone(mockPolicy);
    const rows = Array.from({ length: 12 }, (_, i) => {
      const ticket = { _id: i + 1, ticketId: i + 1, status: 'open', assigned_to: null, ai_epoch: 0 };
      const task = ai.createTask(ticket, originalPolicy, '1', binding, ai.snapshotInput('Проверить'), Date.now());
      // Include a completed task with a durable rework intent as well: its
      // pending continuation must not restart under a later identical policy.
      if (i === 11) { task.state = 'failed'; task.continuation = { operation_id: 'op', request_id: 'next',
        revision: 2, actor_id: '1', input: task.input }; }
      return { ...ticket, ai_engineer: task };
    });
    mockPolicy.enabled = false;
    mockEpochFence.mockImplementation(async () => { rows.forEach(row => row.ai_epoch++); return { modifiedCount: 12 }; });
    mockFind.mockReturnValue(chain(rows.slice(0, 10)));
    const worker = new EngineerWorker(); await worker.initialize(); await worker.stop();
    expect(mockEpochFence).toHaveBeenCalledWith(expect.objectContaining({ $or: expect.any(Array) }), { $inc: { ai_epoch: 1 } });
    expect(mockRepair).toHaveBeenCalledTimes(10);
    mockPolicy = originalPolicy;
    expect(rows.every(row => !ai.current(row.ai_engineer, row, mockPolicy))).toBe(true);
    expect(rows[11].ai_engineer.continuation).not.toBeNull(); // preserved for audit, revoked for execution
  });
});
