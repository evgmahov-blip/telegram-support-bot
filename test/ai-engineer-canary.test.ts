const mockFindOne = jest.fn(), mockFindOneAndUpdate = jest.fn(), mockReadCatalog = jest.fn();
jest.mock('../src/db', () => ({ Supportee: { findOne: mockFindOne, findOneAndUpdate: mockFindOneAndUpdate } }));
jest.mock('../src/ai-engineer-catalog', () => ({ readCatalog: mockReadCatalog, publishCatalog: jest.fn(),
  requireCatalogBinding: jest.fn() }));
import { createHash, randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import cache from '../src/cache';
import * as ai from '../src/ai-engineer';
import { EngineerStore, EngineerPersistence, EngineerTicket, mongoEngineerPersistence } from '../src/ai-engineer-store';
import { executeBridge, BridgeDependencies, bridgeDependencies, canarySelection, engineerPolicy,
  summarizerProjection, publicEnvelope } from '../src/ai-engineer-bridge';

// Mock/fixture tests only: no Mongo, Telegram, AINOC controller or model is reached. Not a live E2E.
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const fixture = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'support-engineer-canary-admission-v1.json'), 'utf8'));
const issued = 1_700_000_000_000, expires = issued + ai.CANARY_MAX_MS;
const binding: ai.Binding = { binding_id: 'canary', binding_version: 1, display_label: 'Canary', profile_id: ai.PROFILE };
const otherBinding: ai.Binding = { ...binding, binding_version: 2 };
const base: ai.EngineerPolicy = { enabled: true, scope: 'most-support-vm3902',
  staff: [{ telegram_id: '1', role: 'admin' }, { telegram_id: '2', role: 'agent' }, { telegram_id: '3', role: 'agent' }] };
const REQUEST = '40000000-0000-4000-8000-000000000004';
function admission(patch: Partial<ai.CanaryAdmission> = {}, policy = base): ai.CanaryAdmission {
  return { schema: ai.CANARY_SCHEMA, deployment_scope: policy.scope, ticket_id: 4242, request_id: REQUEST, revision: 1,
    expected_owner: '2', ticket_epoch: 3, requested_by: '2', binding_id: 'canary', binding_version: 1,
    profile_id: ai.PROFILE, base_policy_digest: ai.basePolicyDigest(policy), issued_at: issued, expires_at: expires, ...patch };
}
const canary = (raw: unknown = admission(), policy = base): ai.EngineerPolicy =>
  ({ ...policy, canary: ai.parseCanaryPolicy('canary', raw, policy) });
const checks = (at: number): ai.CheckResult => ({ status: 'completed', execution_allowed: false, completed_at: at,
  facts: [{ ref: 'check-1', check_id: ai.PROFILE, observed_at: at, values: { reachable: true, uptime_seconds: 5 } }], unknowns: [] });
const conclusion: ai.Conclusion = { summary: 'Host reachable', verified_findings: [{ text: 'Reachable', evidence_refs: ['check-1'] }],
  hypotheses: [], unknowns: ['App not inspected'], recommended_next_steps: ['Continue manually'], customer_reply_draft: 'Checking.' };

