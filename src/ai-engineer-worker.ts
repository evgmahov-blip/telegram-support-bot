import * as db from './db';
import * as ai from './ai-engineer';
import { EngineerStore, initializeEngineerIndexes } from './ai-engineer-store';
import { engineerPolicy } from './ai-engineer-bridge';
import { AsyncWorkTracker } from './async-work';
import * as log from './logger';
import { setEngineerReady } from './ai-engineer-readiness';
import { refreshStaffCard } from './ticket-ui';

export class EngineerWorker {
  private stopped = false;
  private busy = false;
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
    await this.tick();
    setEngineerReady(engineerPolicy().enabled);
  }
  schedule(): void {
    if (!this.stopped && !this.busy) this.tracker.track(this.tick(), () => log.error('AI engineer worker unavailable'));
  }
  async stop(): Promise<void> {
    this.stopped = true; setEngineerReady(false);
    await this.tracker.drain(5000);
  }

  async tick(): Promise<void> {
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
          if (job) await refreshStaffCard(ticket.ticketId);
        } catch { log.error('AI engineer state repair deferred'); }
      }
    } finally { this.busy = false; }
  }
}
