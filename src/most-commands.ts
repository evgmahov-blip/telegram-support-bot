import { Context } from './interfaces';
import { ISupportee } from './db';
import * as db from './db';
import * as team from './team';
import * as ticketQueue from './ticket-queue';
import * as middleware from './middleware';
import { resolveTicketFromReply } from './ticket-resolution';

async function resolveRepliedTicket(ctx: Context): Promise<ISupportee | null> {
  const resolved = await resolveTicketFromReply(ctx, null);
  return resolved?.ticket ?? null;
}

async function requireRepliedTicket(ctx: Context): Promise<ISupportee | null> {
  const ticket = await resolveRepliedTicket(ctx);
  if (!ticket) {
    await middleware.reply(ctx, 'Reply to a ticket message.');
    return null;
  }
  return ticket;
}

export async function takeCommand(ctx: Context): Promise<void> {
  if (!ctx.session.admin) return;
  const ticket = await requireRepliedTicket(ctx);
  if (!ticket) return;
  await team.takeTicketCommand(ctx, ticket.ticketId);
}

export async function transferCommand(ctx: Context): Promise<void> {
  if (!ctx.session.admin) return;
  const targetId = ctx.match?.trim();
  if (!targetId) {
    await middleware.reply(ctx, 'Usage: /transfer <staff_telegram_id>');
    return;
  }

  const ticket = await requireRepliedTicket(ctx);
  if (!ticket) return;
  await team.transferTicketCommand(ctx, targetId, ticket.ticketId);
}

export async function waitingCommand(ctx: Context): Promise<void> {
  if (!ctx.session.admin) return;
  const ticket = await requireRepliedTicket(ctx);
  if (!ticket) return;
  await team.waitingUserCommand(ctx, ticket.ticketId);
}

/**
 * Shows or changes the queue for the replied active ticket.
 * Agents may move only tickets they own; supervisors/admins may move any ticket.
 */
export async function queueCommand(ctx: Context): Promise<void> {
  if (!ctx.session.admin) return;

  const ticket = await requireRepliedTicket(ctx);
  if (!ticket) return;

  const actorId = ctx.from.id.toString();
  const role = team.getStaffRole(actorId);
  if (!role) {
    await middleware.reply(ctx, 'You do not have permission to manage queues.');
    return;
  }

  const requested = ctx.match?.trim() || '';
  const available = ticketQueue.listQueues();
  const currentQueue = await ticketQueue.getTicketQueue(ticket.ticketId);

  if (!requested) {
    await middleware.reply(
      ctx,
      `Queue: ${currentQueue}. Available: ${available.join(', ')}. Usage: /queue <name>`,
    );
    return;
  }

  const targetQueue = ticketQueue.resolveQueueName(requested);
  if (!targetQueue) {
    await middleware.reply(ctx, `Unknown queue. Available: ${available.join(', ')}`);
    return;
  }

  if (!team.canManageTicket(actorId, ticket.assigned_to)) {
    await middleware.reply(ctx, ticket.assigned_to
      ? 'Only the ticket owner, a supervisor, or an admin can change its queue.'
      : 'Take the ticket first with /take.');
    return;
  }

  if (currentQueue === targetQueue) {
    await middleware.reply(ctx, `Ticket is already in queue ${targetQueue}.`);
    return;
  }

  const expectedOwner = role === 'agent' ? actorId : undefined;
  const moved = await ticketQueue.moveTicketToQueue(ticket.ticketId, targetQueue, expectedOwner);
  if (!moved) {
    await middleware.reply(ctx, 'Ticket owner or state changed before the queue move completed.');
    return;
  }

  await middleware.reply(
    ctx,
    `Ticket #T${ticket.ticketId.toString().padStart(6, '0')} → queue ${targetQueue}.`,
  );
  await db.recordAnalyticsEvent('ticket.queue_changed', ticket.ticketId, actorId, {
    from: currentQueue,
    to: targetQueue,
  });
}

export { resolveRepliedTicket };