describe('canary admission contract', () => {
  it('keeps standard mode and its fingerprint unchanged', () => {
    expect(ai.parseCanaryPolicy(undefined, undefined, base)).toBeNull();
    expect(ai.parseCanaryPolicy('standard', null, base)).toBeNull();
    expect(ai.policyFingerprint(base)).toBe(ai.basePolicyDigest(base));
    expect(ai.canaryWindow(base, 0)).toBeNull();
  });
  it('matches the language-neutral canonicalization vectors', () => {
    const policy = fixture.base_policy as ai.EngineerPolicy;
    expect(ai.canonical({ enabled: true, scope: policy.scope, staff: policy.staff, profiles: [ai.PROFILE],
      generation_backend: ai.GENERATION_BACKEND, conclusion_protocol: ai.CONCLUSION_PROTOCOL })).toBe(fixture.base_policy_canonical);
    expect(sha(fixture.base_policy_canonical)).toBe(fixture.base_policy_digest);
    expect(ai.basePolicyDigest(policy)).toBe(fixture.base_policy_digest);
    const raw = fixture.config.ai_engineer_canary_admission;
    const parsed = ai.parseCanaryPolicy(fixture.config.ai_engineer_mode, raw, policy);
    expect(parsed).toEqual({ admission: raw, error: null });
    expect(ai.canonical(raw)).toBe(fixture.admission_canonical);
    const admissionFp = sha(fixture.admission_canonical);
    expect(ai.admissionFingerprint(parsed.admission)).toBe(admissionFp);
    expect(ai.policyFingerprint({ ...policy, canary: parsed }))
      .toBe(sha(fixture.canary_policy_canonical_template.replace('<admission_fingerprint>', admissionFp)));
    for (const v of fixture.fail_closed_vectors) {
      const input = v.admission === null ? null : v.error === 'canary_ttl_invalid' ? { ...raw, expires_at: 1700003600001 } : raw;
      const result = ai.parseCanaryPolicy(v.mode, input, policy);
      expect(result).toEqual({ admission: null, error: v.error });
      expect(ai.policyFingerprint({ ...policy, canary: result })).toBe(sha(v.policy_canonical));
    }
    expect(fixture.window).toEqual({ not_started_before: raw.issued_at, open_from_inclusive: raw.issued_at,
      closed_from_inclusive: raw.expires_at });
  });
  it.each([
    ['mode typo', 'Canary', admission(), 'canary_mode_invalid'],
    ['standard with stray admission', 'standard', admission(), 'canary_mode_required'],
    ['missing', 'canary', undefined, 'canary_admission_missing'],
    ['null', 'canary', null, 'canary_admission_missing'],
    ['extra field', 'canary', { ...admission(), synthetic: true }, 'canary_admission_invalid'],
    ['missing field', 'canary', (({ ticket_epoch, ...rest }) => rest)(admission()), 'canary_admission_invalid'],
    ['oversize', 'canary', { ...admission(), padding: 'x'.repeat(ai.CANARY_MAX_BYTES) }, 'canary_admission_oversize'],
    ['bad uuid', 'canary', admission({ request_id: 'canary-1' }), 'canary_admission_invalid'],
    ['zero revision', 'canary', admission({ revision: 0 }), 'canary_admission_invalid'],
    ['numeric owner', 'canary', admission({ expected_owner: 2 as any }), 'canary_admission_invalid'],
    ['string ticket', 'canary', admission({ ticket_id: '4242' as any }), 'canary_admission_invalid'],
    ['wrong schema', 'canary', admission({ schema: 'v0' as any }), 'canary_admission_invalid'],
    ['foreign scope', 'canary', admission({ deployment_scope: 'other' }), 'scope_denied'],
    ['foreign profile', 'canary', admission({ profile_id: 'shell' as any }), 'profile_denied'],
    ['other base policy', 'canary', admission({ base_policy_digest: '0'.repeat(64) }), 'canary_policy_mismatch'],
    ['non-staff actor', 'canary', admission({ requested_by: '9' }), 'canary_actor_unknown'],
    ['empty window', 'canary', admission({ expires_at: issued }), 'canary_ttl_invalid'],
    ['window over 1h', 'canary', admission({ expires_at: issued + ai.CANARY_MAX_MS + 1 }), 'canary_ttl_invalid'],
  ])('fails closed on %s', (_name, mode, raw, code) => {
    const result = ai.parseCanaryPolicy(mode, raw, base);
    expect(result).toEqual({ admission: null, error: code });
    const policy = { ...base, canary: result };
    expect(() => ai.canaryWindow(policy, issued + 1)).toThrow(code);
    expect(ai.policyFingerprint(policy)).not.toBe(ai.basePolicyDigest(base));
  });
  it('fails closed when disabled base policy is used or a staff role changes', () => {
    expect(ai.parseCanaryPolicy('canary', admission(), { ...base, enabled: false }).error).toBe('canary_policy_mismatch');
    const changed = { ...base, staff: base.staff.map(s => s.telegram_id === '2' ? { ...s, role: 'supervisor' as const } : s) };
    expect(ai.parseCanaryPolicy('canary', admission(), changed).error).toBe('canary_policy_mismatch');
  });
  it('enforces the absolute [issued_at, expires_at) window', () => {
    const policy = canary();
    expect(() => ai.canaryWindow(policy, issued - 1)).toThrow('canary_not_started');
    expect(ai.canaryWindow(policy, issued)).toEqual(admission());
    expect(ai.canaryWindow(policy, expires - 1)).toEqual(admission());
    expect(() => ai.canaryWindow(policy, expires)).toThrow('canary_expired');
  });
  it('excludes the clock from the fingerprint so expiry never blocks human control', () => {
    expect(ai.policyFingerprint(canary())).toBe(ai.policyFingerprint(canary()));
    expect(ai.policyFingerprint(canary())).not.toBe(ai.policyFingerprint(canary(admission({ request_id: randomUUID() }))));
  });
  it('reads the config contract with the default disabled standard mode', () => {
    const config = cache.config as any, saved = { ...config };
    try {
      Object.assign(config, { ai_engineer_enabled: undefined, ai_engineer_mode: undefined, ai_engineer_canary_admission: undefined,
        staff_roles: [{ telegram_id: 1, role: 'admin' }] });
      expect(engineerPolicy()).toEqual({ enabled: false, scope: 'most-support-vm3902', staff: [{ telegram_id: '1', role: 'admin' }] });
      Object.assign(config, fixture.config);
      expect(engineerPolicy().canary).toEqual({ admission: fixture.config.ai_engineer_canary_admission, error: null });
      config.ai_engineer_mode = 'standard';
      expect(engineerPolicy().canary).toEqual({ admission: null, error: 'canary_mode_required' });
    } finally {
      for (const key of Object.keys(config)) delete config[key];
      Object.assign(config, saved);
    }
  });
});

