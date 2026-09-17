import { Context } from './interfaces';
import * as db from './db';
import * as team from './team';
import * as middleware from './middleware';

/**
 * Resolve the ticket represented by a replied staff-chat message.
 * Message-id correlation is authoritative; ticket text parsing is only a
 * compatibility fallback for messages that predate internalIds tracking.
 */
async function resolveRepliedTicket(ctx: Context): Promise<db.ISupportee | null> {
  const reply = ctx.message?.reply_to_message;
  if (!reply) return null;

  const internalId = (reply as typeof reply & { message_id?: number }).message_id;
  if (typeof internalId === 'number') {
    const correlated = await db.getTicketByInternalId(internalId);
    if (correlated) return correlated;
  }

  const text = reply.text || reply.caption || '';
  const match = text.match(/#T0*(\d+)\b/);
  if (!match) return null;

  const ticketId = parseInt(match[1], 10);
  if (!Number.isSafeInteger(ticketId) || ticketId <= 0) return null;
  return await db.getTicketById(ticketId, null);
}

async function requireRepliedTicket(ctx: Context): Promise<db.ISupportee | null> {
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

export { resolveRepliedTicket };
