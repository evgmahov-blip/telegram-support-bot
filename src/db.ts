import mongoose from 'mongoose';
import { randomUUID } from 'crypto';
import cache from './cache';
import { Messenger, TicketPriority } from './interfaces';
import * as log from './logger'
import { isManualRecipient, MANUAL_USER_PREFIX } from './manual-ticket-guard';

// Lazy config accessors — defer reading cache.config until runtime
// to avoid circular module initialization issues (index → migrate → db → cache)
function getMongoUri(): string {
  return cache.config?.mongodb_uri || process.env.MONGO_URI || 'mongodb://localhost:27017/support';
}

function getCollectionName(): string {
  return process.env.MONGO_COLLECTION || `bot_${cache.config?.owner_id || 'support'}`;
}

export type TicketStatus = 'open' | 'waiting_user' | 'closed';

export interface ISupportee extends mongoose.Document {
  ticketId: number;
  userid: string;
  internalIds: Array<number> | null;
  name: string | null;
  messenger: Messenger;
  status: TicketStatus;
  category: string | null;
  // Team collaboration fields
  assigned_to: string | null;
  tags: string[];
  priority: TicketPriority;
  // AI triage fields
  triage_category: string | null;
  triage_summary: string | null;
  sentiment_score: number | null;
  // Analytics fields
  first_response_at: Date | null;
  closed_at: Date | null;
  created_at: Date;
  updated_at: Date;
  staff_card_chat_id: string | null;
  staff_card_message_id: number | null;
  staff_card_thread_id: number | null;
  pending_reply_prompt_id: number | null;
  pending_reply_staff_id: string | null;
  pending_reply_expires_at: Date | null;
  pending_reply_kind: 'reply' | 'note' | null;
  staff_card_claim: string | null;
  staff_card_claimed_at: Date | null;
  pending_action_token: string | null;
  pending_action_type: string | null;
  pending_action_expires_at: Date | null;
  pending_action_actor_id: string | null;
  pending_new_request: boolean;
  // Manual external tickets (phone/email/in-person): staff-only intake data, no client transport.
  manual_source: ManualSource | null;
  external_client: string | null;
  external_contact: string | null;
  created_by: string | null;
  manual_request_key: string | null;
}

export type ManualSource = 'phone' | 'email' | 'in_person' | 'other';
export const MANUAL_SOURCES: ManualSource[] = ['phone', 'email', 'in_person', 'other'];

export const SupporteeSchema = new mongoose.Schema<ISupportee>({
  ticketId: { type: Number, required: true, unique: true, alias: 'id' },
  userid: { type: String, required: true },
  internalIds: { type: [Number], required: false },
  name: { type: String, required: false },
  messenger: { type: String, required: true },
  status: { type: String, enum: ['open', 'waiting_user', 'closed'], default: 'open' },
  category: { type: String, default: null },
  assigned_to: { type: String, default: null },
  tags: { type: [String], default: [] },
  priority: { type: String, enum: ['low', 'normal', 'high', 'urgent'], default: 'normal' as TicketPriority },
  triage_category: { type: String, default: null },
  triage_summary: { type: String, default: null },
  sentiment_score: { type: Number, default: null },
  first_response_at: { type: Date, default: null },
  closed_at: { type: Date, default: null },
  staff_card_chat_id: { type: String, default: null },
  staff_card_message_id: { type: Number, default: null },
  staff_card_thread_id: { type: Number, default: null },
  pending_reply_prompt_id: { type: Number, default: null },
  pending_reply_staff_id: { type: String, default: null },
  pending_reply_expires_at: { type: Date, default: null },
  pending_reply_kind: { type: String, enum: ['reply', 'note'], default: null },
  staff_card_claim: { type: String, default: null },
  staff_card_claimed_at: { type: Date, default: null },
  pending_action_token: { type: String, default: null },
  pending_action_type: { type: String, default: null },
  pending_action_expires_at: { type: Date, default: null },
  pending_action_actor_id: { type: String, default: null },
  pending_new_request: { type: Boolean, default: false },
  manual_source: { type: String, enum: MANUAL_SOURCES, default: null },
  external_client: { type: String, default: null },
  external_contact: { type: String, default: null },
  created_by: { type: String, default: null },
  manual_request_key: { type: String, required: false },
}, {
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
});

SupporteeSchema.index({ userid: 1, messenger: 1, ticketId: -1 });
SupporteeSchema.index({ internalIds: 1 });
SupporteeSchema.index({ status: 1, category: 1, assigned_to: 1 });
// One confirmed intake draft can never produce a second ticket, even across crash/retry.
SupporteeSchema.index(
  { manual_request_key: 1 },
  { unique: true, partialFilterExpression: { manual_request_key: { $type: 'string' } } },
);

const Supportee = mongoose.model(getCollectionName(), SupporteeSchema);

export { Supportee };

// --- New collections for team collaboration & analytics ---

export interface ITicketMessage extends mongoose.Document {
  ticketId: number;
  sender: 'user' | 'staff' | 'ai';
  sender_id: string;
  text: string;
  timestamp: Date;
  delivery_key?: string | null;
  delivered_at?: Date | null;
}

const TicketMessageSchema = new mongoose.Schema<ITicketMessage>({
  ticketId: { type: Number, required: true },
  sender: { type: String, enum: ['user', 'staff', 'ai'], required: true },
  sender_id: { type: String, default: '' },
  text: { type: String, required: true },
  timestamp: { type: Date, default: Date.now },
  delivery_key: { type: String, required: false },
  delivered_at: { type: Date, default: null },
});
TicketMessageSchema.index({ ticketId: 1, timestamp: -1 });
TicketMessageSchema.index(
  { delivery_key: 1 },
  { unique: true, partialFilterExpression: { delivery_key: { $type: 'string' } } },
);

const TicketMessage = mongoose.model('TicketMessage', TicketMessageSchema);

export interface IAnalyticsEvent extends mongoose.Document {
  event_id?: string;
  seq?: number;
  type: string;
  ticketId: number;
  timestamp: Date;
  agent_id: string | null;
  metadata: Record<string, any>;
}

const AnalyticsEventSchema = new mongoose.Schema<IAnalyticsEvent>({
  event_id: { type: String, required: false },
  seq: { type: Number, required: false },
  type: { type: String, required: true },
  ticketId: { type: Number, required: true },
  timestamp: { type: Date, default: Date.now },
  agent_id: { type: String, default: null },
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
});
AnalyticsEventSchema.index({ event_id: 1 }, { unique: true, sparse: true });
AnalyticsEventSchema.index({ seq: 1 }, { unique: true, sparse: true });
AnalyticsEventSchema.index({ ticketId: 1, timestamp: -1 });

