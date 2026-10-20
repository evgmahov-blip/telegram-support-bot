import mongoose from 'mongoose';
import { randomUUID } from 'crypto';
import { Supportee } from './db';
import * as db from './db';
import * as task from './ai-engineer';
import type { EngineerTask, EngineerPolicy, TicketAuthority, Binding, TaskInput } from './ai-engineer';

export interface EngineerTicket extends TicketAuthority { ai_engineer?: EngineerTask | null }

// Created lazily: simply importing the disabled feature adds no collections/indexes.
function archiveModel(): mongoose.Model<any> {
  if (mongoose.models.AIEngineerRevision) return mongoose.models.AIEngineerRevision;
  const schema = new mongoose.Schema({
    scope: { type: String, required: true }, ticket_id: { type: Number, required: true },
    task_id: { type: String, required: true }, revision: { type: Number, required: true },
    request_id: { type: String, required: true }, digest: { type: String, required: true },
    payload: { type: mongoose.Schema.Types.Mixed, required: true },
    continuation: { type: mongoose.Schema.Types.Mixed, required: false },
    continuation_digest: { type: String, required: false },
  });
  schema.index({ scope: 1, ticket_id: 1, task_id: 1, revision: 1 }, { unique: true });
  schema.index({ scope: 1, request_id: 1 }, { unique: true });
  return mongoose.model('AIEngineerRevision', schema);
}
export async function initializeEngineerIndexes(): Promise<void> { await archiveModel().init(); }
export async function readEngineerRevision(scope: string, ticketId: number, taskId: string, revision: number): Promise<Record<string, any> | null> {
  task.requireEngineer(Number.isSafeInteger(revision) && revision > 0, 'invalid_revision');
  const stored = await archiveModel().findOne({ scope, ticket_id: ticketId, task_id: taskId, revision }).lean() as any;
  if (!stored) return null;
  task.requireEngineer(task.digest(stored.payload) === stored.digest, 'archive_conflict');
  return stored.payload;
}
export interface AdmissionFence {
  owner: string | null; epoch: number; base_request: string | null;
  draft?: { token: string; version: number; compose_version: number; actor: string; chat: string; thread: number | null };
}
function checkAdmission(ticket: EngineerTicket, fence?: AdmissionFence): void {
  if (!fence) return;
  task.requireEngineer((ticket.assigned_to ?? null) === fence.owner && (ticket.ai_epoch ?? 0) === fence.epoch
    && (ticket.ai_engineer?.request_id ?? null) === fence.base_request, 'authority_changed');
}
/** Applied in the SAME atomic write that admits a task/rework, after all awaits. */
export function admissionDraftFilter(draft: NonNullable<AdmissionFence['draft']>, now = new Date()): Record<string, unknown> {
  return { pending_reply_staff_id: draft.actor, pending_reply_chat_id: draft.chat,
    pending_reply_thread_id: draft.thread, pending_reply_kind: 'note',
    pending_reply_version: draft.compose_version, pending_reply_expires_at: { $gt: now },
    'ai_engineer_draft.token': draft.token, 'ai_engineer_draft.version': draft.version,
    'ai_engineer_draft.compose_version': draft.compose_version, 'ai_engineer_draft.step': 'preview' };
}

export interface EngineerPersistence {
  read(ticketId: number): Promise<EngineerTicket | null>;
  compareAndSet(ticket: EngineerTicket, previous: EngineerTask | null, next: EngineerTask, fence?: AdmissionFence): Promise<EngineerTicket | null>;
  archive(snapshot: Record<string, unknown>, continuation?: task.Continuation | null): Promise<void>;
  emit(ticketId: number, pending: task.Projection, requestId: string, revision: number): Promise<void>;
}

export const mongoEngineerPersistence: EngineerPersistence = {
  async read(ticketId) {
    const ticket = await Supportee.findOne({ ticketId }).lean();
    if (!ticket) return null;
    // Unlike the legacy convenience helper, errors here propagate: admission is fail-closed.
    const banned = await db.UserBan.exists({ userid: ticket.userid, messenger: ticket.messenger });
    return { ...ticket, ai_banned: Boolean(banned) } as unknown as EngineerTicket;
  },
  async compareAndSet(ticket, previous, next, fence) {
    const filter: Record<string, unknown> = { ticketId: ticket.ticketId, status: ticket.status,
      assigned_to: ticket.assigned_to ?? null,
      $expr: { $eq: [{ $ifNull: ['$ai_epoch', 0] }, ticket.ai_epoch ?? 0] } };
    if (previous) {
      filter['ai_engineer.request_id'] = previous.request_id;
      filter['ai_engineer.version'] = previous.version;
    } else filter.ai_engineer = null;
    if (fence?.draft) {
      Object.assign(filter, admissionDraftFilter(fence.draft));
    }
    return await Supportee.findOneAndUpdate(filter, { $set: { ai_engineer: next } }, { new: true }).lean() as unknown as EngineerTicket | null;
  },
  async archive(snapshot, continuation) {
    const model = archiveModel();
    const key = { scope: snapshot.scope, ticket_id: snapshot.ticket_id, task_id: snapshot.task_id, revision: snapshot.revision };
    const hash = task.digest(snapshot);
    try {
      await model.updateOne(key, { $setOnInsert: { ...key, request_id: snapshot.request_id, digest: hash, payload: snapshot } }, { upsert: true });
    } catch (err) {
      if ((err as { code?: number }).code !== 11000) throw err;
    }
    if (continuation) {
      await model.updateOne({ ...key, continuation_digest: { $exists: false } },
        { $set: { continuation, continuation_digest: task.digest(continuation) } });
    }
    const stored = await model.findOne(key).lean() as unknown as {
      digest: string; payload: unknown; continuation_digest?: string; continuation?: unknown;
    } | null;
    task.requireEngineer(stored && stored.digest === hash && task.digest(stored.payload) === hash, 'archive_conflict');
    if (continuation) task.requireEngineer(stored.continuation_digest === task.digest(continuation)
      && task.digest(stored.continuation) === task.digest(continuation), 'continuation_conflict');
  },
  async emit(ticketId, pending, requestId, revision) {
    await db.recordAIEngineerEvent(pending.event_id, pending.type, ticketId, pending.actor_id,
      { request_id: requestId, revision, projection_id: pending.id });
  },
};

