import { Context } from './interfaces';
import { ISupportee } from './db';
import * as team from './team';
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

export { resolveRepliedTicket };