const AnalyticsEvent = mongoose.model('AnalyticsEvent', AnalyticsEventSchema);

export interface IWebhookCursor extends mongoose.Document {
  subscriber_id: string;
  last_seq: number;
  created_at: Date;
  updated_at: Date;
}

const WebhookCursorSchema = new mongoose.Schema<IWebhookCursor>({
  subscriber_id: { type: String, required: true },
  last_seq: { type: Number, required: true, default: 0 },
}, {
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
});
WebhookCursorSchema.index({ subscriber_id: 1 }, { unique: true });

const WebhookCursor = mongoose.model('WebhookCursor', WebhookCursorSchema);

export interface IInternalNote extends mongoose.Document {
  ticketId: number;
  author_id: string;
  text: string;
  timestamp: Date;
  delivery_key?: string | null;
}

const InternalNoteSchema = new mongoose.Schema<IInternalNote>({
  ticketId: { type: Number, required: true },
  author_id: { type: String, required: true },
  text: { type: String, required: true },
  timestamp: { type: Date, default: Date.now },
  delivery_key: { type: String, required: false },
});
InternalNoteSchema.index({ ticketId: 1, timestamp: -1 });
InternalNoteSchema.index(
  { delivery_key: 1 },
  { unique: true, partialFilterExpression: { delivery_key: { $type: 'string' } } },
);

const InternalNote = mongoose.model('InternalNote', InternalNoteSchema);

interface ITicketCounter {
  _id: string;
  seq: number;
}

const TicketCounterSchema = new mongoose.Schema<ITicketCounter>({
  _id: { type: String, required: true },
  seq: { type: Number, required: true, default: 0 },
});

const TicketCounter = mongoose.model('TicketCounter', TicketCounterSchema);

export interface IUserBan extends mongoose.Document {
  userid: string;
  messenger: string;
  created_at: Date;
  updated_at: Date;
}

const UserBanSchema = new mongoose.Schema<IUserBan>({
  userid: { type: String, required: true },
  messenger: { type: String, required: true },
}, {
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
});
UserBanSchema.index({ messenger: 1, userid: 1 }, { unique: true });

const UserBan = mongoose.model('UserBan', UserBanSchema);

/**
 * Short-lived staff intake state for «Создать заявку вручную». It is not a
 * ticket: a draft that is never confirmed must not appear in ticket lists, so
 * it cannot live in Supportee. Rows self-expire through the purge_at TTL index.
 */
export type ManualDraftStatus = 'source' | 'input' | 'form' | 'preview' | 'creating' | 'created' | 'cancelled';
export type ManualDraftStep = 'client' | 'description' | 'contact' | null;

export interface IManualIntakeDraft extends mongoose.Document {
  token: string;
  actor_id: string;
  chat_id: string;
  thread_id: number | null;
  status: ManualDraftStatus;
  step: ManualDraftStep;
  version: number;
  source: ManualSource | null;
  prompt_message_id: number | null;
  confirm_nonce: string | null;
  client: string | null;
  contact: string | null;
  description: string | null;
  ticketId: number | null;
  last_consumed_message_id: number | null;
  edit_return: boolean;
  expires_at: Date;
  purge_at: Date;
}

const ManualIntakeDraftSchema = new mongoose.Schema<IManualIntakeDraft>({
  token: { type: String, required: true },
  actor_id: { type: String, required: true },
  chat_id: { type: String, required: true },
  thread_id: { type: Number, default: null },
  status: { type: String, enum: ['source', 'input', 'form', 'preview', 'creating', 'created', 'cancelled'], required: true },
  step: { type: String, enum: ['client', 'description', 'contact', null], default: null },
  version: { type: Number, default: 0, required: true },
  source: { type: String, enum: MANUAL_SOURCES, default: null },
  prompt_message_id: { type: Number, default: null },
  confirm_nonce: { type: String, default: null },
  client: { type: String, default: null },
  contact: { type: String, default: null },
  description: { type: String, default: null },
  ticketId: { type: Number, default: null },
  last_consumed_message_id: { type: Number, default: null },
  edit_return: { type: Boolean, default: false },
  expires_at: { type: Date, required: true },
  purge_at: { type: Date, required: true },
});
ManualIntakeDraftSchema.index({ token: 1 }, { unique: true });
ManualIntakeDraftSchema.index({ chat_id: 1, prompt_message_id: 1 });
ManualIntakeDraftSchema.index({ actor_id: 1, status: 1 });
ManualIntakeDraftSchema.index({ purge_at: 1 }, { expireAfterSeconds: 0 });

const ManualIntakeDraft = mongoose.model('ManualIntakeDraft', ManualIntakeDraftSchema);

export async function connect() {
  mongoose.connection.on('open', () => {
    log.info('Connected to mongo server.');
  });

  mongoose.connection.on('error', (err) => {
    log.info('Could not connect to mongo server!', err);
    process.exit(1);
  });

  const connection = await mongoose.connect(getMongoUri(), {
    serverSelectionTimeoutMS: 5000,
  });

  try {
    await backfillLegacyEvents();
  } catch (err) {
    log.error('Legacy event backfill failed; replay may have gaps:', err);
  }
  return connection;
}

/** Methods **/

