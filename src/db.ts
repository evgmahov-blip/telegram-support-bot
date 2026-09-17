import mongoose from 'mongoose';
import { randomUUID } from 'crypto';
import cache from './cache';
import { Messenger, TicketPriority } from './interfaces';
import * as log from './logger'

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
}

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
}, {
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
});

SupporteeSchema.index({ userid: 1, messenger: 1, ticketId: -1 });
SupporteeSchema.index({ internalIds: 1 });
SupporteeSchema.index({ status: 1, category: 1, assigned_to: 1 });

const Supportee = mongoose.model(getCollectionName(), SupporteeSchema);

export { Supportee };

// --- New collections for team collaboration & analytics ---

export interface ITicketMessage extends mongoose.Document {
  ticketId: number;
  sender: 'user' | 'staff' | 'ai';
  sender_id: string;
  text: string;
  timestamp: Date;
}

const TicketMessageSchema = new mongoose.Schema<ITicketMessage>({
  ticketId: { type: Number, required: true },
  sender: { type: String, enum: ['user', 'staff', 'ai'], required: true },
  sender_id: { type: String, default: '' },
  text: { type: String, required: true },
  timestamp: { type: Date, default: Date.now },
});
TicketMessageSchema.index({ ticketId: 1, timestamp: -1 });

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

export interface IInternalNote extends mongoose.Document {
  ticketId: number;
  author_id: string;
  text: string;
  timestamp: Date;
}

const InternalNoteSchema = new mongoose.Schema<IInternalNote>({
  ticketId: { type: Number, required: true },
  author_id: { type: String, required: true },
  text: { type: String, required: true },
  timestamp: { type: Date, default: Date.now },
});
InternalNoteSchema.index({ ticketId: 1, timestamp: -1 });

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

  await backfillLegacyEvents();
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

const MAX_EVENT_APPEND_RETRIES = 8;

function isDuplicateSequenceError(err: unknown): boolean {
  const mongoError = err as { code?: number; keyPattern?: Record<string, number> };
  return mongoError?.code === 11000 && Boolean(mongoError.keyPattern?.seq);
}

async function nextEventSequenceCandidate(): Promise<number> {
  const latest = await AnalyticsEvent.findOne({ seq: { $exists: true } })
    .sort({ seq: -1 })
    .select('seq');
  return (latest?.seq ?? 0) + 1;
}

/** Backfill pre-event-log rows without rewinding any existing cursor. */
export async function backfillLegacyEvents(): Promise<number> {
  const latest = await AnalyticsEvent.findOne({ seq: { $exists: true } })
    .sort({ seq: -1 })
    .select('seq');
  let nextSeq = latest?.seq ?? 0;
  let migrated = 0;

  const legacyEvents = await AnalyticsEvent.find({
    $or: [
      { seq: { $exists: false } },
      { seq: null },
      { event_id: { $exists: false } },
      { event_id: null },
    ],
  }).sort({ timestamp: 1, _id: 1 });

  for (const event of legacyEvents) {
    const updates: Record<string, unknown> = {};
    if (!event.event_id) updates.event_id = randomUUID();
    if (!Number.isSafeInteger(event.seq)) {
      nextSeq += 1;
      updates.seq = nextSeq;
    } else {
      nextSeq = Math.max(nextSeq, event.seq as number);
    }
    if (Object.keys(updates).length > 0) {
      await AnalyticsEvent.updateOne({ _id: event._id }, { $set: updates });
      migrated += 1;
    }
  }

  if (migrated > 0) log.info(`Backfilled ${migrated} legacy analytics events.`);
  return migrated;
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
  await recordAnalyticsEvent('ticket.created', ticketId, null, { user_id: String(userid) });
  return ticketId;
};

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
      if (!userid || userid.startsWith('WEB')) continue;
      const messenger = String(doc.messenger);
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

export async function addTicketMessage(
  ticketId: number,
  sender: 'user' | 'staff' | 'ai',
  sender_id: string,
  text: string,
): Promise<void> {
  const msg = new TicketMessage({ ticketId, sender, sender_id, text });
  try {
    await msg.save();
  } catch (err) {
    log.error('DB addTicketMessage error:', err);
    throw err;
  }

  // The message and event are separate documents, but event loss must be
  // observable instead of silently hidden after history was persisted.
  await recordAnalyticsEvent(`ticket.message.${sender}`, ticketId, sender_id || null);
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
  limit: number = 1000,
): Promise<ITicketMessage[]> {
  try {
    const safeLimit = Math.max(1, Math.min(limit, 5000));
    return await TicketMessage.find({ ticketId })
      .sort({ timestamp: 1 })
      .limit(safeLimit)
      .lean<ITicketMessage[]>();
  } catch (err) {
    log.error('DB getTicketMessageHistory error:', err);
    return [];
  }
}

// --- Analytics / event log methods ---

export async function recordAnalyticsEvent(
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
      if (isDuplicateSequenceError(err)) continue;
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
): Promise<void> {
  try {
    const note = new InternalNote({ ticketId, author_id, text });
    await note.save();
  } catch (err) {
    log.error('DB addInternalNote error:', err);
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

export { TicketMessage, AnalyticsEvent, InternalNote, TicketCounter, UserBan };
