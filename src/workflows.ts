import cache from './cache';
import * as db from './db';
import * as middleware from './middleware';
import { Context } from './interfaces';
import * as log from './logger'
import { isBusinessTime } from './routing-policy';
import { maintainRouting } from './ticket-routing';
import { refreshStaffCard, recoverCommonReturns } from './ticket-ui';
import { flushRoutingSettingsAudit } from './routing-settings';
import { flushOrganizationBindingAudit } from './client-organization-binding';

/**
 * Checks if the current time is within business hours.
 */
export function isWithinBusinessHours(): boolean {
    const bh = cache.config.web_chat?.business_hours;
    if (!bh || !bh.enabled) return true;
    return isBusinessTime(new Date(), bh);
}

/**
 * Checks for auto-escalation rules and applies them.
 */
export async function checkEscalation(ticketId: number): Promise<void> {
    const rules = cache.config.escalation_rules || [];
    if (rules.length === 0) return;

    const ticket = await db.getTicketById(ticketId, null);
    if (!ticket) return;

    // Use first_response_at or fallback to analytics event for creation time
    let createdAt: Date | null = ticket.first_response_at;
    if (!createdAt) {
      const createdEvents = await db.getAnalyticsEvents('ticket.created');
      const ticketCreated = createdEvents.find((e: any) => e.ticketId === ticketId);
      if (ticketCreated) {
        createdAt = new Date(ticketCreated.timestamp);
      }
    }
    if (!createdAt) return;

    for (const rule of rules) {
        const hoursSinceCreated = (Date.now() - createdAt.getTime()) / (1000 * 60 * 60);
        if (hoursSinceCreated >= rule.after_hours && !ticket.assigned_to) {
            switch (rule.action) {
                case 'notify_supervisor':
                    // Find supervisors and notify them
                    for (const [id, member] of cache.staffMembers) {
                        if (member.role === 'supervisor') {
                            await middleware.sendMessage(
                                id,
                                cache.config.staffchat_type,
                                `${cache.config.language.escalationNotify} ${rule.after_hours}h — Ticket #T${ticketId.toString().padStart(6, '0')}`,
                                { parse_mode: cache.config.parse_mode },
                            );
                        }
                    }
                    await db.recordAnalyticsEvent('ticket.escalated', ticketId, null, { reason: `no_response_${rule.after_hours}h` });
                    break;

                case 'tag_urgent':
                    await db.setPriority(ticketId, 'urgent' as any);
                    await db.addTags(ticketId, ['auto-escalated']);
                    await db.recordAnalyticsEvent('ticket.escalated', ticketId, null, { reason: `auto_tag_${rule.after_hours}h` });
                    break;
            }
        }
    }
}

/**
 * Inactivity auto-close (auto_close_after_days). A closure needs the engineer's
 * recorded cause and performed work, which an unattended job cannot provide,
 * so eligible tickets are only reported and stay open; nothing is invented.
 */
export async function checkAutoClose(): Promise<number> {
    const days = cache.config.auto_close_after_days || 0;
    if (days <= 0) return 0;

    let stale = 0;
    try {
        const cutoffDate = new Date(Date.now() - days * 86400000);
        const openTickets = await db.Supportee.find({ status: 'open' });

        for (const ticket of openTickets) {
            // Check if there's been recent activity
            const messages = await db.TicketMessage.find({ ticketId: ticket.ticketId })
                .sort({ timestamp: -1 })
                .limit(1);

            if (messages.length === 0 || new Date(messages[0].timestamp) < cutoffDate) stale += 1;
        }
        if (stale > 0) {
            log.info(`Автозакрытие по неактивности отключено: ${stale} заявок без активности ${days} дн. остаются открытыми — закрытие требует причины и выполненных работ.`);
        }
    } catch (err) {
        log.error('Error in auto-close check:', err);
    }
    return stale;
}

/**
 * Gets a canned response by key.
 */
export function getCannedResponse(key: string): string | null {
    const responses = cache.config.canned_responses || [];
    const found = responses.find((r) => r.key.toLowerCase() === key.toLowerCase());
    return found ? found.text : null;
}

/**
 * Lists all available canned response keys.
 */
export function listCannedResponses(): string {
    const responses = cache.config.canned_responses || [];
    if (responses.length === 0) return 'No canned responses configured.';

    let output = '*Available templates:*\n\n';
    for (const resp of responses) {
        output += `/${resp.key} — ${resp.text.substring(0, 50)}${resp.text.length > 50 ? '...' : ''}\n`;
    }
    return output;
}

/**
 * Handles canned response command. Staff types /template_key to insert the template text.
 */
export async function handleCannedResponse(ctx: Context, key: string): Promise<string | null> {
    const text = getCannedResponse(key);
    if (!text) return null;
    return text;
}

/**
 * Runs periodic workflow checks (auto-close, escalation).
 * Should be called from a setInterval in the main index.ts.
 */
export async function runWorkflowChecks(): Promise<void> {
    if (db.Supportee) await maintainRouting(new Date(), undefined, ticket => refreshStaffCard(ticket.ticketId));
    if (db.Supportee) await recoverCommonReturns().catch(err => log.error('Common return recovery failed:', err));
    await flushRoutingSettingsAudit();
    if (db.ClientProfile) await flushOrganizationBindingAudit();
    await checkAutoClose();
    log.info('Workflow checks completed.');
}