export const getNextTicketId = async (): Promise<number> => {
  const lastEntry = await Supportee.findOne()
    .sort({ ticketId: -1 })
    .select('ticketId');
  const dbMax = lastEntry ? lastEntry.ticketId : 0;
  const baseline = Math.max(dbMax, cache.recoveryBaseline || 0);
  const counterId = `${getCollectionName()}:ticketId`;

  // Bring the counter up to at least the highest known ticket ID.
  await TicketCounter.findOneAndUpdate(
    { _id: counterId },
    { $max: { seq: baseline } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  // Atomic increment: concurrent ticket creation receives unique IDs.
  const counter = await TicketCounter.findOneAndUpdate(
    { _id: counterId },
    { $inc: { seq: 1 } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  if (!counter) throw new Error('Failed to allocate ticket ID');
  return counter.seq;
};

const MAX_EVENT_APPEND_RETRIES = 25;
const LEGACY_EVENT_BATCH_SIZE = 1000;
const LEGACY_EVENT_BACKFILL_MARKER = 'legacyEventBackfillV3';
const LEGACY_EVENT_TYPES: Record<string, string> = {
  ticket_created: 'ticket.created',
  ticket_closed: 'ticket.closed',
  ticket_escalated: 'ticket.escalated',
  staff_reply: 'ticket.replied',
  first_reply: 'ticket.replied',
  internal_note: 'ticket.note_added',
  staff_file_reply: 'ticket.replied',
};
const LEGACY_EVENT_TYPE_NAMES = Object.keys(LEGACY_EVENT_TYPES);

function isDuplicateSequenceError(err: unknown): boolean {
  const mongoError = err as { code?: number; keyPattern?: Record<string, number> };
  return mongoError?.code === 11000 && Boolean(mongoError.keyPattern?.seq);
}

async function waitForEventRetry(attempt: number): Promise<void> {
  const delayMs = Math.min(50, 2 + attempt * 2) + Math.floor(Math.random() * 5);
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function nextEventSequenceCandidate(): Promise<number> {
  const latest = await AnalyticsEvent.findOne({ seq: { $exists: true } })
    .sort({ seq: -1 })
    .select('seq');
  return (latest?.seq ?? 0) + 1;
}

/**
 * One-shot migration for analytics rows created before the replay log.
 * A completion marker keeps normal startup O(1); rows are processed in
 * bounded batches and canonicalized to the dotted event taxonomy.
 */
export async function backfillLegacyEvents(): Promise<number> {
  const markerId = `${getCollectionName()}:${LEGACY_EVENT_BACKFILL_MARKER}`;
  const marker = await TicketCounter.findOne({ _id: markerId }).select('seq');
  if (marker?.seq === 1) return 0;

  let migrated = 0;
  let collisionAttempt = 0;

  while (true) {
    const legacyEvents = await AnalyticsEvent.find({
      $or: [
        { seq: { $exists: false } },
        { seq: null },
        { event_id: { $exists: false } },
        { event_id: null },
        { type: { $in: LEGACY_EVENT_TYPE_NAMES } },
      ],
    })
      .sort({ timestamp: 1, _id: 1 })
      .limit(LEGACY_EVENT_BATCH_SIZE);

    if (legacyEvents.length === 0) break;

    const latest = await AnalyticsEvent.findOne({ seq: { $exists: true } })
      .sort({ seq: -1 })
      .select('seq');
    let nextSeq = latest?.seq ?? 0;

    const operations = legacyEvents.map((event) => {
      const updates: Record<string, unknown> = {};
      if (!event.event_id) updates.event_id = randomUUID();
      if (!Number.isSafeInteger(event.seq)) {
        nextSeq += 1;
        updates.seq = nextSeq;
      }
      const renamedType = LEGACY_EVENT_TYPES[event.type];
      if (renamedType) updates.type = renamedType;

      return {
        updateOne: {
          filter: { _id: event._id },
          update: { $set: updates },
        },
      };
    });

    try {
      const result = await AnalyticsEvent.bulkWrite(operations, { ordered: true });
      migrated += result.modifiedCount ?? operations.length;
      collisionAttempt = 0;
    } catch (err) {
      if ((err as { code?: number })?.code === 11000 && collisionAttempt < MAX_EVENT_APPEND_RETRIES) {
        await waitForEventRetry(collisionAttempt);
        collisionAttempt += 1;
        continue;
      }
      throw err;
    }
  }

  await TicketCounter.findOneAndUpdate(
    { _id: markerId },
    { $set: { seq: 1 } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  if (migrated > 0) log.info(`Backfilled ${migrated} legacy analytics events.`);
  return migrated;
}

let eventTail: Promise<unknown> = Promise.resolve();

function enqueueEventAppend<T>(fn: () => Promise<T>): Promise<T> {
  const run = eventTail.then(fn, fn);
  eventTail = run.catch(() => {});
  return run;
}

/** Wait until the serialized analytics event queue is fully settled. */
export async function drainAnalyticsEvents(): Promise<void> {
  while (true) {
    const tail = eventTail;
    await tail;
    if (tail === eventTail) return;
  }
}

export function recordAnalyticsEventBestEffort(
  type: string,
  ticketId: number,
  agent_id: string | null = null,
  metadata: Record<string, any> = {},
): void {
  void recordAnalyticsEvent(type, ticketId, agent_id, metadata).catch((err) => {
    log.error(`Event append failed for ${type} #T${ticketId}:`, err);
  });
}

const allowedStatusSources: Record<TicketStatus, TicketStatus[]> = {
  open: ['open', 'waiting_user', 'closed'],
  waiting_user: ['open', 'waiting_user'],
  closed: ['open', 'waiting_user', 'closed'],
};

/**
 * Atomically move one ticket to a new lifecycle state.
 * Invalid transitions (notably closed -> waiting_user) do not match the query.
 */
export async function transitionTicketStatus(
  ticketId: number,
  target: TicketStatus,
): Promise<ISupportee | null> {
  const update: Record<string, unknown> = {
    status: target,
    closed_at: target === 'closed' ? new Date() : null,
  };

  const result = await Supportee.findOneAndUpdate(
    {
      ticketId,
      status: { $in: allowedStatusSources[target] },
    },
    { $set: update },
    { new: true },
  );

  return result as ISupportee | null;
}

export async function check(
  userid: string | number,
  category?: string | null,
): Promise<ISupportee[]> {
  try {
    const query: Record<string, unknown> = {
      $or: [{ userid: String(userid) }, { ticketId: userid }],
    };
    if (category) query.category = category;
    return await Supportee.find(query).lean<ISupportee[]>();
  } catch (err) {
    log.error('DB check error:', err);
    return [];
  }
}

export async function getTicketById(
  ticketId: string | number,
  category: string | null
): Promise<ISupportee | null> {
  const query: Record<string, unknown> = { ticketId };
  if (category) query.category = category;
  const result = await Supportee.findOne(query);
  return result as ISupportee | null;
};

export async function getTicketByInternalId (
  internalId: number
): Promise<ISupportee | null> {
  const query = {
    internalIds: { $elemMatch: { $eq: internalId } },
  };
  const result = await Supportee.findOne(query);
  return result as ISupportee | null;
}

export async function getTicketByUserId (
  userId: string | number,
  category: string | null
): Promise<ISupportee | null> {
  const query: Record<string, unknown> = {
    $or: [{ userid: userId }],
    category: category ?? null,
  };
  const result = await Supportee.findOne(query).sort({ ticketId: -1 });
  return result as ISupportee | null;
};

export async function listUserTickets(userId: string, page: number, pageSize = 6, pageOffsetSize = pageSize): Promise<ISupportee[]> {
  return await Supportee.find({ userid: userId }).sort({ updated_at: -1, ticketId: -1 })
    .skip(Math.max(0, page) * pageOffsetSize).limit(pageSize).lean<ISupportee[]>();
}

export async function listStaffTickets(
  view: 'new' | 'mine' | 'active' | 'closed', actorId: string, page: number, pageSize = 6, pageOffsetSize = pageSize,
): Promise<ISupportee[]> {
  const query: Record<string, unknown> = view === 'new'
    ? { status: { $in: ['open', 'waiting_user'] }, assigned_to: null }
    : view === 'mine'
      ? { status: { $in: ['open', 'waiting_user'] }, assigned_to: actorId }
      : view === 'closed'
        ? { status: 'closed' }
        : { status: { $in: ['open', 'waiting_user'] } };
  return await Supportee.find(query).sort({ updated_at: -1, ticketId: -1 })
    .skip(Math.max(0, page) * pageOffsetSize).limit(pageSize).lean<ISupportee[]>();
}

export async function claimStaffCard(ticketId: number, claim: string) {
  return await Supportee.findOneAndUpdate(
    { ticketId, staff_card_message_id: null, $or: [
      { staff_card_claim: null }, { staff_card_claimed_at: { $lt: new Date(Date.now() - 60_000) } },
    ] },
    { $set: { staff_card_claim: claim, staff_card_claimed_at: new Date() } }, { new: true },
  );
}

export async function bindStaffCard(ticketId: number, claim: string, chatId: string, messageId: number, threadId: number | null) {
  return await Supportee.findOneAndUpdate(
    { ticketId, staff_card_message_id: null, staff_card_claim: claim },
    { $set: { staff_card_chat_id: chatId, staff_card_message_id: messageId, staff_card_thread_id: threadId, staff_card_claim: null, staff_card_claimed_at: null }, $addToSet: { internalIds: messageId } },
    { new: true },
  );
}

export async function releaseStaffCardClaim(ticketId: number, claim: string) {
  await Supportee.updateOne({ ticketId, staff_card_claim: claim, staff_card_message_id: null }, { $set: { staff_card_claim: null, staff_card_claimed_at: null } });
}

/** Clear only the canonical card binding that Telegram has proved unusable. */
export async function clearStaffCardBinding(ticketId: number, chatId: string, messageId: number) {
  return await Supportee.findOneAndUpdate(
    { ticketId, staff_card_chat_id: chatId, staff_card_message_id: messageId },
    { $set: { staff_card_chat_id: null, staff_card_message_id: null, staff_card_thread_id: null,
      staff_card_claim: null, staff_card_claimed_at: null } },
    { new: true },
  );
}

export async function setReplyPrompt(ticketId: number, staffId: string, promptId: number, expiresAt: Date,
  kind: 'reply' | 'note', expectedOwner?: string) {
  const query: Record<string, unknown> = { ticketId, status: { $in: ['open', 'waiting_user'] } };
  if (expectedOwner !== undefined) query.assigned_to = expectedOwner;
  return await Supportee.findOneAndUpdate(
    query,
    [{ $set: {
      internalIds: { $setUnion: [
        { $filter: { input: { $ifNull: ['$internalIds', []] }, as: 'id', cond: { $ne: ['$$id', '$pending_reply_prompt_id'] } } },
        [promptId],
      ] },
      pending_reply_staff_id: staffId, pending_reply_prompt_id: promptId,
      pending_reply_expires_at: expiresAt, pending_reply_kind: kind,
    } }],
    { new: true },
  );
}

export async function setPendingTicketAction(ticketId: number, type: string, token: string, actorId: string, expiresAt: Date) {
  return await Supportee.findOneAndUpdate({ ticketId }, { $set: {
    pending_action_type: type, pending_action_token: token, pending_action_actor_id: actorId, pending_action_expires_at: expiresAt,
  } }, { new: true });
}

export async function consumePendingTicketAction(ticketId: number, type: string, token: string, actorId: string) {
  return await Supportee.findOneAndUpdate({ ticketId, pending_action_type: type, pending_action_token: token,
    pending_action_actor_id: actorId, pending_action_expires_at: { $gt: new Date() } }, { $set: {
    pending_action_type: null, pending_action_token: null, pending_action_actor_id: null, pending_action_expires_at: null,
  } }, { new: false });
}

export async function clearReplyPrompt(ticketId: number, staffId?: string) {
  const query: Record<string, unknown> = { ticketId };
  if (staffId) query.pending_reply_staff_id = staffId;
  return await Supportee.findOneAndUpdate(query, [{ $set: {
    internalIds: { $filter: { input: { $ifNull: ['$internalIds', []] }, as: 'id', cond: { $ne: ['$$id', '$pending_reply_prompt_id'] } } },
    pending_reply_staff_id: null, pending_reply_prompt_id: null, pending_reply_expires_at: null, pending_reply_kind: null,
  } }], { new: true });
}

/** Persist a single-use menu intent on the user's existing ticket; no second ticket store. */
export async function requestNewTicket(userid: string, messenger: string) {
  return await Supportee.findOneAndUpdate(
    { userid, messenger }, { $set: { pending_new_request: true } }, { sort: { ticketId: -1 }, new: true },
  );
}

export async function consumeNewTicketRequest(userid: string, messenger: string) {
  return await Supportee.findOneAndUpdate(
    { userid, messenger, pending_new_request: true },
    { $set: { pending_new_request: false } }, { sort: { ticketId: -1 }, new: false },
  );
}

/**
 * Opens an additional ticket for a user without touching their existing ones
 * (ticket_per_message, #172).
 */
export const addNewTicket = async (
  userid: string | number,
  category: string | number | null,
  messenger: string,
): Promise<number> => {
  const ticketId = await getNextTicketId();
  await Supportee.create({ userid, messenger, ticketId, status: 'open', category: category ?? null });
  recordAnalyticsEventBestEffort('ticket.created', ticketId, null, { user_id: String(userid) });
  return ticketId;
};

// --- Manual external tickets ---

const DRAFT_PURGE_MS = 24 * 60 * 60 * 1000;
const OPEN_DRAFT_STATES: ManualDraftStatus[] = ['source', 'input', 'form', 'preview'];

/** Start a fresh draft; the actor's older unfinished drafts become stale. */
export async function startManualDraft(token: string, actorId: string, chatId: string, threadId: number | null, expiresAt: Date) {
  await ManualIntakeDraft.updateMany({ actor_id: actorId, status: { $in: OPEN_DRAFT_STATES } }, { $set: { status: 'cancelled' } });
  return await ManualIntakeDraft.create({ token, actor_id: actorId, chat_id: chatId, thread_id: threadId,
    status: 'source', step: null, version: 0, expires_at: expiresAt, purge_at: new Date(Date.now() + DRAFT_PURGE_MS) });
}

export async function findActiveManualDraft(actorId: string, chatId: string, threadId: number | null) {
  return await ManualIntakeDraft.findOne({ actor_id: actorId, chat_id: chatId, thread_id: threadId,
    status: 'input', expires_at: { $gt: new Date() } }) as IManualIntakeDraft | null;
}

/** All wizard navigation is compare-and-set by token/actor/version. */
export async function transitionManualDraft(token: string, actorId: string, version: number,
  expected: Partial<Pick<IManualIntakeDraft, 'status'|'step'>>, set: Record<string, unknown>, expiresAt: Date) {
  return await ManualIntakeDraft.findOneAndUpdate(
    { token, actor_id: actorId, version, expires_at: { $gt: new Date() }, ...expected },
    { $set: { ...set, expires_at: expiresAt }, $inc: { version: 1 } }, { new: true },
  ) as IManualIntakeDraft | null;
}

export async function consumeManualDraftInput(token: string, actorId: string, chatId: string, threadId: number | null,
  version: number, step: Exclude<ManualDraftStep, null>, messageId: number, value: string,
  nextStep: ManualDraftStep, expiresAt: Date) {
  const field = step === 'client' ? 'client' : step === 'description' ? 'description' : 'contact';
  return await ManualIntakeDraft.findOneAndUpdate(
    { token, actor_id: actorId, chat_id: chatId, thread_id: threadId, status: 'input', step, version,
      expires_at: { $gt: new Date() }, $or: [
        { last_consumed_message_id: { $exists: false } }, { last_consumed_message_id: null },
        { last_consumed_message_id: { $lt: messageId } },
      ] },
    { $set: { [field]: value, step: nextStep, status: nextStep ? 'input' : 'preview',
      last_consumed_message_id: messageId, confirm_nonce: nextStep ? null : String(version + 1), edit_return: false, expires_at: expiresAt }, $inc: { version: 1 } },
    { new: true },
  ) as IManualIntakeDraft | null;
}

export async function cancelActiveManualDraft(actorId: string, chatId: string, threadId: number | null) {
  return await ManualIntakeDraft.updateMany({ actor_id: actorId, chat_id: chatId, thread_id: threadId,
    status: { $in: OPEN_DRAFT_STATES } }, { $set: { status: 'cancelled' } });
}

export async function getManualDraft(token: string) {
  return await ManualIntakeDraft.findOne({ token }) as IManualIntakeDraft | null;
}

export async function findManualDraftByPrompt(chatId: string, promptId: number) {
  return await ManualIntakeDraft.findOne({ chat_id: chatId, prompt_message_id: promptId }) as IManualIntakeDraft | null;
}

export async function bindManualDraftPrompt(token: string, actorId: string, source: ManualSource, promptId: number, expiresAt: Date) {
  return await ManualIntakeDraft.findOneAndUpdate(
    { token, actor_id: actorId, status: { $in: ['source', 'form'] }, expires_at: { $gt: new Date() } },
    { $set: { source, prompt_message_id: promptId, status: 'form', confirm_nonce: null, expires_at: expiresAt } },
    { new: true },
  ) as IManualIntakeDraft | null;
}

export async function submitManualDraftForm(token: string, actorId: string, promptId: number,
  fields: { client: string; contact: string | null; description: string }, nonce: string, expiresAt: Date) {
  return await ManualIntakeDraft.findOneAndUpdate(
    { token, actor_id: actorId, prompt_message_id: promptId, status: { $in: ['form', 'preview'] }, expires_at: { $gt: new Date() } },
    { $set: { ...fields, status: 'preview', confirm_nonce: nonce, expires_at: expiresAt } },
    { new: true },
  ) as IManualIntakeDraft | null;
}

/**
 * Claim the confirmation. A draft stuck in `creating` (crash between claim and
 * completion) stays claimable by the same actor/nonce so the retry finishes
 * the same ticket instead of losing the confirmed request.
 */
export async function claimManualDraftConfirm(token: string, actorId: string, nonce: string) {
  return await ManualIntakeDraft.findOneAndUpdate(
    { token, actor_id: actorId, confirm_nonce: nonce, $or: [
      { status: 'preview', expires_at: { $gt: new Date() } }, { status: 'creating' },
    ] },
    { $set: { status: 'creating' } },
    { new: true },
  ) as IManualIntakeDraft | null;
}

export async function completeManualDraft(token: string, ticketId: number) {
  await ManualIntakeDraft.updateOne({ token, status: 'creating' }, { $set: { status: 'created', ticketId } });
}

export async function cancelManualDraft(token: string, actorId: string, version?: number) {
  return await ManualIntakeDraft.findOneAndUpdate(
    { token, actor_id: actorId, ...(version === undefined ? {} : { version }), status: { $in: OPEN_DRAFT_STATES } }, { $set: { status: 'cancelled' } }, { new: true },
  ) as IManualIntakeDraft | null;
}

/**
 * Create (or, on retry, return) the one ticket for a confirmed intake draft.
 * The synthetic userid is unique per request and outside every client
 * namespace, so no transport can ever address it.
 */
export async function createManualTicket(requestKey: string, input: {
  source: ManualSource; client: string; contact: string | null; description: string; createdBy: string;
}): Promise<{ ticket: ISupportee; created: boolean }> {
  let ticket = await Supportee.findOne({ manual_request_key: requestKey }) as ISupportee | null;
  let created = false;
  let raced = false;
  if (!ticket) {
    const ticketId = await getNextTicketId();
    try {
      ticket = await Supportee.create({
        ticketId, userid: `${MANUAL_USER_PREFIX}${randomUUID()}`, messenger: Messenger.MANUAL, status: 'open',
        category: null, name: input.client, manual_source: input.source, external_client: input.client,
        external_contact: input.contact, created_by: input.createdBy, manual_request_key: requestKey,
      }) as unknown as ISupportee;
      created = true;
    } catch (err) {
      if ((err as { code?: number }).code !== 11000) throw err;
      ticket = await Supportee.findOne({ manual_request_key: requestKey }) as ISupportee | null;
      if (!ticket) throw err;
      raced = true;
    }
  }
  // The concurrent winner records the creation audit; a crash-retry repairs a missing one.
  if (created || (!raced && !await AnalyticsEvent.exists({ ticketId: ticket.ticketId, type: 'ticket.created' }))) {
    await recordAnalyticsEvent('ticket.created', ticket.ticketId, input.createdBy, { source: 'manual', manual_source: input.source });
  }
  // The initial description is keyed history: a retry completes it exactly once.
  const descriptionKey = `manual:${requestKey}:description`;
  if (!await TicketMessage.exists({ delivery_key: descriptionKey })) {
    try {
      await TicketMessage.create({ ticketId: ticket.ticketId, sender: 'user', sender_id: ticket.userid,
        text: input.description, delivery_key: descriptionKey });
    } catch (err) {
      if ((err as { code?: number }).code !== 11000) throw err;
    }
  }
  return { ticket, created };
}

export async function getByTicketId(
  ticketId: string,
): Promise<ISupportee | null> {
  try {
    const query = { $or: [{ ticketId }] };
    return await Supportee.findOne(query) as ISupportee | null;
  } catch (err) {
    log.error('DB getByTicketId error:', err);
    return null;
  }
}

/** User bans are account-level state and are not ticket lifecycle states. */
export async function banUser(
  userid: string | number,
  messenger: string,
): Promise<void> {
  await UserBan.findOneAndUpdate(
    { messenger, userid: String(userid) },
    { $setOnInsert: { messenger, userid: String(userid) } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
}

export async function unbanUser(
  userid: string | number,
  messenger: string,
): Promise<void> {
  await UserBan.deleteOne({ messenger, userid: String(userid) });

  // One-time compatibility cleanup for databases created by upstream versions
  // that encoded a ban as ticket status/category.
  await Supportee.updateMany(
    { messenger, userid: String(userid), status: 'banned' },
    { $set: { status: 'closed', category: null, closed_at: new Date() } },
  );
}

export async function checkBan(
  userid: string | number,
  messenger: string,
): Promise<IUserBan | ISupportee | null> {
  try {
    const query = { messenger, userid: String(userid) };
    const ban = await UserBan.findOne(query);
    if (ban) return ban as IUserBan;

    // Read-only compatibility with old databases. New bans never use ticket status.
    return await Supportee.findOne({ ...query, status: 'banned' }) as ISupportee | null;
  } catch (err) {
    log.error('DB checkBan error:', err);
    return null;
  }
}

export const closeAll = async () => {
  await Supportee.updateMany(
    { status: { $in: ['open', 'waiting_user'] } },
    { $set: { status: 'closed', closed_at: new Date() } },
  );
};

export const reopen = async (userid: any, category: string, messenger: string) => {
  const query = {
    messenger,
    $or: [{ userid: userid }, { ticketId: userid }],
    status: 'closed',
    ...(category && { category }),
  };
  await Supportee.updateMany(query, { $set: { status: 'open', closed_at: null } });
};

export const addIdAndName = async (
  ticketId: string | number,
  internalId: string,
  name: string | null,
) => {
  if (!internalId) {
    return null;
  }
  const internalIdNum = parseInt(internalId);
  const query = {
    ticketId: ticketId,
  };
  const update = {
    $addToSet: { internalIds: internalIdNum },
    $set: { name },
  };
  return await Supportee.findOneAndUpdate(query, update, {
    new: true,
    upsert: true,
  });
};

export const add = async (
  userid: string | number,
  status: string,
  category: string | number | null,
  messenger: string
) => {
  if (status === 'closed') {
    const query = {
      messenger,
      $or: [{ userid: userid }, { ticketId: userid }],
      status: { $in: ['open', 'waiting_user'] },
      ...(category && { category }),
    };
    const result = await Supportee.updateMany(
      query,
      { $set: { status: 'closed', closed_at: new Date() } },
    );
    return result.modifiedCount ?? 0;
  }

  if (status === 'open') {
    const ticketId = await getNextTicketId();
    const result = await Supportee.findOneAndUpdate(
      { messenger, userid },
      {
        $setOnInsert: { userid, messenger, ticketId },
        $set: { status: 'open', category: category ?? null, closed_at: null },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    return result ? 1 : 0;
  }

  // Backward-compatible API surface for old command code. The ban itself is
  // stored separately and never written into Supportee.status.
  if (status === 'banned') {
    await banUser(userid, messenger);
    return 1;
  }

  return 0;
};

export async function open(
  category: string[] = [],
): Promise<ISupportee[]> {
  try {
    const query: Record<string, unknown> = {
      status: 'open',
    };
    if (category.length > 0) {
      query.category = { $in: category };
    } else {
      query.category = null;
    }
    return await Supportee.find(query).lean<ISupportee[]>();
  } catch (err) {
    log.error('DB open error:', err);
    return [];
  }
}

/**
 * All known, non-banned users that can receive a broadcast (#159).
 * Web chat visitors are excluded because their socket ids are transient.
 */
export async function getAllUsers(): Promise<Array<{ userid: string; messenger: string }>> {
  try {
    const docs = await Supportee.find({})
      .select('userid messenger')
      .lean();
    const seen = new Set<string>();
    const users: Array<{ userid: string; messenger: string }> = [];
    for (const doc of docs) {
      const userid = String(doc.userid ?? '');
      const messenger = String(doc.messenger);
      // Manual tickets have no client transport and are never broadcast targets.
      if (!userid || userid.startsWith('WEB') || isManualRecipient(userid, messenger)) continue;
      const key = `${messenger}:${userid}`;
      if (seen.has(key)) continue;
      if (await checkBan(userid, messenger)) continue;
      seen.add(key);
      users.push({ userid, messenger });
    }
    return users;
  } catch (err) {
    log.error('DB getAllUsers error:', err);
    return [];
  }
}

// --- Ticket Message methods (append-only audit history + bounded read window) ---

export async function persistTicketMessage(
  ticketId: number,
  sender: 'user' | 'staff' | 'ai',
  sender_id: string,
  text: string,
): Promise<void> {
  const msg = new TicketMessage({ ticketId, sender, sender_id, text });
  try {
    await msg.save();
  } catch (err) {
    log.error('DB persistTicketMessage error:', err);
    throw err;
  }
}

/** Reserve one staff delivery across Telegram update retries. */
export async function reserveStaffReply(ticketId: number, senderId: string, text: string, deliveryKey: string) {
  const existing = await TicketMessage.findOne({ delivery_key: deliveryKey });
  if (existing) return existing;
  try {
    return await TicketMessage.create({ ticketId, sender: 'staff', sender_id: senderId, text, delivery_key: deliveryKey });
  } catch (err) {
    if ((err as { code?: number }).code === 11000) return await TicketMessage.findOne({ delivery_key: deliveryKey });
    throw err;
  }
}

/**
 * Staff-history-only record for a manual ticket. It has a delivery key (so it
 * is never treated as a legacy delivered reply) and is never marked delivered.
 */
export async function recordStaffWork(ticketId: number, senderId: string, text: string, deliveryKey: string): Promise<boolean> {
  if (await TicketMessage.exists({ delivery_key: deliveryKey })) return false;
  try {
    await TicketMessage.create({ ticketId, sender: 'staff', sender_id: senderId, text, delivery_key: deliveryKey });
    return true;
  } catch (err) {
    if ((err as { code?: number }).code === 11000) return false;
    throw err;
  }
}

export async function markStaffReplyDelivered(deliveryKey: string) {
  await TicketMessage.updateOne({ delivery_key: deliveryKey }, { $set: { delivered_at: new Date() } });
}

export async function addTicketMessage(
  ticketId: number,
  sender: 'user' | 'staff' | 'ai',
  sender_id: string,
  text: string,
): Promise<void> {
  await persistTicketMessage(ticketId, sender, sender_id, text);
  recordAnalyticsEventBestEffort(`ticket.message.${sender}`, ticketId, sender_id || null);
}

/** LLM context is a bounded read; stored ticket history is never pruned. */
export async function getConversationHistory(
  ticketId: number,
  depth?: number,
): Promise<ITicketMessage[]> {
  try {
    const configured = depth ?? cache.config.llm_memory_depth ?? 10;
    const limit = Math.max(1, Math.min(configured, 100));
    return await TicketMessage.find({ ticketId })
      .sort({ timestamp: -1 })
      .limit(limit)
      .lean<ITicketMessage[]>();
  } catch (err) {
    log.error('DB getConversationHistory error:', err);
    return [];
  }
}

/** Full chronological ticket history for audit/export/KB workflows. */
export async function getTicketMessageHistory(
  ticketId: number,
  limit: number = 0,
): Promise<ITicketMessage[]> {
  try {
    const query = TicketMessage.find({ ticketId }).sort({ timestamp: 1 });
    if (limit > 0) query.limit(limit);
    return await query.lean<ITicketMessage[]>();
  } catch (err) {
    log.error('DB getTicketMessageHistory error:', err);
    return [];
  }
}

export async function getLatestTicketMessage(ticketId: number): Promise<ITicketMessage | null> {
  return await TicketMessage.findOne({ ticketId }).sort({ timestamp: -1 }).lean<ITicketMessage | null>();
}

export async function getTicketTimelinePage(ticketId: number, page: number, pageSize: number, includeNotes: boolean, pageOffsetSize = pageSize) {
  const clientMessageFilter = {
    ticketId,
    sender: { $in: ['user', 'staff'] },
    $or: [
      { sender: 'user' },
      { sender: 'staff', delivered_at: { $ne: null } },
      // Messages written before delivery keys were introduced are delivered legacy replies.
      { sender: 'staff', delivery_key: { $exists: false } },
    ],
  };
  const pipeline: any[] = [
    { $match: includeNotes ? { ticketId } : clientMessageFilter },
    { $project: { at: '$timestamp', kind: '$sender', actor: '$sender_id', text: 1, metadata: { $literal: {} } } },
    { $unionWith: { coll: AnalyticsEvent.collection.name, pipeline: [
      { $match: { ticketId, type: { $in: ['ticket.closed','ticket.reopened','ticket.taken','ticket.assigned','ticket.transferred','ticket.waiting','ticket.resumed',
        // Creation audit (incl. manual intake author) is staff-only history.
        ...(includeNotes ? ['ticket.created'] : [])] } } },
      { $project: { at: '$timestamp', kind: { $literal: 'event' }, actor: '$agent_id', text: '$type', metadata: 1 } },
    ] } },
  ];
  if (includeNotes) pipeline.push({ $unionWith: { coll: InternalNote.collection.name, pipeline: [
    { $match: { ticketId } },
    { $project: { at: '$timestamp', kind: { $literal: 'note' }, actor: '$author_id', text: 1, metadata: { $literal: {} } } },
  ] } });
  pipeline.push({ $sort: { at: 1, _id: 1 } }, { $skip: Math.max(0, page) * pageOffsetSize }, { $limit: pageSize });
  return await TicketMessage.aggregate(pipeline);
}

// --- Analytics / event log methods ---

async function appendAnalyticsEvent(
  type: string,
  ticketId: number,
  agent_id: string | null = null,
  metadata: Record<string, any> = {},
): Promise<IAnalyticsEvent> {
  const eventId = randomUUID();
  let lastError: unknown = null;

  for (let attempt = 0; attempt < MAX_EVENT_APPEND_RETRIES; attempt += 1) {
    const seq = await nextEventSequenceCandidate();
    const event = new AnalyticsEvent({
      event_id: eventId,
      seq,
      type,
      ticketId,
      agent_id,
      metadata,
    });

    try {
      await event.save();
      return event as IAnalyticsEvent;
    } catch (err) {
      lastError = err;
      if (isDuplicateSequenceError(err)) {
        await waitForEventRetry(attempt);
        continue;
      }
      log.error('DB recordAnalyticsEvent error:', err);
      throw err;
    }
  }

  const error = lastError instanceof Error
    ? lastError
    : new Error('Failed to append analytics event after sequence retries');
  log.error('DB recordAnalyticsEvent error:', error);
  throw error;
}

export async function recordAnalyticsEvent(
  type: string,
  ticketId: number,
  agent_id: string | null = null,
  metadata: Record<string, any> = {},
): Promise<IAnalyticsEvent> {
  return enqueueEventAppend(() => appendAnalyticsEvent(type, ticketId, agent_id, metadata));
}

export async function getEventsSince(
  since: number = 0,
  limit: number = 100,
): Promise<IAnalyticsEvent[]> {
  try {
    const safeSince = Number.isSafeInteger(since) && since >= 0 ? since : 0;
    const safeLimit = Math.max(1, Math.min(limit, 501));
    const events = await AnalyticsEvent.find({ seq: { $gt: safeSince } })
      .sort({ seq: 1 })
      .limit(safeLimit)
      .lean<IAnalyticsEvent[]>();

    const contiguous: IAnalyticsEvent[] = [];
    let expected = safeSince + 1;
    for (const event of events) {
      if (event.seq !== expected) break;
      contiguous.push(event);
      expected += 1;
    }
    return contiguous;
  } catch (err) {
    log.error('DB getEventsSince error:', err);
    return [];
  }
}

export async function getLatestEventSequence(): Promise<number> {
  const latest = await AnalyticsEvent.findOne({ seq: { $exists: true } })
    .sort({ seq: -1 })
    .select('seq')
    .lean<{ seq?: number }>();

  return Number.isSafeInteger(latest?.seq) ? Number(latest?.seq) : 0;
}

/**
 * Initialize a durable subscriber cursor once. Existing cursors are never
 * moved by startup, so restart resumes from the last acknowledged event.
 */
export async function initializeWebhookCursor(
  subscriberId: string,
  initialSeq: number,
): Promise<number> {
  const safeSeq = Number.isSafeInteger(initialSeq) && initialSeq >= 0 ? initialSeq : 0;
  try {
    const cursor = await WebhookCursor.findOneAndUpdate(
      { subscriber_id: subscriberId },
      { $setOnInsert: { subscriber_id: subscriberId, last_seq: safeSeq } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    if (!cursor) throw new Error(`Failed to initialize webhook cursor ${subscriberId}`);
    return cursor.last_seq;
  } catch (err) {
    // Two bot instances may initialize the same subscriber simultaneously.
    // The unique index elects one insert; the loser resumes the created cursor.
    if ((err as { code?: number })?.code === 11000) {
      const existing = await WebhookCursor.findOne({ subscriber_id: subscriberId }).select('last_seq');
      if (existing) return existing.last_seq;
    }
    throw err;
  }
}

export async function advanceWebhookCursor(
  subscriberId: string,
  seq: number,
): Promise<void> {
  if (!Number.isSafeInteger(seq) || seq < 0) {
    throw new Error(`Invalid webhook cursor sequence: ${seq}`);
  }

  const result = await WebhookCursor.updateOne(
    { subscriber_id: subscriberId },
    { $max: { last_seq: seq } },
  );
  if (result.matchedCount === 0) {
    throw new Error(`Webhook cursor not initialized: ${subscriberId}`);
  }
}

export async function getAnalyticsEvents(
  type?: string,
  startDate?: Date,
  endDate?: Date,
): Promise<IAnalyticsEvent[]> {
  try {
    const query: Record<string, any> = {};
    if (type) query.type = type;
    if (startDate || endDate) {
      query.timestamp = {};
      if (startDate) query.timestamp.$gte = startDate;
      if (endDate) query.timestamp.$lte = endDate;
    }
    return await AnalyticsEvent.find(query)
      .sort({ timestamp: -1 })
      .lean<IAnalyticsEvent[]>();
  } catch (err) {
    log.error('DB getAnalyticsEvents error:', err);
    return [];
  }
}

// --- Internal Note methods ---

export async function addInternalNote(
  ticketId: number,
  author_id: string,
  text: string,
  deliveryKey?: string,
): Promise<boolean> {
  try {
    if (deliveryKey && await InternalNote.findOne({ delivery_key: deliveryKey })) return false;
    const note = new InternalNote({ ticketId, author_id, text, delivery_key: deliveryKey });
    await note.save();
    return true;
  } catch (err) {
    if (deliveryKey && (err as { code?: number }).code === 11000) return false;
    log.error('DB addInternalNote error:', err);
    throw err;
  }
}

export async function getInternalNotes(
  ticketId: number,
): Promise<IInternalNote[]> {
  try {
    return await InternalNote.find({ ticketId })
      .sort({ timestamp: -1 })
      .lean<IInternalNote[]>();
  } catch (err) {
    log.error('DB getInternalNotes error:', err);
    return [];
  }
}

// --- Ticket assignment methods ---

export async function assignTicket(
  ticketId: number,
  agent_telegram_id: string,
): Promise<void> {
  try {
    await Supportee.findOneAndUpdate(
      { ticketId },
      { $set: { assigned_to: agent_telegram_id } },
    );
  } catch (err) {
    log.error('DB assignTicket error:', err);
  }
}

export async function unassignTicket(ticketId: number): Promise<void> {
  try {
    await Supportee.findOneAndUpdate(
      { ticketId },
      { $set: { assigned_to: null } },
    );
  } catch (err) {
    log.error('DB unassignTicket error:', err);
  }
}

// --- Tag methods ---

export async function addTags(ticketId: number, tags: string[]): Promise<void> {
  try {
    await Supportee.findOneAndUpdate(
      { ticketId },
      { $addToSet: { tags: { $each: tags } } },
    );
  } catch (err) {
    log.error('DB addTags error:', err);
  }
}

export async function removeTag(ticketId: number, tag: string): Promise<void> {
  try {
    await Supportee.findOneAndUpdate(
      { ticketId },
      { $pull: { tags: tag } },
    );
  } catch (err) {
    log.error('DB removeTag error:', err);
  }
}

// --- Priority methods ---

export async function setPriority(
  ticketId: number,
  priority: TicketPriority,
): Promise<void> {
  try {
    await Supportee.findOneAndUpdate(
      { ticketId },
      { $set: { priority } },
    );
  } catch (err) {
    log.error('DB setPriority error:', err);
  }
}

// --- Triage methods ---

export async function setTriageInfo(
  ticketId: number,
  category: string | null,
  summary: string | null,
  sentimentScore: number | null,
): Promise<void> {
  try {
    await Supportee.findOneAndUpdate(
      { ticketId },
      { $set: { triage_category: category, triage_summary: summary, sentiment_score: sentimentScore } },
    );
  } catch (err) {
    log.error('DB setTriageInfo error:', err);
  }
}

// --- Analytics timestamp methods ---

export async function setFirstResponseAt(ticketId: number): Promise<void> {
  try {
    await Supportee.findOneAndUpdate(
      { ticketId, first_response_at: null },
      { $set: { first_response_at: new Date() } },
    );
  } catch (err) {
    log.error('DB setFirstResponseAt error:', err);
  }
}

export async function setClosedAt(ticketId: number): Promise<void> {
  try {
    await Supportee.findOneAndUpdate(
      { ticketId },
      { $set: { closed_at: new Date() } },
    );
  } catch (err) {
    log.error('DB setClosedAt error:', err);
  }
}

// --- Open tickets with tag filter ---

export async function openByTag(
  tag: string,
  category: string[] = [],
): Promise<ISupportee[]> {
  try {
    const query: Record<string, unknown> = {
      status: 'open',
      tags: tag,
    };
    if (category.length > 0) {
      query.category = { $in: category };
    } else {
      query.category = null;
    }
    return await Supportee.find(query).lean<ISupportee[]>();
  } catch (err) {
    log.error('DB openByTag error:', err);
    return [];
  }
}

// --- CSAT methods ---

export async function recordCSAT(
  ticketId: number,
  rating: number,
  comment: string = '',
): Promise<void> {
  await recordAnalyticsEvent('csat.rated', ticketId, null, { rating, comment });
}

// --- Export models for use in other modules ---

export { TicketMessage, AnalyticsEvent, WebhookCursor, InternalNote, TicketCounter, UserBan, ManualIntakeDraft };
