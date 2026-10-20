import { randomUUID } from 'crypto';
import * as db from './db';
import * as ai from './ai-engineer';
import { EngineerStore, initializeEngineerIndexes } from './ai-engineer-store';
import { engineerPolicy } from './ai-engineer-bridge';
import { getEngineerConclusion } from './addons/llm';
import { requireCatalogBinding, readCatalog } from './ai-engineer-catalog';
import { AsyncWorkTracker } from './async-work';
import * as log from './logger';
import { setEngineerReady } from './ai-engineer-readiness';
import { refreshStaffCard } from './ticket-ui';

export class EngineerWorker {
  private stopped = false;
  private busy = false;
  private activeRequest: AbortController | null = null;
  private repairCursor: unknown = null;
  private tracker = new AsyncWorkTracker();
  private store = new EngineerStore(engineerPolicy);

  async initialize(): Promise<void> {
    const policy = engineerPolicy();
    // Revoke ALL old work before the bounded repair loop. Otherwise a quick
    // disabled restart followed by re-enable could resurrect jobs beyond the
    // first batch when the configured policy fingerprint returns to its old value.
    // Never overwrite an outbox event, frozen outcome or continuation here.
    await db.Supportee.updateMany({ ai_engineer: { $ne: null },
      ...(policy.enabled ? { 'ai_engineer.policy_fingerprint': { $ne: ai.policyFingerprint(policy) } } : {}),
      $or: [{ 'ai_engineer.state': { $nin: [...ai.TERMINAL] } }, { 'ai_engineer.continuation': { $ne: null } }],
    }, { $inc: { ai_epoch: 1 } });
    if (policy.enabled) await initializeEngineerIndexes();
    // A coordinated restart is the role/feature-revocation boundary. Authority
    // comparison in repair invalidates tasks from older policy generations.
    await this.tick(false);
    setEngineerReady(engineerPolicy().enabled);
  }
  schedule(): void {
    if (!this.stopped && !this.busy) this.tracker.track(this.tick(), () => log.error('AI engineer worker unavailable'));
  }
  async stop(): Promise<void> {
    this.stopped = true; setEngineerReady(false); this.activeRequest?.abort();
    await this.tracker.drain(5000);
  }

  async tick(generate = true): Promise<void> {
    if (this.busy || this.stopped) return;
    this.busy = true;
    try {
      const policy = engineerPolicy(), fingerprint = ai.policyFingerprint(policy);
      const epochEqual = { $eq: [{ $ifNull: ['$ai_epoch', 0] }, '$ai_engineer.ticket_epoch'] };
      const now = Date.now();
      const maintenance: Record<string, unknown> = { ai_engineer: { $ne: null }, $or: [
        { 'ai_engineer.projection_pending': { $ne: null } },
        { 'ai_engineer.state': { $in: ['queued', 'collecting', 'summarizing'] }, 'ai_engineer.expires_at': { $lte: now } },
        { 'ai_engineer.state': 'summarizing', $and: [
          { $or: [{ 'ai_engineer.summarizer': null }, { 'ai_engineer.summarizer.until': { $lte: now } }] },
          { $or: [{ 'ai_engineer.attempts': { $gte: 2 } }, { 'ai_engineer.checks.facts.observed_at': { $lt: now - ai.FACTS_MS } }] },
        ] },
        { 'ai_engineer.state': { $nin: [...ai.TERMINAL] }, $or: [
          { 'ai_engineer.policy_fingerprint': { $ne: fingerprint } },
          { status: { $nin: [...ai.ACTIVE_TICKETS] } },
          { $expr: { $not: [epochEqual] } },
        ] },
        { 'ai_engineer.continuation': { $ne: null }, 'ai_engineer.policy_fingerprint': fingerprint, $expr: epochEqual },
      ] };
      let candidates = await db.Supportee.find({ ...maintenance,
        ...(this.repairCursor ? { _id: { $gt: this.repairCursor } } : {}),
      }).sort({ _id: 1 }).limit(10).lean();
      if (!candidates.length && this.repairCursor) {
        this.repairCursor = null;
        candidates = await db.Supportee.find(maintenance).sort({ _id: 1 }).limit(10).lean();
      }
      for (const ticket of candidates) {
        if (this.stopped) return;
        this.repairCursor = ticket._id;
        try {
          const job = await this.store.repair(ticket.ticketId);
          if (job?.continuation && !job.projection_pending && ai.current(job, ticket, engineerPolicy())) {
            await this.store.continueRevision(ticket.ticketId, job.request_id);
          }
        } catch { log.error('AI engineer state repair deferred'); }
      }
      if (!generate || !engineerPolicy().enabled || this.stopped) return;
      const catalog = await readCatalog(policy.scope);
      if (!catalog.entries.length) return;
      const candidate = await db.Supportee.findOne({ 'ai_engineer.state': 'summarizing',
        status: { $in: [...ai.ACTIVE_TICKETS] }, 'ai_engineer.scope': policy.scope,
        'ai_engineer.policy_fingerprint': fingerprint,
        'ai_engineer.projection_pending': null, 'ai_engineer.expires_at': { $gt: Date.now() },
        'ai_engineer.attempts': { $lt: 2 }, $and: [
          { $or: [{ 'ai_engineer.summarizer': null }, { 'ai_engineer.summarizer.until': { $lte: Date.now() } }] },
          { $or: catalog.entries.map(b => ({ 'ai_engineer.binding.binding_id': b.binding_id,
            'ai_engineer.binding.binding_version': b.binding_version, 'ai_engineer.binding.profile_id': b.profile_id })) },
          { $expr: { $and: [epochEqual,
            { $eq: [{ $ifNull: ['$assigned_to', null] }, '$ai_engineer.expected_owner'] },
          ] } },
        ] }).sort({ 'ai_engineer.created_at': 1 }).lean();
      if (!candidate?.ai_engineer) return;
      const request = candidate.ai_engineer.request_id, claim = randomUUID();
      let claimed = false;
      try {
        await requireCatalogBinding(engineerPolicy().scope, candidate.ai_engineer.binding);
        const job = await this.store.claim(candidate.ticketId, request, 'summarizer', claim); claimed = true;
        if (this.stopped) return;
        this.activeRequest = new AbortController();
        const result = await getEngineerConclusion(job, this.activeRequest.signal);
        if (this.stopped) return;
        await requireCatalogBinding(engineerPolicy().scope, job.binding);
        await this.store.publishConclusion(candidate.ticketId, request, claim, result);
        await refreshStaffCard(candidate.ticketId);
      } catch (error) {
        if (claimed && !this.stopped) {
          const code = error instanceof SyntaxError || (error instanceof ai.EngineerError
            && !['model_unavailable', 'authority_changed', 'lease_stale'].includes(error.code))
            ? 'model_output_invalid' : 'model_unavailable';
          await this.store.failConclusion(candidate.ticketId, request, claim, code).catch(() => undefined);
        }
      }
    } finally { this.activeRequest = null; this.busy = false; }
  }
}
