import mongoose from 'mongoose';
import { randomUUID } from 'crypto';
import cache from './cache';

export const TELEGRAM_UPDATE_LEASE_MS = 30 * 60 * 1000;
export const TELEGRAM_UPDATE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

type ReceiptState = 'processing' | 'done';

interface TelegramUpdateReceipt {
  _id: string;
  update_id: number;
  claim_id: string;
  state: ReceiptState;
  lease_until: Date;
  expires_at: Date;
  attempts: number;
  processed_at?: Date | null;
}

const TelegramUpdateReceiptSchema = new mongoose.Schema<TelegramUpdateReceipt>({
  _id: { type: String, required: true },
  update_id: { type: Number, required: true },
  claim_id: { type: String, required: true },
  state: { type: String, enum: ['processing', 'done'], required: true },
  lease_until: { type: Date, required: true },
  expires_at: { type: Date, required: true },
  attempts: { type: Number, required: true, default: 1 },
  processed_at: { type: Date, default: null },
}, {
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
  versionKey: false,
});
TelegramUpdateReceiptSchema.index({ expires_at: 1 }, { expireAfterSeconds: 0 });

const TelegramUpdateReceiptModel =
  mongoose.models.TelegramUpdateReceipt ||
  mongoose.model('TelegramUpdateReceipt', TelegramUpdateReceiptSchema);

export interface TelegramUpdateReceiptStore {
  create(receipt: TelegramUpdateReceipt): Promise<void>;
  reclaim(
    id: string,
    claimId: string,
    now: Date,
    leaseUntil: Date,
    expiresAt: Date,
  ): Promise<boolean>;
  complete(id: string, claimId: string, now: Date, expiresAt: Date): Promise<boolean>;
  release(id: string, claimId: string): Promise<void>;
}

class MongooseTelegramUpdateReceiptStore implements TelegramUpdateReceiptStore {
  async create(receipt: TelegramUpdateReceipt): Promise<void> {
    await TelegramUpdateReceiptModel.create(receipt);
  }

  async reclaim(
    id: string,
    claimId: string,
    now: Date,
    leaseUntil: Date,
    expiresAt: Date,
  ): Promise<boolean> {
    const result = await TelegramUpdateReceiptModel.findOneAndUpdate(
      {
        _id: id,
        state: 'processing',
        lease_until: { $lte: now },
      },
      {
        $set: {
          claim_id: claimId,
          lease_until: leaseUntil,
          expires_at: expiresAt,
        },
        $inc: { attempts: 1 },
      },
      { new: true },
    );
    return Boolean(result);
  }

  async complete(id: string, claimId: string, now: Date, expiresAt: Date): Promise<boolean> {
    const result = await TelegramUpdateReceiptModel.updateOne(
      { _id: id, claim_id: claimId, state: 'processing' },
      {
        $set: {
          state: 'done',
          processed_at: now,
          lease_until: now,
          expires_at: expiresAt,
        },
      },
    );
    return (result.matchedCount ?? 0) === 1;
  }

  async release(id: string, claimId: string): Promise<void> {
    await TelegramUpdateReceiptModel.deleteOne({
      _id: id,
      claim_id: claimId,
      state: 'processing',
    });
  }
}

function isDuplicateKeyError(err: unknown): boolean {
  return (err as { code?: number })?.code === 11000;
}

function defaultScope(): string {
  return process.env.MONGO_COLLECTION || `bot_${cache.config?.owner_id || 'support'}`;
}

export class TelegramUpdateDeduper {
  constructor(
    private readonly store: TelegramUpdateReceiptStore,
    private readonly scope: () => string = defaultScope,
    private readonly leaseMs: number = TELEGRAM_UPDATE_LEASE_MS,
    private readonly retentionMs: number = TELEGRAM_UPDATE_RETENTION_MS,
  ) {}

  private receiptId(updateId: number): string {
    return `${this.scope()}:telegram:${updateId}`;
  }

  async claim(updateId: number): Promise<string | null> {
    // Telegram guarantees a non-negative integer update_id. Fail open for a
    // malformed synthetic context rather than dropping an update unexpectedly.
    if (!Number.isSafeInteger(updateId) || updateId < 0) return 'synthetic';

    const now = new Date();
    const leaseUntil = new Date(now.getTime() + this.leaseMs);
    const expiresAt = new Date(now.getTime() + this.retentionMs);
    const id = this.receiptId(updateId);
    const claimId = randomUUID();

    try {
      await this.store.create({
        _id: id,
        update_id: updateId,
        claim_id: claimId,
        state: 'processing',
        lease_until: leaseUntil,
        expires_at: expiresAt,
        attempts: 1,
        processed_at: null,
      });
      return claimId;
    } catch (err) {
      if (!isDuplicateKeyError(err)) throw err;
    }

    // A duplicate that is already done, or still has an active lease, is
    // suppressed. A crashed worker can be reclaimed only after its lease. The
    // new claim_id fences stale workers from completing or releasing the claim.
    const reclaimed = await this.store.reclaim(id, claimId, now, leaseUntil, expiresAt);
    return reclaimed ? claimId : null;
  }

  async complete(updateId: number, claimId: string): Promise<void> {
    if (!Number.isSafeInteger(updateId) || updateId < 0) return;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.retentionMs);
    const matched = await this.store.complete(this.receiptId(updateId), claimId, now, expiresAt);
    if (!matched) {
      throw new Error(`Telegram update claim is no longer owned: ${updateId}`);
    }
  }

  async release(updateId: number, claimId: string): Promise<void> {
    if (!Number.isSafeInteger(updateId) || updateId < 0) return;
    await this.store.release(this.receiptId(updateId), claimId);
  }
}

const defaultDeduper = new TelegramUpdateDeduper(new MongooseTelegramUpdateReceiptStore());

export function claimTelegramUpdate(updateId: number): Promise<string | null> {
  return defaultDeduper.claim(updateId);
}

export function completeTelegramUpdate(updateId: number, claimId: string): Promise<void> {
  return defaultDeduper.complete(updateId, claimId);
}

export function releaseTelegramUpdate(updateId: number, claimId: string): Promise<void> {
  return defaultDeduper.release(updateId, claimId);
}
