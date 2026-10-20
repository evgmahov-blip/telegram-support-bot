import { randomUUID } from 'crypto';
import * as ai from '../src/ai-engineer';
import { EngineerStore, EngineerPersistence, EngineerTicket, AdmissionFence, mongoEngineerPersistence } from '../src/ai-engineer-store';
import * as db from '../src/db';
import cache from '../src/cache';
import { authorityUpdate } from '../src/ai-engineer-authority';
jest.mock('../src/db', () => ({ Supportee: { findOneAndUpdate: jest.fn() } }));

const now = 1_700_000_000_000;
const binding: ai.Binding = { binding_id: 'canary', binding_version: 1, display_label: 'Canary', profile_id: ai.PROFILE };
const policy: ai.EngineerPolicy = { enabled: true, scope: 'most-support-vm3902',
  staff: [{ telegram_id: '1', role: 'admin' }, { telegram_id: '2', role: 'agent' }, { telegram_id: '3', role: 'agent' }] };
const ticket: EngineerTicket = { ticketId: 42, assigned_to: '2', status: 'open', ai_epoch: 0, ai_engineer: null };
const checks = (at = now): ai.CheckResult => ({ status: 'completed', execution_allowed: false, completed_at: at,
  facts: [{ ref: 'check-1', check_id: ai.PROFILE, observed_at: at, values: { reachable: true, uptime_seconds: 123 } }], unknowns: [] });
const conclusion: ai.Conclusion = { summary: 'Хост отвечает', verified_findings: [{ text: 'Доступен', evidence_refs: ['check-1'] }],
  hypotheses: [], unknowns: ['Причина обращения не подтверждена'], recommended_next_steps: ['Проверить симптомы'],
  customer_reply_draft: 'Продолжаем проверку обращения.' };

/** Single-document atomic CAS test double; no model/network/command is available. */
class MemoryPersistence implements EngineerPersistence {
  value = structuredClone(ticket);
  archives = new Map<string, string>();
  continuations = new Map<string, ai.Continuation>();
  events = new Map<string, string>();
  failEmit = false; failArchive = false;
  async read() { return structuredClone(this.value); }
  async compareAndSet(before: EngineerTicket, previous: ai.EngineerTask | null, next: ai.EngineerTask) {
    if (before.ai_epoch !== this.value.ai_epoch || before.status !== this.value.status
      || before.assigned_to !== this.value.assigned_to || (previous?.request_id ?? null) !== (this.value.ai_engineer?.request_id ?? null)
      || (previous?.version ?? null) !== (this.value.ai_engineer?.version ?? null)) return null;
    this.value.ai_engineer = structuredClone(next);
    return this.read();
  }
  async archive(snapshot: Record<string, unknown>, continuation?: ai.Continuation | null) {
    if (this.failArchive) throw new Error('archive unavailable');
    const key = `${snapshot.task_id}:${snapshot.revision}`, hash = ai.digest(snapshot);
    if (this.archives.has(key) && this.archives.get(key) !== hash) throw new Error('archive conflict');
    this.archives.set(key, hash);
    if (continuation) {
      if (this.continuations.has(key) && ai.digest(this.continuations.get(key)) !== ai.digest(continuation)) throw new Error('continuation conflict');
      this.continuations.set(key, structuredClone(continuation));
    }
  }
  async emit(id: number, p: ai.Projection) {
    if (this.failEmit) throw new Error('audit unavailable');
    const body = ai.digest({ id, p });
    if (this.events.has(p.event_id) && this.events.get(p.event_id) !== body) throw new Error('event conflict');
    this.events.set(p.event_id, body);
  }
}

