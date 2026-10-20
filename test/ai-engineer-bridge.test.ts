import { randomUUID } from 'crypto';
import * as ai from '../src/ai-engineer';
import { executeBridge, publicEnvelope, BridgeDependencies } from '../src/ai-engineer-bridge';
import { validateCatalog } from '../src/ai-engineer-catalog';

const now = 1_700_000_000_000;
const policy: ai.EngineerPolicy = { enabled: true, scope: 'most-support-vm3902', staff: [{ telegram_id: '1', role: 'admin' }] };
const binding: ai.Binding = { binding_id: 'canary', binding_version: 1, display_label: 'Canary', profile_id: ai.PROFILE };
const ticket = { ticketId: 42, status: 'open', assigned_to: null, ai_epoch: 0 };
const scope = { deployment_scope: policy.scope };

describe('fixed AI bridge protocol', () => {
  let d: BridgeDependencies, job: ai.EngineerTask;
  beforeEach(() => {
    job = ai.createTask(ticket, policy, '1', binding, ai.snapshotInput('PRIVATE_GOAL', 'PRIVATE_HISTORY', 'PRIVATE_FEEDBACK'), now);
    job = ai.acknowledge(job, job.projection_pending!.id);
    d = { policy: () => policy, clock: () => now, findQueued: jest.fn(async () => ({ ...ticket, ai_engineer: job })),
      findClaim: jest.fn(async () => null), bindingAllowed: jest.fn(async () => undefined),
      publishCatalog: jest.fn(), store: {
        read: jest.fn(async () => ({ ...ticket, ai_engineer: job })),
        claim: jest.fn(async (_ticket: number, _request: string, _stage: 'collector', claim: string) => ai.claim(job, 'collector', claim, now)),
        publishChecks: jest.fn(async () => ({ ...job, state: 'summarizing' })),
        repair: jest.fn(async () => null),
      } as any };
  });
  it('exports identity and digests without customer context or privileged commands', () => {
    const serialized = JSON.stringify(publicEnvelope(job));
    expect(serialized).not.toMatch(/PRIVATE_|goal|history|feedback|shell|command/);
    expect(publicEnvelope(job).execution_allowed).toBe(false);
  });
  it.each(['execute', 'shell', 'activate', ''])('denies unknown operation %s before DB access', async operation => {
    await expect(executeBridge(operation, scope, d)).rejects.toThrow('operation_denied');
    expect(d.findQueued).not.toHaveBeenCalled();
  });
  it('denies foreign scope and caller-controlled command fields', async () => {
    await expect(executeBridge('claim-checks', { ...scope, deployment_scope: 'other', claim_id: randomUUID() }, d)).rejects.toThrow('scope_denied');
    await expect(executeBridge('claim-checks', { ...scope, claim_id: randomUUID(), command: 'id' }, d)).rejects.toThrow('unexpected_fields');
    expect(d.store.claim).not.toHaveBeenCalled();
  });
  it('checks catalog binding before claiming and returns a bounded public envelope', async () => {
    const claim = randomUUID(), result: any = await executeBridge('claim-checks', { ...scope, claim_id: claim }, d);
    expect(d.bindingAllowed).toHaveBeenCalledWith(policy.scope, binding, now);
    expect(result.claim_id).toBe(claim); expect(result.task.request_id).toBe(job.request_id);
    expect(JSON.stringify(result)).not.toContain('PRIVATE_');
  });
  it('never claims an unavailable binding', async () => {
    d.bindingAllowed = jest.fn(async () => { throw new ai.EngineerError('binding_unavailable'); });
    expect(await executeBridge('claim-checks', { ...scope, claim_id: randomUUID() }, d)).toEqual({ status: 'idle', execution_allowed: false });
    expect(d.store.claim).not.toHaveBeenCalled();
  });
  it('skips a stale head and delivers the next eligible ticket', async () => {
    const second = ai.createTask({ ...ticket, ticketId: 43 }, policy, '1', binding, ai.snapshotInput('Вторая заявка'), now);
    const available = ai.acknowledge(second, second.projection_pending!.id);
    d.findQueued = jest.fn().mockResolvedValueOnce({ ...ticket, ai_epoch: 1, ai_engineer: job })
      .mockResolvedValueOnce({ ...ticket, ticketId: 43, ai_engineer: available });
    d.store.claim = jest.fn(async (_t, _r, _s, claim) => ai.claim(available, 'collector', claim, now));
    const result: any = await executeBridge('claim-checks', { ...scope, claim_id: randomUUID() }, d);
    expect(d.store.repair).toHaveBeenCalledWith(42);
    expect(result.status).toBe('collecting'); expect(result.task.ticket_id).toBe(43);
    expect(d.store.claim).toHaveBeenCalledTimes(1);
  });
  it('replays a collector claim without starting a second attempt', async () => {
    const claim = randomUUID(); job = ai.claim(job, 'collector', claim, now);
    d.findClaim = jest.fn(async () => ({ ...ticket, ai_engineer: job }));
    const result: any = await executeBridge('claim-checks', { ...scope, claim_id: claim }, d);
    expect(result.task.request_id).toBe(job.request_id); expect(d.store.claim).not.toHaveBeenCalled();
  });
  it('rejects publication bound to another revision or policy', async () => {
    const request = { ...scope, ticket_id: 42, request_id: job.request_id, claim_id: randomUUID(),
      revision: 2, authority_digest: job.authority_digest, policy_fingerprint: job.policy_fingerprint, result: {} };
    await expect(executeBridge('publish-checks', request, d)).rejects.toThrow('result_binding_changed');
    expect(d.store.publishChecks).not.toHaveBeenCalled();
  });
  it('reports ineligible after a completed check rather than authorizing another run', async () => {
    job.state = 'summarizing';
    const result: any = await executeBridge('request-status', { ...scope, ticket_id: 42, request_id: job.request_id, claim_id: randomUUID() }, d);
    expect(result.eligible).toBe(false); expect(result.execution_allowed).toBe(false);
  });
});

describe('binding catalog wire contract', () => {
  const catalog = { ...scope, version: 1, generated_at: now, expires_at: now + ai.FACTS_MS, entries: [binding] };
  it('accepts only bounded, fresh catalogs', () => {
    expect(validateCatalog(catalog, policy.scope, now)).toEqual(catalog);
    expect(() => validateCatalog(catalog, policy.scope, now + ai.FACTS_MS)).toThrow('catalog_expired');
    expect(() => validateCatalog({ ...catalog, expires_at: now + ai.FACTS_MS + 1 }, policy.scope, now)).toThrow('catalog_expired');
  });
  it('rejects full inventory fields, duplicate bindings and arbitrary profiles', () => {
    expect(() => validateCatalog({ ...catalog, token: 'secret' }, policy.scope, now)).toThrow('unexpected_fields');
    expect(() => validateCatalog({ ...catalog, entries: [binding, binding] }, policy.scope, now)).toThrow('binding_duplicate');
    expect(() => validateCatalog({ ...catalog, entries: [{ ...binding, profile_id: 'shell' }] }, policy.scope, now)).toThrow('profile_denied');
  });
});
