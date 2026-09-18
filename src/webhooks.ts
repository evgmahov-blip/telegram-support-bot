import axios from 'axios';
import { createHash, createHmac } from 'crypto';
import cache from './cache';
import * as db from './db';
import * as log from './logger';
import { WebhookConfig, WebhookEvent } from './interfaces';

export interface WebhookPayload {
    event: string;
    ticket_id: number;
    user_id: string | null;
    timestamp: string;
    message_preview?: string;
    metadata?: Record<string, any>;
    event_id?: string;
    seq?: number;
    agent_id?: string | null;
}

interface DurableSubscriber {
    id: string;
    config: WebhookConfig;
}

interface DurableRetryState {
    failures: number;
    nextAttemptAt: number;
}

const LEGACY_WEBHOOK_TIMEOUT_MS = 5000;
const DURABLE_WEBHOOK_POLL_MS = 1000;
const DURABLE_WEBHOOK_BATCH_SIZE = 100;
const DURABLE_WEBHOOK_MAX_BACKOFF_MS = 60000;
const DURABLE_WEBHOOK_BASE_BACKOFF_MS = 1000;

const pendingWebhookDeliveries = new Set<Promise<void>>();
const durableCursors = new Map<string, number>();
const durableRetryState = new Map<string, DurableRetryState>();
const activeDurableControllers = new Set<AbortController>();

let durableTimer: ReturnType<typeof setTimeout> | null = null;
let durableRun: Promise<void> | null = null;
let durableStopping = true;

function serializeWebhook(
    webhook: Pick<WebhookConfig, 'secret'>,
    payload: WebhookPayload,
    extraHeaders: Record<string, string> = {},
): { body: string; headers: Record<string, string> } {
    const body = JSON.stringify(payload);
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'User-Agent': 'telegram-support-bot/5.0',
        ...extraHeaders,
    };

    if (webhook.secret) {
        headers['X-TSB-Signature'] = createHmac('sha256', webhook.secret)
            .update(body)
            .digest('hex');
    }

    return { body, headers };
}

async function postWebhook(
    webhook: WebhookConfig,
    payload: WebhookPayload,
    extraHeaders: Record<string, string> = {},
    signal?: AbortSignal,
): Promise<void> {
    const { body, headers } = serializeWebhook(webhook, payload, extraHeaders);
    await axios.post(webhook.url, body, {
        headers,
        timeout: LEGACY_WEBHOOK_TIMEOUT_MS,
        signal,
    });
}

async function deliverWebhook(
    webhook: WebhookConfig,
    event: WebhookEvent | string,
    payload: WebhookPayload,
): Promise<void> {
    try {
        await postWebhook(webhook, payload);
        log.info(`Webhook sent to ${webhook.url} for event ${event}`);
    } catch (err) {
        // Legacy push delivery is compatibility-only. A failed endpoint must
        // never fail the ticket operation or another webhook delivery.
        log.error(`Webhook failed for ${webhook.url}:`, err);
    }
}

/**
 * Sends a compatibility webhook event to all non-durable subscribers.
 * Durable subscribers consume the persisted AnalyticsEvent stream instead, so
 * they are deliberately excluded here to prevent duplicate deliveries.
 */
export async function sendWebhook(
    event: WebhookEvent | string,
    ticketId: number,
    userId: string | null = null,
    messagePreview: string = '',
    metadata: Record<string, any> = {},
): Promise<void> {
    const configured = cache.config.webhooks || [];
    if (configured.length === 0) return;

    const payload: WebhookPayload = {
        event,
        ticket_id: ticketId,
        user_id: userId,
        timestamp: new Date().toISOString(),
        message_preview: messagePreview.substring(0, 200),
        metadata,
    };

    const subscribers = configured.filter(
        (webhook) =>
            webhook.durable !== true &&
            Array.isArray(webhook.events) &&
            webhook.events.includes(event as WebhookEvent),
    );

    await Promise.all(
        subscribers.map((webhook) => deliverWebhook(webhook, event, payload)),
    );
}

/**
 * Queue compatibility webhook delivery without putting it on the ticket's
 * critical path. The promise is retained so graceful shutdown can drain it.
 */
export function dispatchWebhook(
    event: WebhookEvent | string,
    ticketId: number,
    userId: string | null = null,
    messagePreview: string = '',
    metadata: Record<string, any> = {},
): void {
    const delivery = sendWebhook(event, ticketId, userId, messagePreview, metadata)
        .catch((err) => {
            // sendWebhook isolates endpoint failures already; keep this guard
            // for unexpected configuration/runtime errors.
            log.error(`Webhook dispatch failed for event ${event}:`, err);
        });

    pendingWebhookDeliveries.add(delivery);
    void delivery.finally(() => {
        pendingWebhookDeliveries.delete(delivery);
    });
}

