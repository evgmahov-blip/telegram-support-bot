import { Context } from './interfaces';
import * as db from './db';
import { ISupportee } from './db';

export interface ResolvedTicket {
  ticket: ISupportee;
  ticketIdStr: string;
}

/**
 * Resolve the ticket represented by a replied staff-chat message.
 * New messages are correlated by Telegram message ID. Text parsing and user-id
 * extraction exist only for compatibility with historical messages that do not
 * have internalIds persisted in Mongo.
 */
export async function resolveTicketFromReply(
  ctx: Context,
  category: string | null = null,
): Promise<ResolvedTicket | null> {
  const reply = ctx.message?.reply_to_message;
  if (!reply) return null;

  const correlatedMessageId = reply.message_id ?? ctx.message.external_reply?.message_id;
  if (typeof correlatedMessageId === 'number') {
    const ticket = await db.getTicketByInternalId(correlatedMessageId);
    if (ticket) {
      return { ticket, ticketIdStr: ticket.ticketId.toString() };
    }
  }

  const replyText = reply.text || reply.caption || '';
  const ticketMatch = replyText.match(/#T0*(\d+)\b/);
  if (ticketMatch) {
    const ticketId = parseInt(ticketMatch[1], 10);
    if (Number.isSafeInteger(ticketId) && ticketId > 0) {
      const ticket = await db.getTicketById(ticketId, category);
      if (ticket) return { ticket, ticketIdStr: ticket.ticketId.toString() };
    }
  }

  const userMatch = replyText.match(/tg:\/\/user\?id=(\d+)/);
  if (userMatch) {
    const ticket = await db.getTicketByUserId(userMatch[1], category);
    if (ticket) return { ticket, ticketIdStr: ticket.ticketId.toString() };
  }

  return null;
}
