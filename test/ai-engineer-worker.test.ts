const mockFind = jest.fn(), mockRepair = jest.fn(), mockContinue = jest.fn(), mockIndexes = jest.fn();
const mockEpochFence = jest.fn();
const mockRefresh = jest.fn();
let mockPolicy: any;
jest.mock('../src/db', () => ({ Supportee: { find: mockFind, updateMany: mockEpochFence } }));
jest.mock('../src/ai-engineer-store', () => ({
  EngineerStore: jest.fn(() => ({ repair: mockRepair, continueRevision: mockContinue })), initializeEngineerIndexes: mockIndexes,
}));
jest.mock('../src/ai-engineer-bridge', () => ({ engineerPolicy: () => mockPolicy }));
jest.mock('../src/ticket-ui', () => ({ refreshStaffCard: mockRefresh }));
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
    mockFind.mockReturnValue(chain([])); mockRepair.mockResolvedValue(null);
    mockEpochFence.mockResolvedValue({ modifiedCount: 0 });
  });
  it('does not claim or invoke a local model for summarization', async () => {
    await new EngineerWorker().tick();
    expect(mockFind).toHaveBeenCalledTimes(1);
    expect(mockRepair).not.toHaveBeenCalled();
  });
  it('repairs audit even while disabled, but never generates', async () => {
    mockPolicy.enabled = false; mockFind.mockReturnValue(chain([{ ticketId: 42, ai_engineer: job }]));
    await new EngineerWorker().tick();
    expect(mockRepair).toHaveBeenCalledWith(42);
  });
  it('refreshes the staff card after durable repair only', async () => {
    mockFind.mockReturnValue(chain([{ _id: 1, ticketId: 42, ai_engineer: job }])); mockRepair.mockResolvedValue(job);
    await new EngineerWorker().tick();
    expect(mockRefresh).toHaveBeenCalledWith(42);
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
  it('a canary startup revokes every ordinary outstanding job; switching back does not revive them', async () => {
    const standard = structuredClone(mockPolicy), now = Date.now();
    const rows = Array.from({ length: 3 }, (_, i) => {
      const ticket = { _id: i + 1, ticketId: i + 1, status: 'open', assigned_to: null, ai_epoch: 0 };
      return { ...ticket, ai_engineer: ai.createTask(ticket, standard, '1', binding, ai.snapshotInput('Ordinary'), now) };
    });
    mockPolicy = { ...standard, canary: ai.parseCanaryPolicy('canary', { schema: ai.CANARY_SCHEMA,
      deployment_scope: standard.scope, ticket_id: 4242, request_id: '40000000-0000-4000-8000-000000000004', revision: 1,
      expected_owner: null, ticket_epoch: 0, requested_by: '1', binding_id: 'canary', binding_version: 1,
      profile_id: ai.PROFILE, base_policy_digest: ai.basePolicyDigest(standard), issued_at: now - 1000,
      expires_at: now + 60_000 }, standard) };
    expect(mockPolicy.canary.error).toBeNull();
    mockEpochFence.mockImplementation(async (filter: any) => {
      rows.filter(r => r.ai_engineer.policy_fingerprint !== filter['ai_engineer.policy_fingerprint'].$ne)
        .forEach(r => r.ai_epoch++);
      return { modifiedCount: 3 };
    });
    const worker = new EngineerWorker(); await worker.initialize(); await worker.stop();
    expect(mockEpochFence.mock.calls[0][0]['ai_engineer.policy_fingerprint']).toEqual({ $ne: ai.policyFingerprint(mockPolicy) });
    expect(rows.every(r => r.ai_epoch === 1 && !ai.current(r.ai_engineer, r, mockPolicy))).toBe(true);
    expect(rows.every(r => !ai.current(r.ai_engineer, r, standard))).toBe(true);
  });
});