/** Wait until all compatibility webhook deliveries queued so far are settled. */
export async function drainWebhooks(): Promise<void> {
    while (pendingWebhookDeliveries.size > 0) {
        await Promise.allSettled(Array.from(pendingWebhookDeliveries));
    }
}

export function getDurableWebhookSubscriberId(webhook: WebhookConfig): string {
    const explicitId = webhook.id?.trim();
    if (explicitId) return explicitId;

    const hash = createHash('sha256').update(webhook.url).digest('hex').slice(0, 24);
    return `url:${hash}`;
}

function getDurableSubscribers(): DurableSubscriber[] {
    const configured = cache.config.webhooks || [];
    const subscribers: DurableSubscriber[] = [];
    const ids = new Set<string>();

    for (const webhook of configured) {
        if (webhook.durable !== true) continue;

        let parsed: URL;
        try {
            parsed = new URL(webhook.url);
        } catch {
            throw new Error(`Invalid durable webhook URL: ${webhook.url}`);
        }
        if (!['http:', 'https:'].includes(parsed.protocol)) {
            throw new Error(`Durable webhook URL must use http or https: ${webhook.url}`);
        }
        if (parsed.username || parsed.password) {
            throw new Error(`Durable webhook URL must not contain credentials: ${webhook.url}`);
        }

        const id = getDurableWebhookSubscriberId(webhook);
        if (ids.has(id)) {
            throw new Error(`Duplicate durable webhook subscriber id: ${id}`);
        }
        ids.add(id);
        subscribers.push({ id, config: webhook });
    }

    return subscribers;
}

function durablePayload(event: db.IAnalyticsEvent): WebhookPayload {
    const metadata = event.metadata || {};
    const rawUserId = metadata.user_id;
    const preview = typeof metadata.message_preview === 'string'
        ? metadata.message_preview.substring(0, 200)
        : '';

    return {
        event: event.type,
        event_id: event.event_id,
        seq: event.seq,
        ticket_id: event.ticketId,
        user_id: rawUserId === undefined || rawUserId === null ? null : String(rawUserId),
        timestamp: new Date(event.timestamp).toISOString(),
        message_preview: preview,
        metadata,
        agent_id: event.agent_id ?? null,
    };
}

async function deliverDurableSubscriber(subscriber: DurableSubscriber): Promise<boolean> {
    let cursor = durableCursors.get(subscriber.id);
    if (cursor === undefined) {
        throw new Error(`Durable webhook cursor not initialized: ${subscriber.id}`);
    }

    const events = await db.getEventsSince(cursor, DURABLE_WEBHOOK_BATCH_SIZE);
    for (const event of events) {
        if (!Number.isSafeInteger(event.seq) || !event.event_id) {
            throw new Error(`Persisted event missing durable identity after seq ${cursor}`);
        }

        const seq = Number(event.seq);
        if (subscriber.config.events.includes(event.type as WebhookEvent)) {
            const controller = new AbortController();
            activeDurableControllers.add(controller);
            try {
                await postWebhook(
                    subscriber.config,
                    durablePayload(event),
                    {
                        'X-TSB-Event-ID': event.event_id,
                        'X-TSB-Event-Seq': String(seq),
                        'X-TSB-Delivery': 'durable',
                    },
                    controller.signal,
                );
            } finally {
                activeDurableControllers.delete(controller);
            }

            log.info(
                `Durable webhook sent to ${subscriber.config.url} for event ${event.type} seq ${seq}`,
            );
        }

        // Advance across events the subscriber does not select as well; its
        // filter is prospective and must never pin replay on unrelated events.
        await db.advanceWebhookCursor(subscriber.id, seq);
        cursor = seq;
        durableCursors.set(subscriber.id, cursor);
    }

    return events.length === DURABLE_WEBHOOK_BATCH_SIZE;
}

function noteDurableFailure(subscriberId: string): void {
    const previous = durableRetryState.get(subscriberId)?.failures ?? 0;
    const failures = Math.min(previous + 1, 16);
    const exponential = Math.min(
        DURABLE_WEBHOOK_MAX_BACKOFF_MS,
        DURABLE_WEBHOOK_BASE_BACKOFF_MS * 2 ** Math.min(failures - 1, 6),
    );
    const jitter = Math.floor(Math.random() * Math.min(250, Math.max(1, exponential / 4)));
    durableRetryState.set(subscriberId, {
        failures,
        nextAttemptAt: Date.now() + exponential + jitter,
    });
}