/** Single-document CAS double that also records which writes carried the canary fence. */
class MemoryPersistence implements EngineerPersistence {
  value: EngineerTicket = { ticketId: 4242, assigned_to: '2', status: 'open', ai_epoch: 3, ai_engineer: null };
  fences: Array<{ type: string; admission: ai.CanaryAdmission | null }> = [];
  events = new Map<string, string>(); archives = new Map<string, string>(); writes = 0;
  async read() { return structuredClone(this.value); }
  async compareAndSet(before: EngineerTicket, previous: ai.EngineerTask | null, next: ai.EngineerTask,
    _fence?: unknown, canaryAdmission?: ai.CanaryAdmission | null) {
    this.fences.push({ type: next.state, admission: canaryAdmission ?? null });
    if (before.ai_epoch !== this.value.ai_epoch || before.status !== this.value.status
      || before.assigned_to !== this.value.assigned_to || (previous?.request_id ?? null) !== (this.value.ai_engineer?.request_id ?? null)
      || (previous?.version ?? null) !== (this.value.ai_engineer?.version ?? null)) return null;
    // Live-document re-assertion, as the Mongo filter does.
    if (canaryAdmission && (this.value.ticketId !== canaryAdmission.ticket_id || this.value.assigned_to !== canaryAdmission.expected_owner
      || this.value.ai_epoch !== canaryAdmission.ticket_epoch)) return null;
    this.writes++; this.value.ai_engineer = structuredClone(next);
    return this.read();
  }
  async archive(snapshot: Record<string, unknown>) { this.archives.set(`${snapshot.task_id}:${snapshot.revision}`, ai.digest(snapshot)); }
  async emit(_id: number, p: ai.Projection) { this.events.set(p.event_id, p.type); }
}

