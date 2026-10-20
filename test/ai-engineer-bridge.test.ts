import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
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
      findSummarizer: jest.fn(async () => null),
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

describe('support-conclusion-v1 bridge', () => {
  let clock: number, liveTicket: any, job: ai.EngineerTask, d: BridgeDependencies;
  const claim = '10000000-0000-4000-8000-000000000001';
  const conclusion: ai.Conclusion = { summary: 'Host is reachable',
    verified_findings: [{ text: 'Reachability was verified', evidence_refs: ['check-1'] }],
    hypotheses: [], unknowns: ['Application state was not inspected'],
    recommended_next_steps: ['Inspect the application with an approved workflow'],
    customer_reply_draft: 'We are continuing the investigation.' };
  beforeEach(() => {
    clock = now;
    job = ai.createTask(ticket, policy, '1', binding,
      ai.snapshotInput('Check token=super-secret-value and https://private.invalid', '', 'password=hunter2-secret'), clock);
    job = ai.acknowledge(job, job.projection_pending!.id);
    job.state = 'summarizing';
    job.checks = { status: 'partial', facts: [{ ref: 'check-1', check_id: ai.PROFILE, observed_at: clock,
      values: { reachable: true, uptime_seconds: null } }], unknowns: ['uptime unavailable'],
    completed_at: clock, execution_allowed: false };
    liveTicket = { ...ticket, ai_engineer: job };
    const store: any = {
      read: jest.fn(async () => liveTicket), repair: jest.fn(async () => null),
      claimSummarizer: jest.fn(async (_t, _r, c, snapshot) => {
        job = ai.claim(job, 'summarizer', c, clock, snapshot); liveTicket.ai_engineer = job; return job;
      }),
      renewSummarizer: jest.fn(async (_t, _r, c, snapshot) => {
        job = ai.renewSummarizer(job, c, snapshot, clock); liveTicket.ai_engineer = job; return job;
      }),
      publishConclusion: jest.fn(async (_t, _r, c, result) => {
        if (job.conclusion && job.summarizer_receipt === c && ai.digest(job.conclusion) === ai.digest(result)) return job;
        job = ai.finishConclusion(job, c, result, clock); liveTicket.ai_engineer = job; return job;
      }),
      failConclusion: jest.fn(async (_t, _r, c, code) => {
        job = ai.failConclusion(job, c, code, clock); liveTicket.ai_engineer = job; return job;
      }),
    };
    d = { policy: () => policy, clock: () => clock, findQueued: jest.fn(async () => null),
      findSummarizer: jest.fn(async () => liveTicket), findClaim: jest.fn(async id => id === claim ? liveTicket : null),
      bindingAllowed: jest.fn(async () => undefined), publishCatalog: jest.fn(), store };
  });
  const claimRequest = () => ({ ...scope, protocol: ai.CONCLUSION_PROTOCOL, claim_id: claim });
  const boundRequest = (snapshot: string) => ({ ...scope, protocol: ai.CONCLUSION_PROTOCOL, ticket_id: 42,
    request_id: job.request_id, claim_id: claim, revision: job.revision, authority_digest: job.authority_digest,
    policy_fingerprint: job.policy_fingerprint, snapshot_digest: snapshot });

  it('returns only a redacted frozen model projection and a canonical digest', async () => {
    d.findClaim = jest.fn(async () => null);
    const result: any = await executeBridge('claim-summarizer', claimRequest(), d);
    expect(result.status).toBe('claimed'); expect(result.protocol).toBe(ai.CONCLUSION_PROTOCOL);
    expect(result.input).toEqual(expect.objectContaining({ history: '' }));
    expect(JSON.stringify(result.input)).not.toMatch(/super-secret-value|hunter2-secret|private\.invalid/);
    expect(result.checks.facts[0].ref).toBe('check-1');
    expect(result.snapshot_digest).toBe(ai.digest({ task: result.task, input: result.input, checks: result.checks }));
    expect(JSON.stringify(result)).not.toMatch(/expected_owner|PRIVATE_HISTORY/);
  });
  it('replays the same live claim and heartbeat without consuming an attempt', async () => {
    d.findClaim = jest.fn(async () => null);
    const first: any = await executeBridge('claim-summarizer', claimRequest(), d);
    const attempts = job.attempts, initial = job.summarizer!.until;
    clock += 10_000; d.findClaim = jest.fn(async () => liveTicket);
    const duplicate: any = await executeBridge('claim-summarizer', claimRequest(), d);
    expect(duplicate.snapshot_digest).toBe(first.snapshot_digest);
    const status: any = await executeBridge('summarizer-status', boundRequest(first.snapshot_digest), d);
    expect(job.attempts).toBe(attempts); expect(status.eligible).toBe(true);
    expect(status.lease_until).toBeGreaterThan(initial);
  });
  it('does not revive an expired claim', async () => {
    d.findClaim = jest.fn(async () => null);
    const first: any = await executeBridge('claim-summarizer', claimRequest(), d);
    clock = job.summarizer!.until;
    await expect(executeBridge('summarizer-status', boundRequest(first.snapshot_digest), d)).rejects.toThrow('lease_stale');
  });
  it('rejects an old claim after lease loss and a second claim', async () => {
    d.findClaim = jest.fn(async () => null);
    const first: any = await executeBridge('claim-summarizer', claimRequest(), d);
    clock = job.summarizer!.until;
    const secondClaim = '10000000-0000-4000-8000-000000000002';
    d.findSummarizer = jest.fn(async () => liveTicket);
    const second: any = await executeBridge('claim-summarizer', { ...scope, protocol: ai.CONCLUSION_PROTOCOL,
      claim_id: secondClaim }, d);
    expect(second.claim_id).toBe(secondClaim); expect(job.attempts).toBe(2);
    await expect(executeBridge('publish-conclusion', { ...boundRequest(first.snapshot_digest), result: conclusion }, d))
      .rejects.toThrow('lease_stale');
    await expect(executeBridge('fail-conclusion', { ...boundRequest(first.snapshot_digest), code: 'model_unavailable' }, d))
      .rejects.toThrow('lease_stale');
  });
  it('publishes an exact six-key conclusion idempotently and rejects conflicting replay', async () => {
    d.findClaim = jest.fn(async () => null);
    const first: any = await executeBridge('claim-summarizer', claimRequest(), d);
    const request = { ...boundRequest(first.snapshot_digest), result: conclusion };
    expect((await executeBridge('publish-conclusion', request, d) as any).status).toBe('awaiting_operator');
    expect((await executeBridge('publish-conclusion', request, d) as any).status).toBe('awaiting_operator');
    await expect(executeBridge('publish-conclusion', { ...request,
      result: { ...conclusion, summary: 'conflict' } }, d)).rejects.toThrow('projection_pending');
  });
  it('replays an accepted publish receipt after facts and catalog expire', async () => {
    d.findClaim = jest.fn(async () => null);
    const first: any = await executeBridge('claim-summarizer', claimRequest(), d);
    const request = { ...boundRequest(first.snapshot_digest), result: conclusion };
    const accepted = await executeBridge('publish-conclusion', request, d);
    clock += ai.FACTS_MS + 1;
    d.bindingAllowed = jest.fn(async () => { throw new ai.EngineerError('catalog_expired'); });
    expect(await executeBridge('publish-conclusion', request, d)).toEqual(accepted);
    expect(d.bindingAllowed).not.toHaveBeenCalled();
  });
  it('replays an accepted failure receipt and rejects the opposite outcome', async () => {
    d.findClaim = jest.fn(async () => null);
    const first: any = await executeBridge('claim-summarizer', claimRequest(), d);
    const request = { ...boundRequest(first.snapshot_digest), code: 'model_unavailable' };
    const accepted = await executeBridge('fail-conclusion', request, d);
    clock += ai.FACTS_MS + 1;
    expect(await executeBridge('fail-conclusion', request, d)).toEqual(accepted);
    await expect(executeBridge('publish-conclusion', { ...boundRequest(first.snapshot_digest), result: conclusion }, d))
      .rejects.toThrow();
  });
  it.each([
    ['revision', () => ({ revision: job.revision + 1 }), 'result_binding_changed'],
    ['policy', () => ({ policy_fingerprint: 'changed' }), 'result_binding_changed'],
    ['snapshot', () => ({ snapshot_digest: '0'.repeat(64) }), 'snapshot_changed'],
  ])('rejects changed %s binding', async (_name, mutation, code) => {
    d.findClaim = jest.fn(async () => null);
    const first: any = await executeBridge('claim-summarizer', claimRequest(), d);
    await expect(executeBridge('publish-conclusion', { ...boundRequest(first.snapshot_digest), ...mutation(), result: conclusion }, d))
      .rejects.toThrow(code);
  });
  it.each(['closed', 'owner', 'epoch'])('rejects live authority mutation: %s', async change => {
    d.findClaim = jest.fn(async () => null);
    const first: any = await executeBridge('claim-summarizer', claimRequest(), d);
    if (change === 'closed') liveTicket.status = 'closed';
    if (change === 'owner') liveTicket.assigned_to = '9';
    if (change === 'epoch') liveTicket.ai_epoch = 1;
    await expect(executeBridge('publish-conclusion', { ...boundRequest(first.snapshot_digest), result: conclusion }, d))
      .rejects.toThrow('authority_changed');
  });
  it('rejects mixed protocols, extra fields, invalid failure codes and invented evidence', async () => {
    await expect(executeBridge('claim-summarizer', { ...claimRequest(), protocol: 'support-conclusion-v0' }, d))
      .rejects.toThrow('protocol_denied');
    await expect(executeBridge('claim-summarizer', { ...claimRequest(), extra: true }, d)).rejects.toThrow('unexpected_fields');
    d.findClaim = jest.fn(async () => null);
    const first: any = await executeBridge('claim-summarizer', claimRequest(), d);
    await expect(executeBridge('fail-conclusion', { ...boundRequest(first.snapshot_digest), code: 'provider_error' }, d))
      .rejects.toThrow('failure_code_denied');
    await expect(executeBridge('publish-conclusion', { ...boundRequest(first.snapshot_digest), result: { ...conclusion,
      verified_findings: [{ text: 'invented', evidence_refs: ['unknown-ref'] }] } }, d)).rejects.toThrow('evidence_unknown');
  });
  it.each(['claim-checks', 'request-status', 'publish-checks'])('keeps legacy %s schema protocol-free', async operation => {
    const request: any = operation === 'claim-checks' ? { ...scope, claim_id: randomUUID(), protocol: ai.CONCLUSION_PROTOCOL }
      : operation === 'request-status' ? { ...scope, ticket_id: 42, request_id: job.request_id,
        claim_id: randomUUID(), protocol: ai.CONCLUSION_PROTOCOL }
      : { ...scope, ticket_id: 42, request_id: job.request_id, claim_id: randomUUID(), revision: job.revision,
        authority_digest: job.authority_digest, policy_fingerprint: job.policy_fingerprint, result: {}, protocol: ai.CONCLUSION_PROTOCOL };
    await expect(executeBridge(operation, request, d)).rejects.toThrow('unexpected_fields');
  });
  it.each(['input', 'checks'])('rejects a frozen %s projection mutation', async changed => {
    d.findClaim = jest.fn(async () => null);
    const first: any = await executeBridge('claim-summarizer', claimRequest(), d);
    if (changed === 'input') job.input.goal = 'mutated after claim';
    else job.checks!.unknowns = ['mutated after claim'];
    await expect(executeBridge('summarizer-status', boundRequest(first.snapshot_digest), d)).rejects.toThrow('snapshot_changed');
  });
  it('rejects cancelled/expired work, stale facts, and an expired catalog', async () => {
    d.findClaim = jest.fn(async () => null);
    const first: any = await executeBridge('claim-summarizer', claimRequest(), d);
    job.state = 'cancelled'; job.summarizer = null;
    await expect(executeBridge('summarizer-status', boundRequest(first.snapshot_digest), d)).rejects.toThrow('lease_stale');
    job.state = 'summarizing'; job.summarizer = { claim_id: claim, until: clock + ai.SUMMARIZER_MS };
    clock = job.expires_at;
    await expect(executeBridge('summarizer-status', boundRequest(first.snapshot_digest), d)).rejects.toThrow('facts_stale');
    clock = now; d.bindingAllowed = jest.fn(async () => { throw new ai.EngineerError('catalog_expired'); });
    await expect(executeBridge('summarizer-status', boundRequest(first.snapshot_digest), d)).rejects.toThrow('catalog_expired');
  });
  it('rejects publication when facts become stale after claim', async () => {
    d.findClaim = jest.fn(async () => null);
    const first: any = await executeBridge('claim-summarizer', claimRequest(), d);
    clock += ai.FACTS_MS + 1;
    await expect(executeBridge('publish-conclusion', { ...boundRequest(first.snapshot_digest), result: conclusion }, d))
      .rejects.toThrow('facts_stale');
  });
  it('matches the checked-in language-neutral parity fixture', async () => {
    const fixture = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'support-conclusion-v1.json'), 'utf8'));
    job = ai.createTask(ticket, policy, '1', binding,
      ai.snapshotInput(fixture.claim_response.input.goal, '', fixture.claim_response.input.feedback), now,
      { task_id: fixture.claim_response.task.task_id, request_id: fixture.claim_response.task.request_id });
    job = ai.acknowledge(job, job.projection_pending!.id);
    job.state = 'summarizing'; job.checks = structuredClone(fixture.claim_response.checks);
    liveTicket.ai_engineer = job; d.findClaim = jest.fn(async () => null);
    expect(ai.digest({ task: fixture.claim_response.task, input: fixture.claim_response.input,
      checks: fixture.claim_response.checks })).toBe(fixture.claim_response.snapshot_digest);
    expect(await executeBridge('claim-summarizer', fixture.claim_request, d)).toEqual(fixture.claim_response);
    expect(await executeBridge('publish-conclusion', fixture.publish_request, d)).toEqual(fixture.publish_response);
    expect(await executeBridge('publish-conclusion', fixture.publish_request, d)).toEqual(fixture.publish_response);
  });
});
