import { Context } from './interfaces';

export type TicketMessageSourceKind = 'message' | 'edited';

/**
 * Build a stable ingress identity for append-only ticket history.
 *
 * The source id is intentionally scoped by messenger + chat and distinguishes
 * original messages from edits. WEB chat uses a shared mutable fake Context
 * with static ids, so it must remain append-only without source deduplication.
 */
export function getTicketMessageSourceId(
  ctx: Context,
  kind: TicketMessageSourceKind = 'message',
): string | undefined {
  const message = kind === 'edited' ? ctx.editedMessage : ctx.message;
  if (!message) return undefined;

  const senderId = String(message.from?.id ?? ctx.from?.id ?? '');
  if (senderId.startsWith('WEB')) return undefined;

  const messenger = String(ctx.messenger ?? '').trim();
  const chatId = String(message.chat?.id ?? ctx.chat?.id ?? '').trim();
  if (!messenger || !chatId) return undefined;

  if (Number.isSafeInteger(ctx.update_id) && ctx.update_id > 0) {
    return `${messenger}:${kind}:${chatId}:update:${ctx.update_id}`;
  }

  // Slack and Discord preserve their exact external message/event id here,
  // avoiding precision loss from their numeric Context.message.message_id.
  const externalEventId = String(ctx.callbackQuery?.id ?? '').trim();
  if (externalEventId) {
    return `${messenger}:${kind}:${chatId}:event:${externalEventId}`;
  }

  if (Number.isSafeInteger(message.message_id) && message.message_id > 0) {
    return `${messenger}:${kind}:${chatId}:message:${message.message_id}`;
  }

  return undefined;
}