describe('canary Store admission and CAS', () => {
  let memory: MemoryPersistence, store: EngineerStore, clock: number, policy: ai.EngineerPolicy;
  const ids = (request = REQUEST) => ({ task_id: '50000000-0000-4000-8000-000000000005', request_id: request });
  beforeEach(() => {
    memory = new MemoryPersistence(); clock = issued + 1000; policy = canary();
    store = new EngineerStore(() => policy, memory, () => clock);
  });
  const submit = (actor = '2', b = binding, i = ids()) => store.submit(4242, actor, b, ai.snapshotInput('Synthetic canary check'), i);
  async function concluded() {
    await submit(); await store.repair(4242);
    const collector = randomUUID(), summarizer = randomUUID();
    await store.claim(4242, REQUEST, 'collector', collector);
    await store.publishChecks(4242, REQUEST, collector, checks(clock)); await store.repair(4242);
    await store.claimSummarizer(4242, REQUEST, summarizer, ai.digest({ REQUEST }));
    await store.renewSummarizer(4242, REQUEST, summarizer, ai.digest({ REQUEST }));
    const job = await store.publishConclusion(4242, REQUEST, summarizer, conclusion); await store.repair(4242);
    return { job, summarizer };
  }
  it('admits only through caller-provided exact identity and caps task TTL by the admission', async () => {
    await expect(store.submit(4242, '2', binding, ai.snapshotInput('x'))).rejects.toThrow('canary_identity_required');
    clock = expires - 60_000;
    const job = await submit();
    expect(job.request_id).toBe(REQUEST); expect(job.expires_at).toBe(expires);
    expect(job.policy_fingerprint).toBe(ai.policyFingerprint(policy)); expect(job.execution_allowed).toBe(false);
    expect(memory.fences[0].admission).toEqual(admission());
  });
  it.each([
    ['ticket', () => { memory.value.ticketId = 43; }],
    ['request', () => undefined, ids(randomUUID())],
    ['owner', () => { memory.value.assigned_to = '3'; }, ids(), '3'],
    ['epoch', () => { memory.value.ai_epoch = 4; }],
    ['requester', () => undefined, ids(), '1'],
    ['binding', () => undefined, ids(), '2', otherBinding],
    ['policy', () => { policy = canary(admission({ base_policy_digest: '0'.repeat(64) })); }, ids(), '2', binding, 'canary_policy_mismatch'],
  ] as Array<[string, () => void, ReturnType<typeof ids>?, string?, ai.Binding?, string?]>)
  ('rejects wrong %s before any write', async (_name, mutate, identity = ids(), actor = '2', b = binding, code = 'canary_not_admitted') => {
    mutate();
    await expect(store.submit(memory.value.ticketId, actor, b, ai.snapshotInput('x'), identity)).rejects.toThrow(code);
    expect(memory.writes).toBe(0); expect(memory.archives.size).toBe(0);
  });
  it('rejects the wrong revision: a later revision needs its own admission', async () => {
    await concluded(); await store.handoff(4242, REQUEST, '2'); await store.repair(4242);
    await expect(submit('2', binding, ids(randomUUID()))).rejects.toThrow('canary_not_admitted');
    await expect(store.rework(4242, REQUEST, '2', randomUUID(), 'Again')).rejects.toThrow('canary_rework_denied');
    const writes = memory.writes;
    policy = canary(admission({ revision: 2, request_id: '60000000-0000-4000-8000-000000000006' }));
    // Old admission no longer current; the new one admits exactly revision 2 with its own UUID.
    const next = await submit('2', binding, ids('60000000-0000-4000-8000-000000000006'));
    expect(next.revision).toBe(2); expect(memory.writes).toBe(writes + 1);
  });
  it('runs both stages with canary-fenced writes and keeps the strict conclusion shape', async () => {
    const { job } = await concluded();
    expect(job.state).toBe('awaiting_operator'); expect(job.execution_allowed).toBe(false);
    expect(Object.keys(job.conclusion!).sort()).toEqual(Object.keys(conclusion).sort());
    expect(job.checks!.facts[0]).toEqual(checks(clock).facts[0]);
    const computational = memory.fences.filter(f => f.admission);
    expect(computational.map(f => f.type)).toEqual(['queued', 'collecting', 'summarizing', 'summarizing', 'summarizing', 'awaiting_operator']);
    // Outbox acknowledgements (repair) never carry the canary fence.
    expect(memory.fences.filter(f => !f.admission).length).toBeGreaterThan(0);
  });
  it('denies claim/heartbeat/publish at and after expiry, including after a late restart', async () => {
    await submit(); await store.repair(4242);
    const collector = randomUUID(); await store.claim(4242, REQUEST, 'collector', collector);
    expect(memory.value.ai_engineer!.collector!.until).toBeLessThanOrEqual(expires);
    clock = expires;
    await expect(store.publishChecks(4242, REQUEST, collector, checks(clock))).rejects.toThrow('canary_expired');
    const restarted = new EngineerStore(() => canary(), memory, () => expires + 10 * 60_000);
    await expect(restarted.claim(4242, REQUEST, 'collector', randomUUID())).rejects.toThrow('canary_expired');
    await restarted.repair(4242);
    expect(memory.value.ai_engineer!.state).toBe('failed'); expect(memory.value.ai_engineer!.failure_code).toBe('request_expired');
  });
  it('denies a heartbeat after expiry without renewing the lease', async () => {
    const collector = randomUUID(), summarizer = randomUUID();
    clock = expires - 30_000;
    await submit(); await store.repair(4242);
    expect(memory.value.ai_engineer!.expires_at).toBe(expires);
    await store.claim(4242, REQUEST, 'collector', collector);
    await store.publishChecks(4242, REQUEST, collector, checks(clock)); await store.repair(4242);
    await store.claimSummarizer(4242, REQUEST, summarizer, ai.digest({ REQUEST }));
    expect(memory.value.ai_engineer!.summarizer!.until).toBe(expires);
    const writes = memory.writes; clock = expires;
    await expect(store.renewSummarizer(4242, REQUEST, summarizer, ai.digest({ REQUEST }))).rejects.toThrow();
    await expect(store.publishConclusion(4242, REQUEST, summarizer, conclusion)).rejects.toThrow();
    expect(memory.writes).toBe(writes);
  });
  it('recognizes an accepted exact receipt after expiry as read-only', async () => {
    const { summarizer } = await concluded();
    const writes = memory.writes, events = memory.events.size; clock = expires + 1;
    expect((await store.publishConclusion(4242, REQUEST, summarizer, conclusion)).state).toBe('awaiting_operator');
    await expect(store.publishConclusion(4242, REQUEST, summarizer, { ...conclusion, summary: 'other' })).rejects.toThrow('result_conflict');
    expect(memory.writes).toBe(writes); expect(memory.events.size).toBe(events);
  });
  it.each(['2', '1'])('lets owner/admin %s hand off after expiry; a foreign agent cannot', async actor => {
    await concluded(); clock = expires + 1;
    await expect(store.handoff(4242, REQUEST, '3')).rejects.toThrow('not_authorized');
    expect((await store.handoff(4242, REQUEST, actor)).state).toBe('handed_off');
    expect(memory.fences.at(-1)!.admission).toBeNull();
  });
  it('lets an authorized human cancel in-flight work after expiry', async () => {
    await submit(); await store.repair(4242); await store.claim(4242, REQUEST, 'collector', randomUUID());
    clock = expires + 1;
    expect((await store.cancel(4242, REQUEST, '1')).state).toBe('cancelled');
    expect(memory.value.ai_engineer!.collector).toBeNull();
  });
  it('after ownership transfer the old task becomes stale and the new owner is not trapped', async () => {
    await submit(); await store.repair(4242);
    memory.value.assigned_to = '3'; memory.value.ai_epoch = 4;
    await expect(store.cancel(4242, REQUEST, '3')).rejects.toThrow('authority_changed');
    await store.repair(4242); await store.repair(4242);
    expect(memory.value.ai_engineer!.state).toBe('stale');
    expect(memory.value.status).toBe('open'); expect(memory.value.assigned_to).toBe('3');
    // Ticket close/transfer/ban stay ordinary ticket operations; only a new admission admits new AI work.
    await expect(submit('3')).rejects.toThrow('canary_not_admitted');
  });
  it.each(['role', 'admission', 'standard', 'disabled'])('fences in-flight work on %s change', async change => {
    await submit(); await store.repair(4242);
    const collector = randomUUID(); await store.claim(4242, REQUEST, 'collector', collector);
    if (change === 'role') policy = canary(admission(), { ...base, staff: base.staff.filter(s => s.telegram_id !== '3') });
    if (change === 'admission') policy = canary(admission({ expires_at: expires - 1 }));
    if (change === 'standard') policy = base;
    if (change === 'disabled') policy = { ...canary(), enabled: false };
    await expect(store.publishChecks(4242, REQUEST, collector, checks(clock))).rejects.toThrow('authority_changed');
    await store.repair(4242); await store.repair(4242);
    expect(memory.value.ai_engineer!.state).toBe('stale');
  });
  it('never claims, heartbeats or publishes an ordinary pending job, and it cannot revive', async () => {
    memory.value = { ticketId: 43, assigned_to: '2', status: 'open', ai_epoch: 0, ai_engineer: null };
    const standard = new EngineerStore(() => base, memory, () => clock);
    const job = await standard.submit(43, '2', binding, ai.snapshotInput('Ordinary customer ticket'));
    await standard.repair(43);
    const collector = randomUUID(); await standard.claim(43, job.request_id, 'collector', collector);
    await expect(store.claim(43, job.request_id, 'collector', randomUUID())).rejects.toThrow('authority_changed');
    await expect(store.publishChecks(43, job.request_id, collector, checks(clock))).rejects.toThrow('authority_changed');
    await expect(store.renewSummarizer(43, job.request_id, randomUUID(), ai.digest({}))).rejects.toThrow('authority_changed');
    await expect(store.submit(43, '2', binding, ai.snapshotInput('x'), ids())).rejects.toThrow();
    await store.repair(43); await store.repair(43);
    expect(memory.value.ai_engineer!.state).toBe('stale');
    // Switching back to standard mode does not resurrect it.
    await expect(standard.claim(43, job.request_id, 'collector', randomUUID())).rejects.toThrow('invalid_state');
    expect(memory.fences.filter(f => f.admission)).toHaveLength(0);
  });
  it('replays an identical confirmation without a second write', async () => {
    const first = await submit(); const writes = memory.writes;
    expect((await submit()).version).toBe(first.version); expect(memory.writes).toBe(writes);
  });
});

