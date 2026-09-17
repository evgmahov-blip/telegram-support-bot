import axios from 'axios';
import cache from './cache';
import * as log from './logger'
import { WebhookEvent } from './interfaces';

export interface WebhookPayload {
    event: string;
    ticket_id: number;
    user_id: string | null;
    timestamp: string;
    message_preview?: string;
    metadata?: Record<string, any>;
}

const pendingWebhookDeliveries = new Set<Promise<void>>();

async function deliverWebhook(
    webhook: { url: string; secret?: string },
    event: WebhookEvent | string,
    payload: WebhookPayload,
): Promise<void> {
    try {
        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            'User-Agent': 'telegram-support-bot/5.0',
        };

        // Add HMAC signature if secret is configured.
        if (webhook.secret) {
            const crypto = await import('crypto');
            const sig = crypto.createHmac('sha256', webhook.secret)
                .update(JSON.stringify(payload))
                .digest('hex');
            headers['X-TSB-Signature'] = sig;
        }

        await axios.post(webhook.url, payload, {
            headers,
            timeout: 5000,
        });

        log.info(`Webhook sent to ${webhook.url} for event ${event}`);
    } catch (err) {
        // Legacy push delivery is compatibility-only. A failed endpoint must
        // never fail the ticket operation or another webhook delivery.
        log.error(`Webhook failed for ${webhook.url}:`, err);
    }
}

/**
 * Sends a webhook event to all configured subscribers. Endpoint deliveries run
 * concurrently so one slow integration cannot serialize the rest.
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
        (webhook) => Array.isArray(webhook.events) && webhook.events.includes(event as WebhookEvent),
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

/**
 * Convenience wrapper for common webhook events.
 *
 * These are deliberately fire-and-track: callers may still `await` them for
 * backward compatibility, but they return immediately and do not gate ticket
 * processing. Canonical persisted events remain the durable integration path.
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
