import cache from './cache';
import * as db from './db';
import * as middleware from './middleware';
import { Context } from './interfaces';
import * as log from './logger';
import { persistStaffMessageCorrelation } from './staff-correlation';

/**
 * Forwards an edited user message to the staff chat (forward_edited_messages, #147).
 *
 * Only edits of users in private chats are handled: the staff chat gets a new message
 * marked as edited, so the ticket history stays complete. Staff edits are not forwarded
 * because the reply already reached the user.
 *
 * @returns true when a notification was sent.
 */
export async function handleEditedMessage(ctx: Context): Promise<boolean> {
  const { config } = cache;
  if (!config.forward_edited_messages) return false;

  const msg = ctx.editedMessage;
  if (!msg || !msg.text) return false;
  if (ctx.chat.type !== 'private' || ctx.session.admin) return false;

  const userId = msg.from.id.toString();
  const ticket = await db.getTicketByUserId(userId, ctx.session.groupCategory);
  if (!ticket || ticket.status !== 'open') return false;

  const esc = middleware.strictEscape;
  const paddedId = ticket.ticketId.toString().padStart(6, '0');
  const name = config.anonymous_tickets
    ? msg.from.first_name
    : `[${esc(msg.from.first_name)}](tg://user?id=${userId})`;
  const text = `${config.language.ticket} #T${paddedId} ${config.language.from} ${name} ${config.language.editedMessage}:\n\n${esc(msg.text)}`;

  // Persist immutable history before any external side effect. If this fails,
  // ingress can safely retry without duplicating a staff notification.
  await db.persistTicketMessage(
    ticket.ticketId,
    'user',
    userId,
    `[${config.language.editedMessage}] ${msg.text}`,
  );

  // Primary staff delivery is authoritative for ingress success. A transport
  // failure must reject so the fenced Telegram update can be retried.
  const staffMessageId = await middleware.sendMessage(
    config.staffchat_id,
    config.staffchat_type,
    text,
  );
  if (staffMessageId) {
    await persistStaffMessageCorrelation(ticket.ticketId, staffMessageId, msg.from.first_name);
  }

  // Category mirrors are secondary staff surfaces and remain best-effort.
  if (ctx.session.group && ctx.session.group !== config.staffchat_id) {
    await middleware.sendMessage(ctx.session.group, ticket.messenger, text).catch(log.error);
  }

  db.recordAnalyticsEventBestEffort('ticket.message.user', ticket.ticketId, userId);
  return true;
}