describe('AI engineer durable task protocol', () => {
  let memory: MemoryPersistence, store: EngineerStore, clock: number, activePolicy: ai.EngineerPolicy;
  beforeEach(() => {
    memory = new MemoryPersistence(); clock = now; activePolicy = structuredClone(policy);
    store = new EngineerStore(() => activePolicy, memory, () => clock);
  });
  async function submitted() {
    const job = await store.submit(42, '2', binding, ai.snapshotInput('Проверить доступность'));
    await store.repair(42); return job.request_id;
  }
  it.each(['cancel', 'expire', 'replace'])('atomic task admission rejects a form that changes during %s', async change => {
    const original = memory.compareAndSet.bind(memory);
    let form: any = { pending_reply_staff_id: '2', pending_reply_chat_id: '-100', pending_reply_thread_id: 5,
      pending_reply_kind: 'note', pending_reply_version: 3, pending_reply_expires_at: new Date(Date.now() + 60000),
      ai_engineer_draft: { token: 'token', version: 1, compose_version: 3, step: 'preview' } };
    const update = jest.spyOn(db.Supportee, 'findOneAndUpdate').mockImplementation((filter: any) => {
      // Simulate the cancellation/replacement winning immediately before the
      // server evaluates the admission write, after prior reads have succeeded.
      if (change === 'cancel') form.pending_reply_staff_id = null;
      if (change === 'expire') form.pending_reply_expires_at = new Date(0);
      if (change === 'replace') form.ai_engineer_draft.token = 'other';
      const matches = Object.entries(filter).every(([key, value]: [string, any]) => {
        if (key.startsWith('ai_engineer_draft.')) return form.ai_engineer_draft[key.split('.')[1]] === value;
        if (key === 'pending_reply_expires_at') return +form[key] > +value.$gt;
        if (key.startsWith('pending_reply_')) return form[key] === value;
        return true;
      });
      return { lean: async () => matches ? { ...memory.value, ai_engineer: {} } : null } as any;
    });
    const fence: AdmissionFence = { owner: '2', epoch: 0, base_request: null,
      draft: { token: 'token', version: 1, compose_version: 3, actor: '2', chat: '-100', thread: 5 } };
    memory.compareAndSet = async (before, previous, next, guard?) => {
      const admitted = await mongoEngineerPersistence.compareAndSet(before, previous, next, guard);
      return admitted ? original(before, previous, next) : null;
    };
    try {
      await expect(store.submit(42, '2', binding, ai.snapshotInput('Проверить'), undefined, fence)).rejects.toThrow('state_changed');
      expect(memory.value.ai_engineer).toBeNull();
      expect(update.mock.calls[0][0]).toMatchObject({ pending_reply_staff_id: '2', pending_reply_kind: 'note',
        pending_reply_chat_id: '-100', pending_reply_thread_id: 5, pending_reply_version: 3,
        'ai_engineer_draft.token': 'token', 'ai_engineer_draft.version': 1, 'ai_engineer_draft.step': 'preview' });
    } finally { update.mockRestore(); }
  });
  it('rejects a changed ticket admission fence even for an administrator', async () => {
    const fence = { owner: '2', epoch: 0, base_request: null };
    memory.value.ai_epoch = 1; memory.value.assigned_to = '3';
    await expect(store.submit(42, '1', binding, ai.snapshotInput('Проверить'), undefined, fence)).rejects.toThrow('authority_changed');
    expect(memory.value.ai_engineer).toBeNull();
  });
  async function awaiting() {
    const request = await submitted(); const collector = randomUUID(), summarizer = randomUUID();
    await store.claim(42, request, 'collector', collector);
    await store.publishChecks(42, request, collector, checks()); await store.repair(42);
    await store.claimSummarizer(42, request, summarizer, ai.digest({ request }));
    await store.publishConclusion(42, request, summarizer, conclusion); await store.repair(42);
    return request;
  }
  it('keeps one accepted task under simultaneous duplicate confirmations', async () => {
    const ids = { task_id: randomUUID(), request_id: randomUUID() };
    const results = await Promise.allSettled([store.submit(42, '2', binding, ai.snapshotInput('Проверить'), ids),
      store.submit(42, '2', binding, ai.snapshotInput('Проверить'), ids)]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect((await store.submit(42, '2', binding, ai.snapshotInput('Проверить'), ids)).request_id).toBe(ids.request_id);
    await expect(store.submit(42, '2', binding, ai.snapshotInput('Другая цель'), ids)).rejects.toThrow('request_conflict');
    expect(memory.value.assigned_to).toBe('2');
  });
  it('rejects foreign agents, missing roles, banned and closed tickets', async () => {
    for (const actor of ['3', 'unknown']) await expect(store.submit(42, actor, binding, ai.snapshotInput('Проверить'))).rejects.toThrow('not_authorized');
    memory.value.ai_banned = true;
    await expect(store.submit(42, '1', binding, ai.snapshotInput('Проверить'))).rejects.toThrow('not_authorized');
    memory.value.ai_banned = false; memory.value.status = 'closed';
    await expect(store.submit(42, '1', binding, ai.snapshotInput('Проверить'))).rejects.toThrow('not_authorized');
  });
  it('never overwrites a pending audit event', async () => {
    const job = await store.submit(42, '2', binding, ai.snapshotInput('Проверить'));
    const pending = memory.value.ai_engineer!.projection_pending;
    await expect(store.claim(42, job.request_id, 'collector', randomUUID())).rejects.toThrow('projection_pending');
    memory.failEmit = true;
    await expect(store.repair(42)).rejects.toThrow('audit unavailable');
    expect(memory.value.ai_engineer!.projection_pending).toEqual(pending);
    memory.failEmit = false; await store.repair(42); await store.repair(42);
    expect(memory.events.size).toBe(1);
  });
  it('reclaims an expired collector lease and rejects the older worker', async () => {
    const request = await submitted(), a = randomUUID(), b = randomUUID();
    await store.claim(42, request, 'collector', a);
    await expect(store.claim(42, request, 'collector', b)).rejects.toThrow('lease_busy');
    clock += ai.COLLECTOR_MS;
    await store.claim(42, request, 'collector', b);
    await expect(store.publishChecks(42, request, a, checks(clock))).rejects.toThrow('lease_stale');
    await store.publishChecks(42, request, b, checks(clock));
    expect(memory.value.ai_engineer!.state).toBe('summarizing');
  });
  it('replays the exact completed publication but rejects a forged receipt', async () => {
    const request = await submitted(), claim = randomUUID();
    await store.claim(42, request, 'collector', claim);
    const first = await store.publishChecks(42, request, claim, checks());
    expect(await store.publishChecks(42, request, claim, checks())).toEqual(first);
    await expect(store.publishChecks(42, request, randomUUID(), checks())).rejects.toThrow('projection_pending');
    await store.repair(42);
    await expect(store.publishChecks(42, request, randomUUID(), checks())).rejects.toThrow('lease_stale');
  });
  it.each(['close', 'transfer', 'ABA', 'policy', 'disable'])('fences publication after %s', async (change) => {
    const request = await submitted(), claim = randomUUID(); await store.claim(42, request, 'collector', claim);
    if (change === 'close') memory.value.status = 'closed';
    if (change === 'transfer') memory.value.assigned_to = '3';
    if (change === 'ABA') memory.value.ai_epoch = 2;
    if (change === 'policy') activePolicy.staff = activePolicy.staff.filter(s => s.telegram_id !== '2');
    if (change === 'disable') activePolicy.enabled = false;
    await expect(store.publishChecks(42, request, claim, checks())).rejects.toThrow('authority_changed');
    await store.repair(42); await store.repair(42);
    expect(memory.value.ai_engineer!.state).toBe('stale');
    expect(memory.archives.size).toBe(1);
  });
  it('drains submission before recording stale when close races with outbox', async () => {
    await store.submit(42, '2', binding, ai.snapshotInput('Проверить'));
    const pending = memory.value.ai_engineer!.projection_pending!; memory.value.status = 'closed'; memory.value.ai_epoch = 1;
    await store.repair(42);
    expect(memory.events.has(pending.event_id)).toBe(true);
    expect(memory.value.ai_engineer!.projection_pending!.type).toBe('ai.stale');
    await store.repair(42); expect(memory.events.size).toBe(2);
  });
  it('admits a fresh revision for the new owner after an old task becomes stale', async () => {
    const request = await submitted();
    memory.value.assigned_to = '3'; memory.value.ai_epoch = 1;
    await store.repair(42); await store.repair(42);
    const next = await store.submit(42, '3', binding, ai.snapshotInput('Новая проверка после передачи'));
    expect(next.revision).toBe(2); expect(next.ticket_epoch).toBe(1); expect(next.requested_by).toBe('3');
    expect(next.request_id).not.toBe(request); expect(memory.archives.size).toBe(1);
    await expect(store.publishChecks(42, request, randomUUID(), checks())).rejects.toThrow('request_changed');
  });
  it('abandons a transferred continuation only through fresh admission, retaining its feedback in audit', async () => {
    const request = await awaiting(), operation = randomUUID();
    const reworked = await store.rework(42, request, '2', operation, 'Проверить повторно');
    await store.repair(42);
    memory.value.assigned_to = '3'; memory.value.ai_epoch = 1;
    await expect(store.continueRevision(42, request)).rejects.toThrow('authority_changed');
    const next = await store.submit(42, '3', binding, ai.snapshotInput('Новая подтверждённая постановка'));
    expect(next.revision).toBe(2); expect(next.request_id).not.toBe(reworked.continuation!.request_id);
    expect(memory.continuations.get(`${reworked.task_id}:1`)?.input.feedback).toBe('Проверить повторно');
  });
  it('archives rework before replacement and resumes the same intent after failure', async () => {
    const request = await awaiting(), operation = randomUUID();
    const previousConclusion = structuredClone(memory.value.ai_engineer!.conclusion);
    const reworked = await store.rework(42, request, '2', operation, 'Уточнить гипотезу');
    expect(reworked.state).toBe('reworked');
    expect((await store.rework(42, request, '2', operation, 'Уточнить гипотезу')).continuation).toEqual(reworked.continuation);
    await expect(store.continueRevision(42, request)).rejects.toThrow('not_ready');
    await store.repair(42); memory.failArchive = true;
    await expect(store.continueRevision(42, request)).rejects.toThrow('archive unavailable');
    expect(memory.value.ai_engineer!.conclusion).toEqual(previousConclusion);
    memory.failArchive = false;
    const next = await store.continueRevision(42, request);
    expect(next.revision).toBe(2); expect(next.request_id).toBe(reworked.continuation!.request_id);
    expect(next.input.feedback).toBe('Уточнить гипотезу'); expect(next.conclusion).toBeNull();
    expect(memory.archives.size).toBe(1);
    await expect(store.continueRevision(42, request)).rejects.toThrow('request_changed');
  });
  it('permits human handoff after computation TTL without reopening or replying', async () => {
    const request = await awaiting(); clock += ai.REQUEST_MS * 2;
    await store.handoff(42, request, '2'); await store.repair(42);
    expect(memory.value.ai_engineer!.state).toBe('handed_off');
    expect(memory.value.status).toBe('open'); expect(memory.value.assigned_to).toBe('2');
  });
  it('bounds actual summarizer attempts across crashes', async () => {
    const request = await submitted(), collector = randomUUID();
    await store.claim(42, request, 'collector', collector); await store.publishChecks(42, request, collector, checks()); await store.repair(42);
    await store.claimSummarizer(42, request, randomUUID(), ai.digest({ request, attempt: 1 })); clock += ai.SUMMARIZER_MS;
    await store.claimSummarizer(42, request, randomUUID(), ai.digest({ request, attempt: 2 })); clock += ai.SUMMARIZER_MS;
    await expect(store.claimSummarizer(42, request, randomUUID(), ai.digest({ request, attempt: 3 }))).rejects.toThrow('attempts_exhausted');
    await store.repair(42); expect(memory.value.ai_engineer!.failure_code).toBe('attempts_exhausted');
  });
  it('rejects executable/unknown check fields and invented evidence', async () => {
    const request = await submitted(), claim = randomUUID(); await store.claim(42, request, 'collector', claim);
    await expect(store.publishChecks(42, request, claim, { ...checks(), command: 'id' })).rejects.toThrow('unexpected_fields');
    await expect(store.publishChecks(42, request, claim, { ...checks(), execution_allowed: true })).rejects.toThrow('invalid_checks');
    await store.publishChecks(42, request, claim, checks()); await store.repair(42);
    const summarizer = randomUUID(); await store.claimSummarizer(42, request, summarizer, ai.digest({ request }));
    await expect(store.publishConclusion(42, request, summarizer, { ...conclusion,
      verified_findings: [{ text: 'Придуманный факт', evidence_refs: ['other-customer'] }] })).rejects.toThrow('evidence_unknown');
  });
  it('does not let an archive hash change due to a continuation or outbox acknowledgement', async () => {
    const request = await awaiting(); const handed = await store.handoff(42, request, '2');
    const hash = ai.digest(ai.archiveSnapshot(handed)); await store.repair(42);
    await store.rework(42, request, '2', randomUUID(), 'Новая проверка');
    expect(ai.digest(ai.archiveSnapshot(memory.value.ai_engineer!))).toBe(hash);
    await store.repair(42); expect(memory.archives.size).toBe(1);
  });
  it('expires unfinished work and never concludes stale facts', async () => {
    const request = await submitted(), collector = randomUUID(); await store.claim(42, request, 'collector', collector);
    clock += ai.REQUEST_MS;
    await expect(store.publishChecks(42, request, collector, checks(clock))).rejects.toThrow('request_expired');
    await store.repair(42); expect(memory.value.ai_engineer!.state).toBe('failed');
    expect(() => ai.validateChecks(checks(now), clock)).toThrow('facts_stale');
  });
});

describe('authority updates', () => {
  afterEach(() => { cache.config.ai_engineer_enabled = false; });
  it('retains legacy updates when disabled', () => {
    cache.config.ai_engineer_enabled = false;
    expect(authorityUpdate({ status: 'closed' })).toEqual({ $set: { status: 'closed' } });
  });
  it('puts the change comparison, authority write and epoch in one Mongo update', () => {
    cache.config.ai_engineer_enabled = true;
    expect(authorityUpdate({ assigned_to: 'new' })).toEqual([{ $set: {
      assigned_to: { $literal: 'new' }, ai_epoch: { $add: [{ $ifNull: ['$ai_epoch', 0] },
        { $cond: [{ $or: [{ $ne: [{ $ifNull: ['$assigned_to', null] }, { $literal: 'new' }] }] }, 1, 0] }] },
    } }]);
  });
});