function isAbortError(err: unknown): boolean {
    const candidate = err as { name?: string; code?: string };
    return candidate?.name === 'CanceledError' ||
        candidate?.name === 'AbortError' ||
        candidate?.code === 'ERR_CANCELED';
}

async function runDurableWebhookCycle(): Promise<boolean> {
    const subscribers = getDurableSubscribers();
    let hasBacklog = false;

    await Promise.all(subscribers.map(async (subscriber) => {
        const retry = durableRetryState.get(subscriber.id);
        if (retry && retry.nextAttemptAt > Date.now()) return;

        try {
            const more = await deliverDurableSubscriber(subscriber);
            durableRetryState.delete(subscriber.id);
            hasBacklog = hasBacklog || more;
        } catch (err) {
            if (durableStopping && isAbortError(err)) return;
            noteDurableFailure(subscriber.id);
            log.error(`Durable webhook failed for ${subscriber.id}:`, err);
        }
    }));

    return hasBacklog;
}

function scheduleDurableWebhookPoll(delayMs: number): void {
    if (durableStopping || durableTimer) return;

    durableTimer = setTimeout(() => {
        durableTimer = null;
        let nextDelay = DURABLE_WEBHOOK_POLL_MS;

        const run = runDurableWebhookCycle()
            .then((hasBacklog) => {
                if (hasBacklog) nextDelay = 0;
            })
            .catch((err) => {
                log.error('Durable webhook worker cycle failed:', err);
            })
            .then(() => undefined);

        durableRun = run;
        void run.finally(() => {
            if (durableRun === run) durableRun = null;
            if (!durableStopping) scheduleDurableWebhookPoll(nextDelay);
        });
    }, Math.max(0, delayMs));
    durableTimer.unref?.();
}

/**
 * Initialize durable cursors before ingress starts. New subscribers begin at
 * the current event tail; existing subscribers resume their persisted cursor.
 */
export async function startDurableWebhookWorker(): Promise<void> {
    if (!durableStopping || durableTimer || durableRun) return;

    const subscribers = getDurableSubscribers();
    durableCursors.clear();
    durableRetryState.clear();

    if (subscribers.length === 0) return;

    const baseline = await db.getLatestEventSequence();
    for (const subscriber of subscribers) {
        const cursor = await db.initializeWebhookCursor(subscriber.id, baseline);
        durableCursors.set(subscriber.id, cursor);
    }

    durableStopping = false;
    scheduleDurableWebhookPoll(0);
    log.info(`Durable webhook worker started for ${subscribers.length} subscriber(s).`);
}

/**
 * Stop polling without losing accepted events. Active HTTP deliveries are
 * aborted; their cursors stay unchanged and will be retried after restart.
 */
export async function stopDurableWebhookWorker(timeoutMs: number = 5000): Promise<void> {
    durableStopping = true;

    if (durableTimer) {
        clearTimeout(durableTimer);
        durableTimer = null;
    }

    for (const controller of activeDurableControllers) controller.abort();

    const run = durableRun;
    if (!run) return;

    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observed = run.finally(() => {
        settled = true;
    });
    const expiry = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, Math.max(0, timeoutMs));
        timer.unref?.();
    });

    await Promise.race([observed, expiry]);
    if (timer) clearTimeout(timer);

    if (!settled) {
        log.error('Durable webhook worker stop timed out; persisted cursors will replay after restart.');
    }
}

/**
 * Convenience wrapper for common webhook events.
 *
 * Legacy subscribers are fire-and-track. Durable subscribers are intentionally
 * skipped here and consume the canonical persisted AnalyticsEvent stream.
 */
export const webhooks = {
    ticketCreated: (ticketId: number, userId: string, messagePreview?: string): void => {
        dispatchWebhook('ticket.created', ticketId, userId, messagePreview || '');
    },
    ticketReplied: (ticketId: number, agentId: string, messagePreview?: string): void => {
        dispatchWebhook('ticket.replied', ticketId, null, messagePreview || '', { agent_id: agentId });
    },
    ticketClosed: (ticketId: number, userId: string): void => {
        dispatchWebhook('ticket.closed', ticketId, userId);
    },
    ticketBanned: (ticketId: number, userId: string): void => {
        dispatchWebhook('ticket.banned', ticketId, userId);
    },
    csatRated: (ticketId: number, rating: number, comment?: string): void => {
        dispatchWebhook('csat.rated', ticketId, null, '', { rating, comment });
    },
    ticketEscalated: (ticketId: number, reason: string): void => {
        dispatchWebhook('ticket.escalated', ticketId, null, '', { reason });
    },
};