describe('canary Mongo CAS filter', () => {
  beforeEach(() => mockFindOneAndUpdate.mockReset());
  const ticket: EngineerTicket = { ticketId: 4242, status: 'open', assigned_to: '2', ai_epoch: 3, ai_engineer: null };
  it('re-asserts admitted ticket, owner and epoch on the live document', async () => {
    const policy = canary();
    const next = ai.createTask(ticket, policy, '2', binding, ai.snapshotInput('x'), issued + 1,
      { task_id: randomUUID(), request_id: REQUEST });
    mockFindOneAndUpdate.mockReturnValue({ lean: async () => ({ ...ticket, ai_engineer: next }) });
    await mongoEngineerPersistence.compareAndSet(ticket, null, next, undefined, admission());
    expect(mockFindOneAndUpdate.mock.calls[0][0]).toEqual({ ticketId: 4242, status: 'open', assigned_to: '2', ai_engineer: null,
      $expr: { $and: [{ $eq: [{ $ifNull: ['$ai_epoch', 0] }, 3] }, { $eq: [{ $ifNull: ['$ai_epoch', 0] }, 3] }] } });
  });
  it('refuses a mismatched write without querying Mongo', async () => {
    const policy = canary();
    const next = ai.createTask(ticket, policy, '2', binding, ai.snapshotInput('x'), issued + 1,
      { task_id: randomUUID(), request_id: REQUEST });
    await expect(mongoEngineerPersistence.compareAndSet({ ...ticket, ai_epoch: 4 }, null, next, undefined, admission()))
      .rejects.toThrow('canary_not_admitted');
    await expect(mongoEngineerPersistence.compareAndSet(ticket, null, { ...next, request_id: randomUUID() }, undefined, admission()))
      .rejects.toThrow('canary_not_admitted');
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
  });
  it('leaves standard CAS filter unchanged', async () => {
    const next = ai.createTask(ticket, base, '2', binding, ai.snapshotInput('x'), issued);
    mockFindOneAndUpdate.mockReturnValue({ lean: async () => null });
    await mongoEngineerPersistence.compareAndSet(ticket, null, next);
    expect(mockFindOneAndUpdate.mock.calls[0][0]).toEqual({ ticketId: 4242, status: 'open', assigned_to: '2', ai_engineer: null,
      $expr: { $eq: [{ $ifNull: ['$ai_epoch', 0] }, 3] } });
  });
});