/** No tool access: all side effects here are ticket state, immutable archive and audit. */
export class EngineerStore {
  constructor(private readonly policy: () => EngineerPolicy,
    private readonly persistence: EngineerPersistence = mongoEngineerPersistence,
    private readonly clock: () => number = Date.now) {}

  async read(ticketId: number): Promise<EngineerTicket> {
    task.requireEngineer(Number.isSafeInteger(ticketId) && ticketId > 0, 'invalid_ticket');
    const ticket = await this.persistence.read(ticketId);
    task.requireEngineer(ticket, 'ticket_missing');
    return ticket;
  }
  private access(ticket: EngineerTicket, actor: string) {
    task.requireEngineer(task.authorized(this.policy(), ticket, actor), 'not_authorized');
  }
  private async commit(ticket: EngineerTicket, previous: EngineerTask | null, next: EngineerTask, fence?: AdmissionFence): Promise<EngineerTask> {
    const updated = await this.persistence.compareAndSet(ticket, previous, next, fence);
    task.requireEngineer(updated?.ai_engineer, 'state_changed');
    return updated.ai_engineer;
  }
  async submit(ticketId: number, actor: string, binding: Binding, input: TaskInput,
    ids?: { task_id: string; request_id: string }, fence?: AdmissionFence): Promise<EngineerTask> {
    const ticket = await this.read(ticketId); this.access(ticket, actor);
    const previous = ticket.ai_engineer ?? null;
    if (ids && previous?.request_id === ids.request_id) {
      task.requireEngineer(task.current(previous, ticket, this.policy()) && previous.requested_by === actor
        && previous.input_digest === task.digest(task.snapshotInput(input.goal, input.history, input.feedback))
        && task.digest(previous.binding) === task.digest(binding), 'request_conflict');
      return previous;
    }
    checkAdmission(ticket, fence);
    if (previous) {
      // Starting fresh uses current admission, never the old worker's authority.
      // In particular, a transferred/closed-and-reopened task must not trap its new owner.
      task.requireEngineer(task.TERMINAL.has(previous.state) && !previous.projection_pending, 'task_exists');
      task.requireEngineer(!previous.continuation || !task.current(previous, ticket, this.policy()), 'continuation_exists');
      task.requireEngineer(!ids || ids.task_id === previous.task_id, 'task_changed');
      await this.persistence.archive(task.archiveSnapshot(previous), previous.continuation);
    }
    const nextIds = ids ?? (previous ? { task_id: previous.task_id, request_id: randomUUID() } : undefined);
    const next = task.createTask(ticket, this.policy(), actor, binding, input, this.clock(), nextIds, (previous?.revision ?? 0) + 1);
    return this.commit(ticket, previous, next, fence);
  }
  private async active(ticketId: number, requestId: string): Promise<{ ticket: EngineerTicket; job: EngineerTask }> {
    const ticket = await this.read(ticketId); const job = ticket.ai_engineer;
    task.requireEngineer(job?.request_id === requestId, 'request_changed');
    task.requireEngineer(task.current(job, ticket, this.policy()), 'authority_changed');
    return { ticket, job };
  }
  async claim(ticketId: number, requestId: string, stage: 'collector', claimId: string): Promise<EngineerTask> {
    const { ticket, job } = await this.active(ticketId, requestId);
    return this.commit(ticket, job, task.claim(job, stage, claimId, this.clock()));
  }
  async claimSummarizer(ticketId: number, requestId: string, claimId: string, snapshotDigest: string): Promise<EngineerTask> {
    const { ticket, job } = await this.active(ticketId, requestId);
    return this.commit(ticket, job, task.claim(job, 'summarizer', claimId, this.clock(), snapshotDigest));
  }
  async renewSummarizer(ticketId: number, requestId: string, claimId: string, snapshotDigest: string): Promise<EngineerTask> {
    const { ticket, job } = await this.active(ticketId, requestId);
    return this.commit(ticket, job, task.renewSummarizer(job, claimId, snapshotDigest, this.clock()));
  }
  async publishChecks(ticketId: number, requestId: string, claimId: string, result: unknown): Promise<EngineerTask> {
    const { ticket, job } = await this.active(ticketId, requestId);
    if (job.checks && job.collector_receipt === claimId && task.digest(job.checks) === task.digest(result) && job.collector === null) return job;
    return this.commit(ticket, job, task.finishChecks(job, claimId, result, this.clock()));
  }
  async publishConclusion(ticketId: number, requestId: string, claimId: string, result: unknown): Promise<EngineerTask> {
    const { ticket, job } = await this.active(ticketId, requestId);
    if (job.conclusion && job.summarizer_receipt === claimId && job.summarizer === null) {
      let normalized: task.Conclusion;
      try { normalized = task.validateConclusion(result, job); }
      catch { throw new task.EngineerError('result_conflict'); }
      task.requireEngineer(task.digest(job.conclusion) === task.digest(normalized), 'result_conflict');
      return job;
    }
    return this.commit(ticket, job, task.finishConclusion(job, claimId, result, this.clock()));
  }
  async failConclusion(ticketId: number, requestId: string, claimId: string,
    code: 'model_unavailable' | 'model_output_invalid'): Promise<EngineerTask> {
    const { ticket, job } = await this.active(ticketId, requestId);
    if (job.state === 'failed' && job.summarizer_receipt === claimId && job.failure_code === code
      && job.summarizer === null) return job;
    return this.commit(ticket, job, task.failConclusion(job, claimId, code, this.clock()));
  }
  async handoff(ticketId: number, requestId: string, actor: string): Promise<EngineerTask> {
    const { ticket, job } = await this.active(ticketId, requestId); this.access(ticket, actor);
    if (job.state === 'handed_off') return job;
    return this.commit(ticket, job, task.handoff(job, actor, this.clock()));
  }
  async rework(ticketId: number, requestId: string, actor: string, operationId: string, feedback: string, fence?: AdmissionFence): Promise<EngineerTask> {
    const { ticket, job } = await this.active(ticketId, requestId); this.access(ticket, actor);
    checkAdmission(ticket, fence);
    if (job.continuation?.operation_id === operationId) {
      task.requireEngineer(job.continuation.actor_id === actor && job.continuation.input.feedback === task.text(feedback, 1000), 'request_conflict');
      return job;
    }
    return this.commit(ticket, job, task.rework(job, actor, operationId, feedback, this.clock()), fence);
  }
  async cancel(ticketId: number, requestId: string, actor: string): Promise<EngineerTask> {
    const { ticket, job } = await this.active(ticketId, requestId); this.access(ticket, actor);
    if (job.state === 'cancelled') return job;
    return this.commit(ticket, job, task.cancel(job, actor, this.clock()));
  }
  /** Repair must run even when disabled, before any attempt at new work. */
  async repair(ticketId: number): Promise<EngineerTask | null> {
    let ticket = await this.read(ticketId); let job = ticket.ai_engineer;
    if (!job) return null;
    if (job.projection_pending) {
      await this.persistence.emit(ticketId, job.projection_pending, job.request_id, job.revision);
      await this.commit(ticket, job, task.acknowledge(job, job.projection_pending.id));
      ticket = await this.read(ticketId); job = ticket.ai_engineer!;
    }
    if (!task.TERMINAL.has(job.state)) {
      const now = this.clock();
      const code = !task.current(job, ticket, this.policy()) ? 'authority_changed'
        : job.expires_at <= now && ['queued', 'collecting', 'summarizing'].includes(job.state) ? 'request_expired'
        : job.state === 'summarizing' && (!job.summarizer || job.summarizer.until <= now) && job.attempts >= 2 ? 'attempts_exhausted'
        : job.state === 'summarizing' && (!job.summarizer || job.summarizer.until <= now)
          && job.checks?.facts.some(f => f.observed_at < now - task.FACTS_MS) ? 'facts_stale'
        : null;
      if (code) return this.commit(ticket, job, task.invalidate(job, now, code));
    }
    if (task.TERMINAL.has(job.state)) await this.persistence.archive(task.archiveSnapshot(job), job.continuation);
    return job;
  }
  async continueRevision(ticketId: number, requestId: string): Promise<EngineerTask> {
    const { ticket, job } = await this.active(ticketId, requestId);
    task.requireEngineer(task.TERMINAL.has(job.state) && !job.projection_pending && job.continuation, 'not_ready');
    const intent = job.continuation; this.access(ticket, intent.actor_id);
    await this.persistence.archive(task.archiveSnapshot(job), job.continuation);
    const next = task.createTask(ticket, this.policy(), intent.actor_id, job.binding, intent.input, this.clock(),
      { task_id: job.task_id, request_id: intent.request_id }, intent.revision);
    return this.commit(ticket, job, next);
  }
}
