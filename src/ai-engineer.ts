import { createHash, randomUUID } from 'crypto';

// No I/O or tools here: this is the deterministic task contract and state machine.
export const ACTIVE_TICKETS = ['open', 'waiting_user'] as const;
export type EngineerState = 'queued' | 'collecting' | 'summarizing' | 'awaiting_operator'
  | 'handed_off' | 'reworked' | 'failed' | 'cancelled' | 'stale';
export const TERMINAL = new Set<EngineerState>(['handed_off', 'reworked', 'failed', 'cancelled', 'stale']);
export const REQUEST_MS = 15 * 60_000;
export const COLLECTOR_MS = 180_000;
export const SUMMARIZER_MS = 120_000;
export const FACTS_MS = 5 * 60_000;
export const PROFILE = 'host-info-v1';
export const CONCLUSION_PROTOCOL = 'support-conclusion-v1';
export const GENERATION_BACKEND = 'ainoc-aor';

export class EngineerError extends Error {
  constructor(public readonly code: string) { super(code); this.name = 'EngineerError'; }
}
export function requireEngineer(ok: unknown, code: string): asserts ok {
  if (!ok) throw new EngineerError(code);
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map(k => `${JSON.stringify(k)}:${canonical(object[k])}`).join(',')}}`;
  }
  requireEngineer(value !== undefined && typeof value !== 'function', 'invalid_json');
  return JSON.stringify(value);
}
export const digest = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex');
export const byteSize = (value: unknown): number => Buffer.byteLength(canonical(value), 'utf8');
export function text(value: unknown, max: number): string {
  requireEngineer(typeof value === 'string', 'invalid_text');
  const result = value.replace(/\r\n?/g, '\n').trim();
  requireEngineer(result.length > 0 && result.length <= max
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(result), 'invalid_text');
  return result;
}
/** Conservative projection for operator-provided text; never load secret files. */
export function redactEngineerText(value: string, knownSecrets: string[] = []): string {
  let result = value;
  for (const secret of knownSecrets) if (secret && secret.length >= 8) result = result.split(secret).join('[REDACTED]');
  return result.replace(/-----BEGIN[^-]*PRIVATE KEY-----[\s\S]*?-----END[^-]*PRIVATE KEY-----/g, '[REDACTED]')
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[URL REDACTED]')
    .replace(/\b[A-Za-z0-9_.-]+:[^\s@]+@[^\s]+/g, '[CREDENTIAL REDACTED]')
    .replace(/\b\d{6,12}:[A-Za-z0-9_-]{20,}\b/g, '[REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[REDACTED]')
    .replace(/(?:password|passwd|пароль|token|api[_ -]?key|authorization|cookie|secret|секрет)\s*[:=]\s*[^\r\n]+/gi, '[CREDENTIAL REDACTED]');
}
export function exact(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  requireEngineer(value !== null && typeof value === 'object' && !Array.isArray(value), 'invalid_object');
  requireEngineer(Object.keys(value).sort().join('|') === [...keys].sort().join('|'), 'unexpected_fields');
}
export function uuid(value: unknown): asserts value is string {
  requireEngineer(typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value), 'invalid_uuid');
}
export const CANARY_SCHEMA = 'support-engineer-canary-admission-v1';
export const CANARY_MAX_MS = 60 * 60_000;
export const CANARY_MAX_BYTES = 2048;
/** Exact, owner-approved admission of ONE pre-created synthetic staff ticket request. */
export interface CanaryAdmission {
  schema: typeof CANARY_SCHEMA; deployment_scope: string; ticket_id: number; request_id: string; revision: number;
  expected_owner: string | null; ticket_epoch: number; requested_by: string;
  binding_id: string; binding_version: number; profile_id: typeof PROFILE;
  base_policy_digest: string; issued_at: number; expires_at: number;
}
/** Present only in canary mode. `error` set means fail-closed: nothing may be admitted or computed. */
export interface CanaryPolicy { admission: CanaryAdmission | null; error: string | null }
export interface EngineerPolicy {
  enabled: boolean;
  scope: string;
  staff: Array<{ telegram_id: string; role: 'admin' | 'supervisor' | 'agent' }>;
  canary?: CanaryPolicy | null;
}
/** Standard fingerprint; also the canary `base_policy_digest`. Unchanged for standard mode. */
export function basePolicyDigest(policy: EngineerPolicy): string {
  return digest({ enabled: policy.enabled, scope: policy.scope,
    staff: [...policy.staff].sort((a, b) => a.telegram_id.localeCompare(b.telegram_id)), profiles: [PROFILE],
    generation_backend: GENERATION_BACKEND, conclusion_protocol: CONCLUSION_PROTOCOL });
}
export const admissionFingerprint = (admission: CanaryAdmission): string => digest(admission);
// Not self-referential: the admission binds the base digest; this binds both. Time is
// deliberately excluded, so expiry never makes a task non-current for human control.
export function policyFingerprint(policy: EngineerPolicy): string {
  const base = basePolicyDigest(policy);
  if (!policy.canary) return base;
  const { admission, error } = policy.canary;
  return admission && !error ? digest({ mode: 'canary', base_policy_digest: base, admission_fingerprint: admissionFingerprint(admission) })
    : digest({ mode: 'canary', base_policy_digest: base, error: error || 'canary_admission_missing' });
}
const TELEGRAM_ID = /^[1-9][0-9]{0,19}$/;
export function validateCanaryAdmission(value: unknown, base: EngineerPolicy): CanaryAdmission {
  requireEngineer(value !== undefined && value !== null, 'canary_admission_missing');
  let size: number;
  try { size = byteSize(value); } catch { throw new EngineerError('canary_admission_invalid'); }
  requireEngineer(size <= CANARY_MAX_BYTES, 'canary_admission_oversize');
  try {
    exact(value, ['schema', 'deployment_scope', 'ticket_id', 'request_id', 'revision', 'expected_owner', 'ticket_epoch',
      'requested_by', 'binding_id', 'binding_version', 'profile_id', 'base_policy_digest', 'issued_at', 'expires_at']);
    uuid(value.request_id);
  } catch { throw new EngineerError('canary_admission_invalid'); }
  const v = value as unknown as CanaryAdmission, int = (n: unknown, min: number) => Number.isSafeInteger(n) && Number(n) >= min;
  requireEngineer(v.schema === CANARY_SCHEMA && int(v.ticket_id, 1) && int(v.revision, 1) && int(v.ticket_epoch, 0)
    && (v.expected_owner === null || (typeof v.expected_owner === 'string' && TELEGRAM_ID.test(v.expected_owner)))
    && typeof v.requested_by === 'string' && TELEGRAM_ID.test(v.requested_by)
    && typeof v.binding_id === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(v.binding_id) && int(v.binding_version, 1)
    && typeof v.base_policy_digest === 'string' && /^[0-9a-f]{64}$/.test(v.base_policy_digest), 'canary_admission_invalid');
  requireEngineer(v.profile_id === PROFILE, 'profile_denied');
  requireEngineer(v.deployment_scope === base.scope, 'scope_denied');
  requireEngineer(base.enabled === true && v.base_policy_digest === basePolicyDigest({ ...base, canary: null }), 'canary_policy_mismatch');
  requireEngineer(base.staff.some(s => s.telegram_id === v.requested_by), 'canary_actor_unknown');
  requireEngineer(int(v.issued_at, 1) && int(v.expires_at, 1) && v.expires_at > v.issued_at
    && v.expires_at - v.issued_at <= CANARY_MAX_MS, 'canary_ttl_invalid');
  return structuredClone(v);
}
/** Config → canary policy. Standard mode with a stray admission is ambiguous and fails closed. */
export function parseCanaryPolicy(mode: unknown, admission: unknown, base: EngineerPolicy): CanaryPolicy | null {
  const present = admission !== undefined && admission !== null;
  if (mode === undefined || mode === null || mode === 'standard') return present ? { admission: null, error: 'canary_mode_required' } : null;
  if (mode !== 'canary') return { admission: null, error: 'canary_mode_invalid' };
  try { return { admission: validateCanaryAdmission(admission, base), error: null }; }
  catch (error) { return { admission: null, error: error instanceof EngineerError ? error.code : 'canary_admission_invalid' }; }
}
/** Computational window. Absolute timestamps from config: a restart never extends it. */
export function canaryWindow(policy: EngineerPolicy, now: number): CanaryAdmission | null {
  if (!policy.canary) return null;
  const { admission, error } = policy.canary;
  requireEngineer(admission && !error, error || 'canary_admission_missing');
  requireEngineer(Number.isFinite(now) && now >= admission.issued_at, 'canary_not_started');
  requireEngineer(now < admission.expires_at, 'canary_expired');
  return admission;
}
type CanaryIdentity = Pick<EngineerTask, 'scope' | 'ticket_id' | 'request_id' | 'revision' | 'expected_owner'
  | 'ticket_epoch' | 'requested_by'> & { binding: Pick<Binding, 'binding_id' | 'binding_version' | 'profile_id'> };
/** Identity only (no clock). True for standard mode. */
export function canaryMatches(policy: EngineerPolicy, job: CanaryIdentity): boolean {
  if (!policy.canary) return true;
  const a = policy.canary.admission;
  if (!a || policy.canary.error) return false;
  return job.scope === a.deployment_scope && job.ticket_id === a.ticket_id
    && job.request_id === a.request_id && job.revision === a.revision && job.expected_owner === a.expected_owner
    && job.ticket_epoch === a.ticket_epoch && job.requested_by === a.requested_by
    && job.binding?.binding_id === a.binding_id && job.binding.binding_version === a.binding_version
    && job.binding.profile_id === a.profile_id;
}
export interface TicketAuthority {
  ticketId: number; status: string; assigned_to: string | null; ai_epoch?: number;
  ai_banned?: boolean;
}
export interface Binding { binding_id: string; binding_version: number; display_label: string; profile_id: typeof PROFILE }
export function validateBinding(value: unknown): Binding {
  exact(value, ['binding_id', 'binding_version', 'display_label', 'profile_id']);
  requireEngineer(typeof value.binding_id === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(value.binding_id), 'invalid_binding');
  requireEngineer(Number.isSafeInteger(value.binding_version) && Number(value.binding_version) > 0, 'invalid_binding');
  requireEngineer(value.profile_id === PROFILE, 'profile_denied');
  return { binding_id: value.binding_id, binding_version: Number(value.binding_version),
    display_label: text(value.display_label, 100), profile_id: PROFILE };
}
export interface Projection { id: string; event_id: string; type: string; actor_id: string; at: number }
export interface Lease { claim_id: string; until: number }
export interface Fact {
  ref: string; check_id: typeof PROFILE; observed_at: number;
  values: { reachable: boolean; uptime_seconds: number | null };
}
export interface CheckResult {
  status: 'completed' | 'partial' | 'denied' | 'failed'; facts: Fact[]; unknowns: string[];
  completed_at: number; execution_allowed: false;
}
export interface Conclusion {
  summary: string; verified_findings: Array<{ text: string; evidence_refs: string[] }>;
  hypotheses: string[]; unknowns: string[]; recommended_next_steps: string[]; customer_reply_draft: string;
}
export interface TaskInput { goal: string; history: string; feedback: string }
export interface Continuation { operation_id: string; request_id: string; revision: number; actor_id: string; input: TaskInput }
export interface EngineerTask {
  schema: 'support-engineer-task-v1'; scope: string; task_id: string; request_id: string;
  ticket_id: number; revision: number; version: number; ticket_epoch: number;
  requested_by: string; expected_owner: string | null; binding: Binding;
  policy_fingerprint: string; input: TaskInput; input_digest: string; authority_digest: string;
  created_at: number; expires_at: number; state: EngineerState;
  collector: Lease | null; summarizer: Lease | null; attempts: number;
  summarizer_snapshot_digest: string | null;
  collector_receipt: string | null; summarizer_receipt: string | null;
  checks: CheckResult | null; conclusion: Conclusion | null; failure_code: string | null;
  projection_pending: Projection | null; continuation: Continuation | null;
  execution_allowed: false;
}
export function authorized(policy: EngineerPolicy, ticket: TicketAuthority, actor: string): boolean {
  const role = policy.staff.find(member => member.telegram_id === actor)?.role;
  return policy.enabled === true && ticket.ai_banned !== true && ACTIVE_TICKETS.includes(ticket.status as typeof ACTIVE_TICKETS[number])
    && (role === 'admin' || role === 'supervisor' || (role === 'agent' && ticket.assigned_to === actor));
}
export function current(task: EngineerTask, ticket: TicketAuthority, policy: EngineerPolicy): boolean {
  return task.ticket_id === ticket.ticketId && task.ticket_epoch === (ticket.ai_epoch ?? 0)
    && task.expected_owner === (ticket.assigned_to ?? null) && task.scope === policy.scope
    && task.policy_fingerprint === policyFingerprint(policy) && canaryMatches(policy, task)
    && authorized(policy, ticket, task.requested_by);
}
export function snapshotInput(goal: unknown, history: unknown = '', feedback: unknown = ''): TaskInput {
  requireEngineer(typeof history === 'string' && typeof feedback === 'string', 'invalid_text');
  const result = { goal: text(goal, 2000), history, feedback: feedback ? text(feedback, 1000) : '' };
  requireEngineer(byteSize(result) <= 8192, 'context_too_large');
  return result;
}
export function projection(request: string, version: number, type: string, actor: string, now: number): Projection {
  return { id: digest({ request, version, type }), event_id: randomUUID(), type, actor_id: actor, at: now };
}
export function createTask(ticket: TicketAuthority, policy: EngineerPolicy, actor: string, binding: Binding,
  input: TaskInput, now: number, ids: { task_id: string; request_id: string } = { task_id: randomUUID(), request_id: randomUUID() },
  revision = 1): EngineerTask {
  requireEngineer(authorized(policy, ticket, actor), 'not_authorized');
  requireEngineer(/^[a-z][a-z0-9-]{0,63}$/.test(policy.scope), 'invalid_scope');
  uuid(ids.task_id); uuid(ids.request_id);
  requireEngineer(Number.isSafeInteger(ticket.ticketId) && ticket.ticketId > 0
    && Number.isSafeInteger(revision) && revision > 0 && Number.isFinite(now), 'invalid_identity');
  const validatedBinding = validateBinding(binding);
  const validatedInput = snapshotInput(input.goal, input.history, input.feedback);
  // Canary: only the one admitted tuple, inside its window; task TTL never outlives the admission.
  const admission = canaryWindow(policy, now);
  requireEngineer(canaryMatches(policy, { scope: policy.scope, ticket_id: ticket.ticketId, request_id: ids.request_id, revision,
    expected_owner: ticket.assigned_to ?? null, ticket_epoch: ticket.ai_epoch ?? 0, requested_by: actor,
    binding: validatedBinding }), 'canary_not_admitted');
  const expires = admission ? Math.min(now + REQUEST_MS, admission.expires_at) : now + REQUEST_MS;
  const authority = { ticket_id: ticket.ticketId, epoch: ticket.ai_epoch ?? 0, owner: ticket.assigned_to ?? null,
    actor, binding: validatedBinding, request_id: ids.request_id, revision, policy: policyFingerprint(policy), expires_at: expires };
  return { schema: 'support-engineer-task-v1', scope: policy.scope, ...ids, ticket_id: ticket.ticketId,
    revision, version: 1, ticket_epoch: ticket.ai_epoch ?? 0, requested_by: actor,
    expected_owner: ticket.assigned_to ?? null, binding: validatedBinding, policy_fingerprint: policyFingerprint(policy),
    input: validatedInput, input_digest: digest(validatedInput), authority_digest: digest(authority),
    created_at: now, expires_at: expires, state: 'queued', collector: null, summarizer: null, attempts: 0,
    summarizer_snapshot_digest: null,
    checks: null, conclusion: null, failure_code: null, continuation: null, execution_allowed: false,
    collector_receipt: null, summarizer_receipt: null,
    projection_pending: projection(ids.request_id, 1, 'ai.task_submitted', actor, now) };
}
function ready(task: EngineerTask, now: number, computational = true): void {
  requireEngineer(!task.projection_pending, 'projection_pending');
  if (computational) requireEngineer(task.expires_at > now, 'request_expired');
  requireEngineer(task.execution_allowed === false, 'execution_denied');
}
function changed(task: EngineerTask, patch: Partial<EngineerTask>, type?: string, actor = task.requested_by, now = Date.now()): EngineerTask {
  const version = task.version + 1;
  return { ...task, ...patch, version, projection_pending: type ? projection(task.request_id, version, type, actor, now) : null };
}
export function acknowledge(task: EngineerTask, id: string): EngineerTask {
  requireEngineer(task.projection_pending?.id === id, 'projection_changed');
  return changed(task, {});
}
export function claim(task: EngineerTask, stage: 'collector' | 'summarizer', claimId: string, now: number,
  snapshotDigest?: string): EngineerTask {
  ready(task, now); uuid(claimId);
  requireEngineer(stage === 'collector' || stage === 'summarizer', 'invalid_stage');
  const state = stage === 'collector' ? 'collecting' : 'summarizing';
  requireEngineer(stage === 'collector' ? ['queued', 'collecting'].includes(task.state) : task.state === state, 'invalid_state');
  requireEngineer(!task[stage] || task[stage]!.until <= now, 'lease_busy');
  if (stage === 'summarizer') {
    requireEngineer(typeof snapshotDigest === 'string' && /^[0-9a-f]{64}$/.test(snapshotDigest), 'snapshot_invalid');
    requireEngineer(task.attempts < 2, 'attempts_exhausted');
    requireEngineer(task.checks && ['completed', 'partial'].includes(task.checks.status), 'facts_missing');
    requireEngineer(task.checks.facts.length > 0 && task.checks.facts.every(f => f.observed_at >= now - FACTS_MS), 'facts_stale');
  }
  const until = stage === 'summarizer'
    ? Math.min(now + SUMMARIZER_MS, task.expires_at, ...task.checks!.facts.map(f => f.observed_at + FACTS_MS))
    // Publication after task expiry is rejected anyway; never lease past it.
    : Math.min(now + COLLECTOR_MS, task.expires_at);
  return changed(task, { state, [stage]: { claim_id: claimId, until },
    attempts: task.attempts + (stage === 'summarizer' ? 1 : 0),
    ...(stage === 'summarizer' ? { summarizer_snapshot_digest: snapshotDigest! } : {}) });
}
export function renewSummarizer(task: EngineerTask, claimId: string, snapshotDigest: string, now: number): EngineerTask {
  ready(task, now); uuid(claimId);
  requireEngineer(task.state === 'summarizing' && task.summarizer?.claim_id === claimId
    && task.summarizer.until > now, 'lease_stale');
  requireEngineer(task.summarizer_snapshot_digest === snapshotDigest, 'snapshot_changed');
  requireEngineer(task.checks && task.checks.facts.length > 0, 'facts_missing');
  const factsUntil = Math.min(...task.checks.facts.map(f => f.observed_at + FACTS_MS));
  const until = Math.min(now + SUMMARIZER_MS, task.expires_at, factsUntil);
  requireEngineer(until > now, 'facts_stale');
  return changed(task, { summarizer: { claim_id: claimId, until } });
}
function lease(task: EngineerTask, stage: 'collector' | 'summarizer', claimId: string, now: number): void {
  ready(task, now);
  requireEngineer(task[stage]?.claim_id === claimId && task[stage]!.until > now, 'lease_stale');
}
export function validateChecks(value: unknown, now: number): CheckResult {
  exact(value, ['status', 'facts', 'unknowns', 'completed_at', 'execution_allowed']);
  requireEngineer(value.execution_allowed === false && ['completed', 'partial', 'denied', 'failed'].includes(String(value.status)), 'invalid_checks');
  requireEngineer(typeof value.completed_at === 'number' && value.completed_at <= now + 5000
    && value.completed_at >= now - FACTS_MS, 'facts_stale');
  requireEngineer(Array.isArray(value.facts) && value.facts.length <= 1 && Array.isArray(value.unknowns)
    && value.unknowns.length <= 10 && byteSize(value) <= 8192, 'invalid_checks');
  const facts = value.facts.map((f: unknown) => {
    exact(f, ['ref', 'check_id', 'observed_at', 'values']);
    exact(f.values, ['reachable', 'uptime_seconds']);
    requireEngineer(f.ref === 'check-1' && f.check_id === PROFILE && typeof f.observed_at === 'number'
      && f.observed_at <= now + 5000 && f.observed_at >= now - FACTS_MS, 'invalid_fact');
    requireEngineer(typeof f.values.reachable === 'boolean' && (f.values.uptime_seconds === null
      || (typeof f.values.uptime_seconds === 'number' && Number.isSafeInteger(f.values.uptime_seconds) && f.values.uptime_seconds >= 0)), 'invalid_fact');
    return structuredClone(f) as unknown as Fact;
  });
  requireEngineer(!['completed', 'partial'].includes(String(value.status)) || facts.length > 0, 'facts_missing');
  requireEngineer(!['denied', 'failed'].includes(String(value.status)) || facts.length === 0, 'invalid_checks');
  return { status: value.status as CheckResult['status'], facts, unknowns: value.unknowns.map(v => text(v, 300)),
    completed_at: value.completed_at, execution_allowed: false };
}
export function finishChecks(task: EngineerTask, claimId: string, result: unknown, now: number): EngineerTask {
  lease(task, 'collector', claimId, now); requireEngineer(task.state === 'collecting', 'invalid_state');
  const checks = validateChecks(result, now);
  const denied = ['denied', 'failed'].includes(checks.status);
  return changed(task, { checks, state: denied ? 'failed' : 'summarizing', collector: null,
    collector_receipt: claimId,
    failure_code: denied ? `checks_${checks.status}` : null }, denied ? 'ai.failed' : 'ai.checks_completed', task.requested_by, now);
}
export function validateConclusion(value: unknown, task: EngineerTask): Conclusion {
  exact(value, ['summary', 'verified_findings', 'hypotheses', 'unknowns', 'recommended_next_steps', 'customer_reply_draft']);
  requireEngineer(byteSize(value) <= 12 * 1024 && Array.isArray(value.verified_findings)
    && value.verified_findings.length <= 10, 'invalid_conclusion');
  const refs = new Set(task.checks?.facts.map(f => f.ref));
  const findings = value.verified_findings.map((f: unknown) => {
    exact(f, ['text', 'evidence_refs']);
    requireEngineer(Array.isArray(f.evidence_refs) && f.evidence_refs.length > 0
      && f.evidence_refs.every(r => typeof r === 'string' && refs.has(r)), 'evidence_unknown');
    return { text: text(f.text, 1000), evidence_refs: [...f.evidence_refs] as string[] };
  });
  const list = (v: unknown) => { requireEngineer(Array.isArray(v) && v.length <= 10, 'invalid_conclusion'); return v.map(x => text(x, 1000)); };
  return { summary: text(value.summary, 2000), verified_findings: findings, hypotheses: list(value.hypotheses),
    unknowns: list(value.unknowns), recommended_next_steps: list(value.recommended_next_steps),
    customer_reply_draft: text(value.customer_reply_draft, 2000) };
}
export function finishConclusion(task: EngineerTask, claimId: string, result: unknown, now: number): EngineerTask {
  lease(task, 'summarizer', claimId, now); requireEngineer(task.state === 'summarizing', 'invalid_state');
  requireEngineer(task.checks?.facts.every(f => f.observed_at >= now - FACTS_MS), 'facts_stale');
  return changed(task, { state: 'awaiting_operator', summarizer: null, summarizer_receipt: claimId, conclusion: validateConclusion(result, task) },
    'ai.conclusion_created', task.requested_by, now);
}
export function failConclusion(task: EngineerTask, claimId: string, code: 'model_unavailable' | 'model_output_invalid', now: number): EngineerTask {
  lease(task, 'summarizer', claimId, now); requireEngineer(task.state === 'summarizing', 'invalid_state');
  return changed(task, { state: 'failed', summarizer: null, summarizer_receipt: claimId, failure_code: code },
    'ai.failed', task.requested_by, now);
}
export function handoff(task: EngineerTask, actor: string, now: number): EngineerTask {
  ready(task, now, false); requireEngineer(task.state === 'awaiting_operator', 'invalid_state');
  return changed(task, { state: 'handed_off' }, 'ai.handed_off', actor, now);
}
export function rework(task: EngineerTask, actor: string, operationId: string, feedback: string, now: number): EngineerTask {
  uuid(operationId);
  if (task.continuation?.operation_id === operationId) return task;
  ready(task, now, false); requireEngineer(task.state === 'awaiting_operator' || TERMINAL.has(task.state), 'invalid_state');
  requireEngineer(!task.continuation, 'continuation_exists');
  const continuation: Continuation = { operation_id: operationId, request_id: randomUUID(), revision: task.revision + 1, actor_id: actor,
    input: snapshotInput(task.input.goal, task.input.history, text(feedback, 1000)) };
  return changed(task, { continuation, state: task.state === 'awaiting_operator' ? 'reworked' : task.state },
    'ai.rework_requested', actor, now);
}
export function invalidate(task: EngineerTask, now: number, code: 'authority_changed' | 'request_expired' | 'attempts_exhausted' | 'facts_stale'): EngineerTask {
  requireEngineer(!task.projection_pending && !TERMINAL.has(task.state), 'invalid_state');
  return changed(task, { state: code === 'authority_changed' ? 'stale' : 'failed', failure_code: code, collector: null, summarizer: null },
    code === 'authority_changed' ? 'ai.stale' : 'ai.failed', task.requested_by, now);
}
export function cancel(task: EngineerTask, actor: string, now: number): EngineerTask {
  requireEngineer(!task.projection_pending && !TERMINAL.has(task.state), 'invalid_state');
  return changed(task, { state: 'cancelled', collector: null, summarizer: null }, 'ai.cancelled', actor, now);
}
export function archiveSnapshot(task: EngineerTask): Record<string, unknown> {
  requireEngineer(TERMINAL.has(task.state), 'not_terminal');
  const { version, collector, summarizer, projection_pending, continuation, ...snapshot } = task;
  return structuredClone(snapshot);
}