describe('canary bridge selection', () => {
  const config = cache.config as any;
  let saved: Record<string, unknown>;
  beforeEach(() => {
    saved = { ...config }; mockFindOne.mockReset(); mockReadCatalog.mockReset();
    Object.assign(config, { ai_engineer_enabled: true, ai_engineer_scope: base.scope, ai_engineer_mode: 'canary',
      staff_roles: base.staff, ai_engineer_canary_admission: admission() });
    mockReadCatalog.mockResolvedValue({ entries: [binding] });
    mockFindOne.mockReturnValue({ sort: () => ({ lean: async () => null }) });
  });
  afterEach(() => {
    jest.restoreAllMocks();
    for (const key of Object.keys(config)) delete config[key];
    Object.assign(config, saved);
  });
  const exactFilter = { ticketId: 4242, 'ai_engineer.request_id': { $eq: REQUEST, $nin: ['x'] }, 'ai_engineer.revision': 1,
    'ai_engineer.ticket_id': 4242, 'ai_engineer.requested_by': '2', 'ai_engineer.expected_owner': '2',
    'ai_engineer.ticket_epoch': 3, 'ai_engineer.binding.binding_id': 'canary', 'ai_engineer.binding.binding_version': 1,
    'ai_engineer.binding.profile_id': ai.PROFILE };
  it('builds no filter in standard mode, nothing outside the window, an exact filter inside it', () => {
    expect(canarySelection(base, issued, [])).toBeUndefined();
    expect(canarySelection(canary(), issued - 1, [])).toBeNull();
    expect(canarySelection(canary(), expires, [])).toBeNull();
    expect(canarySelection({ ...base, canary: { admission: null, error: 'canary_admission_missing' } }, issued, [])).toBeNull();
    expect(canarySelection(canary(), issued, ['x'])).toEqual(exactFilter);
  });
  it.each(['findQueued', 'findSummarizer'] as const)('%s narrows the DB query to the exact request', async name => {
    jest.spyOn(Date, 'now').mockReturnValue(issued + 1);
    await bridgeDependencies()[name](['x']);
    const query = mockFindOne.mock.calls[0][0];
    expect(query).toEqual(expect.objectContaining(exactFilter));
    expect(query['ai_engineer.policy_fingerprint']).toBe(ai.policyFingerprint(engineerPolicy()));
  });
  it.each(['findQueued', 'findSummarizer'] as const)('%s performs no read after expiry or with explicit canary missing admission', async name => {
    jest.spyOn(Date, 'now').mockReturnValue(expires);
    expect(await bridgeDependencies()[name]([])).toBeNull();
    jest.spyOn(Date, 'now').mockReturnValue(issued + 1); config.ai_engineer_canary_admission = null;
    expect(await bridgeDependencies()[name]([])).toBeNull();
    expect(mockFindOne).not.toHaveBeenCalled(); expect(mockReadCatalog).not.toHaveBeenCalled();
  });
});

