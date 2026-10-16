import { ISupportee, Supportee, TicketStatus } from './db';
import * as db from './db';
import cache from './cache';
import * as middleware from './middleware';
import * as webhooks from './webhooks';
import * as log from './logger';

/**
 * Compare-and-set transition for a ticket lifecycle state.
 * The update succeeds only while the ticket is still in one of expectedStates.
 */
export async function transitionTicketStateFrom(
  ticketId: number,
  expectedStates: TicketStatus | TicketStatus[],
  target: TicketStatus,
  expectedOwner?: string,
): Promise<ISupportee | null> {
  const states = Array.isArray(expectedStates) ? expectedStates : [expectedStates];
  const filter: Record<string, unknown> = { ticketId, status: { $in: states } };
  if (expectedOwner !== undefined) filter.assigned_to = expectedOwner;
  const ticket = await Supportee.findOneAndUpdate(
    filter,
    {
      $set: {
        status: target,
        closed_at: target === 'closed' ? new Date() : null,
      },
    },
    { new: true },
  );

  return ticket as ISupportee | null;
}

/** Resume exactly WAITING_USER -> OPEN. CLOSED must never be resurrected by a user reply. */
export function resumeWaitingTicket(ticketId: number): Promise<ISupportee | null> {
  return transitionTicketStateFrom(ticketId, 'waiting_user', 'open');
}

export async function closeTicketLifecycle(
  ticket: ISupportee,
  actorId: string,
  expectedOwner?: string,
): Promise<{ outcome: 'closed'|'already_closed'|'stale'; ticket: ISupportee | null; notificationFailed?: boolean }> {
  if (ticket.status === 'closed') return { outcome: 'already_closed', ticket };
  const closed = await transitionTicketStateFrom(ticket.ticketId, ['open', 'waiting_user'], 'closed', expectedOwner);
  if (!closed) {
    const current = await db.getTicketById(ticket.ticketId, null);
    return { outcome: current?.status === 'closed' ? 'already_closed' : 'stale', ticket: current };
  }
  const userId = ticket.userid;
  delete cache.ticketIDs[userId]; delete cache.ticketStatus[userId]; delete cache.ticketSent[userId];
  db.recordAnalyticsEventBestEffort('ticket.closed', ticket.ticketId, actorId);
  Promise.resolve(webhooks.webhooks.ticketClosed(ticket.ticketId, userId)).catch(log.error);
  let notificationFailed = false;
  try {
    await middleware.sendMessage(userId, ticket.messenger,
      `${cache.config.language.ticket} #T${String(ticket.ticketId).padStart(6, '0')} ${cache.config.language.closed}\n\n${cache.config.language.ticketClosed}`);
  } catch (err) { notificationFailed = true; log.error(err); }
  return { outcome: 'closed', ticket: closed, notificationFailed };
}
