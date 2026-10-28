import mongoose from 'mongoose';
import cache from './cache';
import * as db from './db';
import * as ai from './ai-engineer';
import { EngineerStore, EngineerTicket, initializeEngineerIndexes } from './ai-engineer-store';
import * as catalog from './ai-engineer-catalog';

export const OPERATIONS = ['publish-catalog', 'claim-checks', 'publish-checks', 'request-status', 'cancel-checks',
  'claim-summarizer', 'summarizer-status', 'publish-conclusion', 'fail-conclusion'] as const;
export function engineerPolicy(): ai.EngineerPolicy {
  const config = cache.config;
  const base: ai.EngineerPolicy = { enabled: config.ai_engineer_enabled === true, scope: config.ai_engineer_scope || 'most-support-vm3902',
    staff: (config.staff_roles || []).map(s => ({ telegram_id: String(s.telegram_id), role: s.role })) };
  const canary = ai.parseCanaryPolicy(config.ai_engineer_mode, config.ai_engineer_canary_admission, base);
  return canary ? { ...base, canary } : base;
}
/**
 * Canary queue selection: only the exact admitted ticket/request/revision/owner/epoch/binding,
 * and nothing at all outside the admission window. `undefined` means standard mode.
 */
export function canarySelection(policy: ai.EngineerPolicy, now: number, excluded: string[]): Record<string, unknown> | null | undefined {
  if (!policy.canary) return undefined;
  let a: ai.CanaryAdmission | null;
  try { a = ai.canaryWindow(policy, now); } catch { return null; }
  if (!a) return null;
  return { ticketId: a.ticket_id, 'ai_engineer.request_id': { $eq: a.request_id, $nin: excluded },
    'ai_engineer.revision': a.revision, 'ai_engineer.ticket_id': a.ticket_id, 'ai_engineer.requested_by': a.requested_by,
    'ai_engineer.expected_owner': a.expected_owner, 'ai_engineer.ticket_epoch': a.ticket_epoch,
    'ai_engineer.binding.binding_id': a.binding_id, 'ai_engineer.binding.binding_version': a.binding_version,
    'ai_engineer.binding.profile_id': a.profile_id };
}
/** No ticket context/goal/history/feedback crosses this boundary. */
export function publicEnvelope(job: ai.EngineerTask) {
  return { schema: job.schema, deployment_scope: job.scope, task_id: job.task_id, request_id: job.request_id,
    ticket_id: job.ticket_id, revision: job.revision, ticket_epoch: job.ticket_epoch,
    requested_by: job.requested_by, binding_id: job.binding.binding_id, binding_version: job.binding.binding_version,
    profile_id: job.binding.profile_id, context_digest: job.input_digest, authority_digest: job.authority_digest,
    policy_fingerprint: job.policy_fingerprint, created_at: job.created_at, expires_at: job.expires_at,
    execution_allowed: false };
}
function knownBotSecrets(): string[] {
  const c = cache.config;
  return [c.bot_token, c.llm_api_key, c.slack_bot_token, c.discord_bot_token, c.api_token, c.mongodb_uri]
    .filter((v): v is string => typeof v === 'string' && v.length >= 8);
}
export function summarizerProjection(job: ai.EngineerTask, now: number, secrets: string[] = knownBotSecrets()) {
  ai.requireEngineer(job.checks, 'facts_missing');
  const input = { goal: ai.redactEngineerText(job.input.goal, secrets), history: '',
    feedback: ai.redactEngineerText(job.input.feedback, secrets) };
  const checks = ai.validateChecks(job.checks, now);
  const task = publicEnvelope(job);
  return { task, input, checks, snapshot_digest: ai.digest({ task, input, checks }) };
}
function exactConclusionReceipt(job: ai.EngineerTask, claimId: unknown, snapshotDigest: unknown, result: unknown): boolean {
  if (!job.conclusion || job.state !== 'awaiting_operator' || job.summarizer !== null
    || job.summarizer_receipt !== claimId || job.summarizer_snapshot_digest !== snapshotDigest) return false;
  try { return ai.digest(job.conclusion) === ai.digest(ai.validateConclusion(result, job)); }
  catch { return false; }
}
function exactFailureReceipt(job: ai.EngineerTask, claimId: unknown, snapshotDigest: unknown, code: unknown): boolean {
  return job.state === 'failed' && job.summarizer === null && job.summarizer_receipt === claimId
    && job.summarizer_snapshot_digest === snapshotDigest && job.failure_code === code;
}
export interface BridgeDependencies {
  policy: () => ai.EngineerPolicy; store: EngineerStore;
  findClaim: (claimId: string) => Promise<EngineerTicket | null>;
  findQueued: (excluded: string[]) => Promise<EngineerTicket | null>;
  findSummarizer: (excluded: string[]) => Promise<EngineerTicket | null>;
  publishCatalog: typeof catalog.publishCatalog;
  bindingAllowed: typeof catalog.requireCatalogBinding;
  clock: () => number;
}
export function bridgeDependencies(): BridgeDependencies {
  return { policy: engineerPolicy, store: new EngineerStore(engineerPolicy),
    findClaim: async claimId => await db.Supportee.findOne({ $or: [
      { 'ai_engineer.collector.claim_id': claimId }, { 'ai_engineer.collector_receipt': claimId },
      { 'ai_engineer.summarizer.claim_id': claimId }, { 'ai_engineer.summarizer_receipt': claimId },
    ] }).lean() as unknown as EngineerTicket | null,
    findQueued: async excluded => {
      const now = Date.now(), policy = engineerPolicy(), canary = canarySelection(policy, now, excluded);
      if (canary === null) return null;
      const allowed = await catalog.readCatalog(policy.scope, now);
      if (!allowed.entries.length) return null;
      return await db.Supportee.findOne({ 'ai_engineer.scope': policy.scope,
        status: { $in: [...ai.ACTIVE_TICKETS] }, 'ai_engineer.request_id': { $nin: excluded },
        'ai_engineer.state': { $in: ['queued', 'collecting'] }, 'ai_engineer.projection_pending': null,
        'ai_engineer.policy_fingerprint': ai.policyFingerprint(policy),
        'ai_engineer.expires_at': { $gt: now }, ...canary, $and: [
          { $or: allowed.entries.map(b => ({ 'ai_engineer.binding.binding_id': b.binding_id,
            'ai_engineer.binding.binding_version': b.binding_version, 'ai_engineer.binding.profile_id': b.profile_id })) },
          { $or: [{ 'ai_engineer.collector': null }, { 'ai_engineer.collector.until': { $lte: now } }] },
          { $expr: { $and: [
            { $eq: [{ $ifNull: ['$ai_epoch', 0] }, '$ai_engineer.ticket_epoch'] },
            { $eq: [{ $ifNull: ['$assigned_to', null] }, '$ai_engineer.expected_owner'] },
          ] } },
        ] }).sort({ 'ai_engineer.created_at': 1 }).lean() as unknown as EngineerTicket | null;
    },
    findSummarizer: async excluded => {
      const now = Date.now(), policy = engineerPolicy(), canary = canarySelection(policy, now, excluded);
      if (canary === null) return null;
      const allowed = await catalog.readCatalog(policy.scope, now);
      if (!allowed.entries.length) return null;
      return await db.Supportee.findOne({ 'ai_engineer.scope': policy.scope,
        status: { $in: [...ai.ACTIVE_TICKETS] }, 'ai_engineer.request_id': { $nin: excluded },
        'ai_engineer.state': 'summarizing', 'ai_engineer.projection_pending': null,
        'ai_engineer.policy_fingerprint': ai.policyFingerprint(policy),
        'ai_engineer.expires_at': { $gt: now }, 'ai_engineer.attempts': { $lt: 2 }, ...canary, $and: [
          { $or: allowed.entries.map(b => ({ 'ai_engineer.binding.binding_id': b.binding_id,
            'ai_engineer.binding.binding_version': b.binding_version, 'ai_engineer.binding.profile_id': b.profile_id })) },
          { $or: [{ 'ai_engineer.summarizer': null }, { 'ai_engineer.summarizer.until': { $lte: now } }] },
          { 'ai_engineer.checks.facts': { $elemMatch: { observed_at: { $gte: now - ai.FACTS_MS } } } },
          { $expr: { $and: [
            { $eq: [{ $ifNull: ['$ai_epoch', 0] }, '$ai_engineer.ticket_epoch'] },
            { $eq: [{ $ifNull: ['$assigned_to', null] }, '$ai_engineer.expected_owner'] },
          ] } },
        ] }).sort({ 'ai_engineer.created_at': 1 }).lean() as unknown as EngineerTicket | null;
    },
    publishCatalog: catalog.publishCatalog, bindingAllowed: catalog.requireCatalogBinding, clock: Date.now };
}
export async function executeBridge(operation: string, payload: unknown, d: BridgeDependencies): Promise<unknown> {
  ai.requireEngineer((OPERATIONS as readonly string[]).includes(operation), 'operation_denied');
  ai.requireEngineer(ai.byteSize(payload) <= 24 * 1024, 'payload_too_large');
  const policy = d.policy(), now = d.clock();
  ai.requireEngineer(policy.enabled === true, 'feature_disabled');
  ai.requireEngineer(payload !== null && typeof payload === 'object' && !Array.isArray(payload), 'invalid_object');
  const p = payload as Record<string, unknown>;
  ai.requireEngineer(p.deployment_scope === policy.scope, 'scope_denied');
  const central = ['claim-summarizer', 'summarizer-status', 'publish-conclusion', 'fail-conclusion'].includes(operation);
  if (central) ai.requireEngineer(p.protocol === ai.CONCLUSION_PROTOCOL, 'protocol_denied');
  if (operation === 'claim-summarizer') {
    ai.exact(p, ['deployment_scope', 'protocol', 'claim_id']); ai.uuid(p.claim_id);
    const prior = await d.findClaim(p.claim_id);
    if (prior) {
      const ticket = await d.store.read(prior.ticketId), job = ticket.ai_engineer;
      ai.requireEngineer(job && ai.current(job, ticket, policy), 'authority_changed');
      ai.canaryWindow(policy, now);
      await d.bindingAllowed(policy.scope, job.binding, now);
      ai.requireEngineer(job.summarizer?.claim_id === p.claim_id && job.summarizer.until > now
        && job.expires_at > now && job.state === 'summarizing', 'lease_stale');
      const projection = summarizerProjection(job, now);
      ai.requireEngineer(job.summarizer_snapshot_digest === projection.snapshot_digest, 'snapshot_changed');
      return { protocol: ai.CONCLUSION_PROTOCOL, status: 'claimed', claim_id: p.claim_id,
        lease_until: job.summarizer.until, ...projection, execution_allowed: false };
    }
    ai.canaryWindow(policy, now);
    const excluded: string[] = [];
    for (let attempt = 0; attempt < 5; attempt++) {
      const ticket = await d.findSummarizer(excluded), job = ticket?.ai_engineer;
      if (!ticket || !job) break;
      excluded.push(job.request_id);
      if (!ai.current(job, ticket, policy)) { await d.store.repair(ticket.ticketId); continue; }
      try {
        await d.bindingAllowed(policy.scope, job.binding, now);
        const projection = summarizerProjection(job, now);
        const claimed = await d.store.claimSummarizer(ticket.ticketId, job.request_id, p.claim_id, projection.snapshot_digest);
        return { protocol: ai.CONCLUSION_PROTOCOL, status: 'claimed', claim_id: p.claim_id,
          lease_until: claimed.summarizer!.until, ...projection, execution_allowed: false };
      } catch (error) {
        if (!(error instanceof ai.EngineerError) || !['binding_unavailable', 'authority_changed', 'state_changed',
          'lease_busy', 'facts_stale'].includes(error.code)) throw error;
      }
    }
    return { protocol: ai.CONCLUSION_PROTOCOL, status: 'idle', execution_allowed: false };
  }
  if (['summarizer-status', 'publish-conclusion', 'fail-conclusion'].includes(operation)) {
    const base = ['deployment_scope', 'protocol', 'ticket_id', 'request_id', 'claim_id', 'revision',
      'authority_digest', 'policy_fingerprint', 'snapshot_digest'];
    ai.exact(p, operation === 'publish-conclusion' ? [...base, 'result']
      : operation === 'fail-conclusion' ? [...base, 'code'] : base);
    ai.uuid(p.request_id); ai.uuid(p.claim_id);
    ai.requireEngineer(Number.isSafeInteger(p.ticket_id) && Number(p.ticket_id) > 0, 'invalid_ticket');
    const ticket = await d.store.read(Number(p.ticket_id)), job = ticket.ai_engineer;
    ai.requireEngineer(job?.request_id === p.request_id && job.revision === p.revision
      && job.authority_digest === p.authority_digest && job.policy_fingerprint === p.policy_fingerprint,
    'result_binding_changed');
    // Accepted receipts are immutable. Recognize an exact replay before live
    // lease, catalog and facts checks so a lost response remains recoverable.
    if (operation === 'publish-conclusion' && exactConclusionReceipt(job, p.claim_id, p.snapshot_digest, p.result)) {
      return { protocol: ai.CONCLUSION_PROTOCOL, status: job.state, request_id: job.request_id,
        revision: job.revision, snapshot_digest: p.snapshot_digest, execution_allowed: false };
    }
    if (operation === 'fail-conclusion' && exactFailureReceipt(job, p.claim_id, p.snapshot_digest, p.code)) {
      return { protocol: ai.CONCLUSION_PROTOCOL, status: job.state, request_id: job.request_id,
        revision: job.revision, snapshot_digest: p.snapshot_digest, execution_allowed: false };
    }
    ai.requireEngineer(ai.current(job, ticket, policy), 'authority_changed');
    await d.bindingAllowed(policy.scope, job.binding, now);
    const projection = summarizerProjection(job, now);
    ai.requireEngineer(job.summarizer_snapshot_digest === p.snapshot_digest
      && projection.snapshot_digest === p.snapshot_digest, 'snapshot_changed');
    if (operation === 'summarizer-status') {
      const renewed = await d.store.renewSummarizer(Number(p.ticket_id), p.request_id, p.claim_id, p.snapshot_digest);
      return { protocol: ai.CONCLUSION_PROTOCOL, status: renewed.state, eligible: true,
        lease_until: renewed.summarizer!.until, task: publicEnvelope(renewed), snapshot_digest: p.snapshot_digest,
        execution_allowed: false };
    }
    if (operation === 'publish-conclusion') {
      const completed = await d.store.publishConclusion(Number(p.ticket_id), p.request_id, p.claim_id, p.result);
      return { protocol: ai.CONCLUSION_PROTOCOL, status: completed.state, request_id: completed.request_id,
        revision: completed.revision, snapshot_digest: p.snapshot_digest, execution_allowed: false };
    }
    ai.requireEngineer(p.code === 'model_unavailable' || p.code === 'model_output_invalid', 'failure_code_denied');
    const failed = await d.store.failConclusion(Number(p.ticket_id), p.request_id, p.claim_id, p.code);
    return { protocol: ai.CONCLUSION_PROTOCOL, status: failed.state, request_id: failed.request_id,
      revision: failed.revision, snapshot_digest: p.snapshot_digest, execution_allowed: false };
  }
  if (operation === 'publish-catalog') return d.publishCatalog(p, policy.scope, now);
  if (operation === 'claim-checks') {
    ai.exact(p, ['deployment_scope', 'claim_id']); ai.uuid(p.claim_id);
    const prior = await d.findClaim(p.claim_id);
    if (prior) {
      const ticket = await d.store.read(prior.ticketId), job = ticket.ai_engineer;
      ai.requireEngineer(job && ai.current(job, ticket, policy), 'authority_changed');
      ai.canaryWindow(policy, now);
      await d.bindingAllowed(policy.scope, job.binding, now);
      ai.requireEngineer(job.collector?.claim_id === p.claim_id && job.collector.until > now && job.expires_at > now, 'lease_stale');
      return { status: job.state, task: publicEnvelope(job), claim_id: p.claim_id, lease_until: job.collector.until, execution_allowed: false };
    }
    ai.canaryWindow(policy, now);
    const excluded: string[] = [];
    for (let attempt = 0; attempt < 5; attempt++) {
      const ticket = await d.findQueued(excluded), job = ticket?.ai_engineer;
      if (!ticket || !job) break;
      excluded.push(job.request_id);
      if (!ai.current(job, ticket, policy)) { await d.store.repair(ticket.ticketId); continue; }
      try {
        await d.bindingAllowed(policy.scope, job.binding, now);
        const claimed = await d.store.claim(ticket.ticketId, job.request_id, 'collector', p.claim_id);
        return { status: claimed.state, task: publicEnvelope(claimed), claim_id: p.claim_id,
          lease_until: claimed.collector!.until, execution_allowed: false };
      } catch (error) {
        if (!(error instanceof ai.EngineerError) || !['binding_unavailable', 'authority_changed', 'state_changed', 'lease_busy'].includes(error.code)) throw error;
      }
    }
    return { status: 'idle', execution_allowed: false };
  }
  if (operation === 'request-status') {
    ai.exact(p, ['deployment_scope', 'ticket_id', 'request_id', 'claim_id']);
    ai.uuid(p.request_id); ai.uuid(p.claim_id);
    ai.requireEngineer(Number.isSafeInteger(p.ticket_id) && Number(p.ticket_id) > 0, 'invalid_ticket');
    const ticket = await d.store.read(Number(p.ticket_id)), job = ticket.ai_engineer;
    ai.requireEngineer(job?.request_id === p.request_id && ai.current(job, ticket, policy), 'authority_changed');
    await d.bindingAllowed(policy.scope, job.binding, now);
    const valid = job.collector?.claim_id === p.claim_id && job.collector.until > now && job.expires_at > now && job.state === 'collecting';
    return { status: job.state, eligible: Boolean(valid), task: publicEnvelope(job), execution_allowed: false };
  }
  const expected = ['deployment_scope', 'ticket_id', 'request_id', 'claim_id', 'revision', 'authority_digest', 'policy_fingerprint'];
  ai.exact(p, operation === 'publish-checks' ? [...expected, 'result'] : expected);
  ai.uuid(p.request_id); ai.uuid(p.claim_id);
  ai.requireEngineer(Number.isSafeInteger(p.ticket_id) && Number(p.ticket_id) > 0, 'invalid_ticket');
  const ticket = await d.store.read(Number(p.ticket_id)), job = ticket.ai_engineer;
  ai.requireEngineer(job?.request_id === p.request_id && job.revision === p.revision
    && job.authority_digest === p.authority_digest && job.policy_fingerprint === p.policy_fingerprint, 'result_binding_changed');
  await d.bindingAllowed(policy.scope, job.binding, now);
  const result = operation === 'publish-checks' ? p.result : {
    status: 'failed', facts: [], unknowns: ['collector_cancelled'], completed_at: now, execution_allowed: false,
  };
  const completed = await d.store.publishChecks(Number(p.ticket_id), p.request_id, p.claim_id, result);
  return { status: completed.state, request_id: completed.request_id, revision: completed.revision, execution_allowed: false };
}