describe('canary bridge operations', () => {
  let policy: ai.EngineerPolicy, clock: number, live: any, job: ai.EngineerTask, d: BridgeDependencies;
  const scope = { deployment_scope: base.scope };
  const claim = '10000000-0000-4000-8000-000000000001';
  beforeEach(() => {
    policy = canary(); clock = issued + 1000;
    job = ai.createTask({ ticketId: 4242, status: 'open', assigned_to: '2', ai_epoch: 3 }, policy, '2', binding,
      ai.snapshotInput('Synthetic goal token=hunter2-secret-value', 'PRIVATE_HISTORY'), clock,
      { task_id: randomUUID(), request_id: REQUEST });
    job = ai.acknowledge(job, job.projection_pending!.id);
    live = { ticketId: 4242, status: 'open', assigned_to: '2', ai_epoch: 3, ai_engineer: job };
    d = { policy: () => policy, clock: () => clock, findClaim: jest.fn(async () => null),
      findQueued: jest.fn(async () => live), findSummarizer: jest.fn(async () => live),
      bindingAllowed: jest.fn(async () => undefined), publishCatalog: jest.fn(), store: {
        read: jest.fn(async () => live), repair: jest.fn(async () => null),
        claim: jest.fn(async (_t, _r, _s, c) => { job = ai.claim(job, 'collector', c, clock); live.ai_engineer = job; return job; }),
        claimSummarizer: jest.fn(async (_t, _r, c, s) => { job = ai.claim(job, 'summarizer', c, clock, s); live.ai_engineer = job; return job; }),
        publishConclusion: jest.fn(async (_t, _r, c, r) => { job = ai.finishConclusion(job, c, r, clock); live.ai_engineer = job; return job; }),
      } as any };
  });
  it('claims the admitted request and projects no history or secret', async () => {
    const result: any = await executeBridge('claim-checks', { ...scope, claim_id: randomUUID() }, d);
    expect(result.task.request_id).toBe(REQUEST);
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_HISTORY|hunter2|Synthetic goal/);
    job.state = 'summarizing'; job.collector = null; job.checks = checks(clock); live.ai_engineer = job;
    const projection = summarizerProjection(job, clock);
    expect(projection.input.history).toBe(''); expect(JSON.stringify(projection)).not.toMatch(/hunter2|PRIVATE_HISTORY/);
    expect(publicEnvelope(job).execution_allowed).toBe(false);
  });
  it.each([
    ['expired', () => { clock = expires; }, 'canary_expired'],
    ['not started', () => { clock = issued - 1; }, 'canary_not_started'],
    ['missing admission', () => { policy = canary(null); }, 'canary_admission_missing'],
  ])('fails closed on fresh claims when %s', async (_name, mutate, code) => {
    mutate();
    await expect(executeBridge('claim-checks', { ...scope, claim_id: randomUUID() }, d)).rejects.toThrow(code);
    await expect(executeBridge('claim-summarizer', { ...scope, protocol: ai.CONCLUSION_PROTOCOL, claim_id: randomUUID() }, d))
      .rejects.toThrow(code);
    expect(d.findQueued).not.toHaveBeenCalled(); expect(d.findSummarizer).not.toHaveBeenCalled();
    expect(d.store.claim).not.toHaveBeenCalled();
  });
  it('repairs rather than claims a non-admitted head returned by selection', async () => {
    const created = ai.createTask({ ticketId: 43, status: 'open', assigned_to: '2', ai_epoch: 0 }, base, '2', binding,
      ai.snapshotInput('Ordinary'), clock);
    const other = ai.acknowledge(created, created.projection_pending!.id);
    d.findQueued = jest.fn().mockResolvedValueOnce({ ticketId: 43, status: 'open', assigned_to: '2', ai_epoch: 0, ai_engineer: other })
      .mockResolvedValueOnce(null);
    expect(await executeBridge('claim-checks', { ...scope, claim_id: randomUUID() }, d)).toEqual({ status: 'idle', execution_allowed: false });
    expect(d.store.repair).toHaveBeenCalledWith(43); expect(d.store.claim).not.toHaveBeenCalled();
  });
  it('replays an accepted conclusion after expiry without lease, catalog or store write', async () => {
    job.state = 'summarizing'; job.checks = checks(clock); live.ai_engineer = job;
    const first: any = await executeBridge('claim-summarizer', { ...scope, protocol: ai.CONCLUSION_PROTOCOL, claim_id: claim }, d);
    const request = { ...scope, protocol: ai.CONCLUSION_PROTOCOL, ticket_id: 4242, request_id: REQUEST, claim_id: claim,
      revision: 1, authority_digest: job.authority_digest, policy_fingerprint: job.policy_fingerprint,
      snapshot_digest: first.snapshot_digest, result: conclusion };
    const accepted = await executeBridge('publish-conclusion', request, d);
    clock = expires + 1;
    (d.bindingAllowed as unknown as jest.Mock).mockClear(); (d.store.publishConclusion as unknown as jest.Mock).mockClear();
    expect(await executeBridge('publish-conclusion', request, d)).toEqual(accepted);
    expect(d.bindingAllowed).not.toHaveBeenCalled(); expect(d.store.publishConclusion).not.toHaveBeenCalled();
    await expect(executeBridge('summarizer-status', (({ result, ...rest }) => rest)(request), d)).rejects.toThrow();
  });
});