async function main(): Promise<void> {
  let connected = false;
  // The QGA guest wrapper has a 30s bound. A stuck DB operation must not leave
  // an orphaned CLI behind after its parent transport gives up.
  const watchdog = setTimeout(() => process.exit(1), 25_000); watchdog.unref();
  try {
    const operation = process.argv[2];
    ai.requireEngineer(process.argv.length === 3 && OPERATIONS.includes(operation as typeof OPERATIONS[number]), 'operation_denied');
    ai.requireEngineer(engineerPolicy().enabled, 'feature_disabled');
    let input = Buffer.alloc(0);
    for await (const chunk of process.stdin) {
      input = Buffer.concat([input, Buffer.from(chunk)]); ai.requireEngineer(input.length <= 24 * 1024, 'payload_too_large');
    }
    const payload = JSON.parse(input.toString('utf8'));
    await mongoose.connect(cache.config.mongodb_uri || process.env.MONGO_URI || 'mongodb://localhost:27017/support',
      { serverSelectionTimeoutMS: 5000 }); connected = true;
    await initializeEngineerIndexes();
    const result = await executeBridge(operation, payload, bridgeDependencies());
    ai.requireEngineer(ai.byteSize(result) <= 24 * 1024, 'response_too_large');
    process.stdout.write(JSON.stringify({ ok: true, result }));
  } catch (error) {
    // Never forward connection strings, stack traces or raw Mongo errors to transport.
    const code = error instanceof ai.EngineerError ? error.code : 'bridge_error';
    process.stdout.write(JSON.stringify({ ok: false, error: code })); process.exitCode = 1;
  } finally {
    try { if (connected) await mongoose.disconnect(); }
    catch { process.exitCode = 1; }
    finally { clearTimeout(watchdog); }
  }
}
if (require.main === module) void main();
