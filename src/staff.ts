import cache from './cache';
import * as middleware from './middleware';
import * as db from './db';
import { Context } from './interfaces';
import { ISupportee } from './db';
import * as log from './logger'
import * as webhooks from './webhooks';
import * as analytics from './analytics';
import * as team from './team';
import { refreshStaffCard } from './ticket-ui';

/**
 * Generates user-facing staff text. MOST never exposes the engineer identity to
 * the user; replies are signed only with the configured support-team label.
 */
function ticketMsg(
  name: string,
  message: { text: any; from: { first_name: any } },
): string {
  const esc = middleware.strictEscape;
  const { config } = cache;
  if (config.clean_replies) {
    return esc(message.text);
  }
  return `${config.language.dear} ${esc(name)},\n\n${esc(message.text)}\n\n${config.language.regards}\n${config.language.regardsGroup}`;
}

/** Compatibility-only resolver for historical ticket text. */
function extractTicketId(replyText: string): string | null {
  const match = replyText.match(/#T0*(\d+)\b/);
  return match ? match[1] : null;
}

/** Compatibility-only user-id resolver for historical forwarded messages. */
function extractSupporteeId(replyText: string): string | null {
  const linkMatch = replyText.match(/tg:\/\/user\?id=(\d+)/);
  if (linkMatch) return linkMatch[1];

  const mdMatch = replyText.match(/\[.*?\]\(tg:\/\/user\?id=(\d+)\)/);
  if (mdMatch) return mdMatch[1];

  return null;
}

function extractName(replyText: string): string | null {
  const { language } = cache.config;
  const fromToken = language.from || 'from';
  const languageToken = language.language || 'language';
  const start = replyText.indexOf(`${fromToken} `);
  const end = replyText.indexOf(` ${languageToken}:`, start + fromToken.length + 1);
  if (start < 0 || end < 0) return null;
  return replyText.slice(start + fromToken.length + 1, end).trim() || null;
}

function findParentCategory(ticketCategory: string | null, chatId: string | number) {
  const { categories } = cache.config;
  if (!Array.isArray(categories)) return null;
  for (const category of categories) {
    if (!Array.isArray(category.subgroups) || category.subgroups.length === 0) continue;
    const matches = category.subgroups.some(
      (sub) => sub.name === ticketCategory || String(sub.group_id) === String(chatId),
    );
    if (matches && category.group_id && String(category.group_id) !== String(chatId)) {
      return category;
    }
  }
  return null;
}

async function forwardReplyToParent(ctx: Context, ticket: ISupportee, staffMessage: string): Promise<void> {
  if (!cache.config.forward_replies_to_parent) return;
  const parent = findParentCategory(ticket.category, ctx.chat.id);
  if (!parent) return;
  const esc = middleware.strictEscape;
  const { language, staffchat_type } = cache.config;
  const text = `${language.ticket} #T${ticket.ticketId.toString().padStart(6, '0')} ${language.acceptedBy} ${esc(ctx.message.from.first_name)}:\n\n${esc(staffMessage)}`;
  await middleware.sendMessage(parent.group_id, staffchat_type, text).catch(log.error);
}

const POST_DELIVERY_TRANSITION_ATTEMPTS = 3;

async function markDeliveredWithRetry(deliveryKey: string): Promise<void> {
  let last: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try { await db.markStaffReplyDelivered(deliveryKey); return; } catch (err) { last = err; }
  }
  // Telegram already accepted the reply. Throwing here would release the
  // ingress claim and immediately replay an already delivered message.
  log.error(`Критично: не удалось закрепить доставку ${deliveryKey}.`, last);
}

/** Retry post-delivery state changes locally; never replay the user-facing reply. */
async function transitionTicketAfterDelivery(
  ticketId: number,
  target: db.TicketStatus,
): Promise<ISupportee | null> {
  let lastError: unknown = null;

  for (let attempt = 0; attempt < POST_DELIVERY_TRANSITION_ATTEMPTS; attempt += 1) {
    try {
      return await db.transitionTicketStatus(ticketId, target);
    } catch (err) {
      lastError = err;
    }
  }

  log.error(`Post-delivery ticket transition failed for #T${ticketId} -> ${target}:`, lastError);
  return null;
}

/** Handles replies written in the closed staff group. */
async function chat(ctx: Context) {
  if (!ctx.session.admin) return;

  const senderId = ctx.from.id.toString();
  if (!team.canPerformAction(senderId, 'reply')) {
    await middleware.reply(ctx, 'You do not have permission to reply to tickets.');
    return;
  }

  const replyMsg = ctx.message?.reply_to_message;
  if (!replyMsg) return;

  const replyText = replyMsg.text || replyMsg.caption || '';
  const replyToMessageId = (replyMsg as typeof replyMsg & { message_id?: number }).message_id;
  const correlatedMessageId = replyToMessageId ?? ctx.message.external_reply?.message_id;

  let ticket: ISupportee | null = null;
  let ticketId = 0;

  if (typeof correlatedMessageId === 'number') {
    ticket = await db.getTicketByInternalId(correlatedMessageId);
    if (ticket) ticketId = ticket.ticketId;
  }

  if (!ticket && replyText) {
    const extractedId = extractTicketId(replyText);
    if (extractedId) {
      ticketId = parseInt(extractedId, 10);
      if (ticketId) ticket = await db.getTicketById(ticketId, ctx.session.groupCategory);
    }
  }

  if (!ticket && replyText) {
    const supporteeId = extractSupporteeId(replyText);
    if (supporteeId) {
      ticket = await db.getTicketByUserId(supporteeId, ctx.session.groupCategory);
      if (ticket) ticketId = ticket.ticketId;
    }
  }

  if (!ticket || !ticketId || ticket.status === 'closed') {
    await middleware.reply(ctx, cache.config.language.ticketClosedError);
    return;
  }

  let name: string | null = ticket.name || extractName(replyText);
  if (!name) name = cache.config.language.customer || 'customer';

  const staffMessage = ctx.message.text || '';
  const deliveryKey = `telegram:${ctx.update_id || ctx.message.message_id}:ticket:${ticketId}`;

  const isPromptReply = /^(Ответ для|🔒 Заметка для) #T\d+/.test(replyText);
  if (isPromptReply && ticket.pending_reply_prompt_id !== correlatedMessageId) {
    await middleware.reply(ctx, 'Эта подсказка отменена, истекла или заменена. Нажмите кнопку в актуальной карточке.');
    return;
  }

  // Prompts are durable ticket state, so restart does not lose the selected ticket.
  if (ticket.pending_reply_prompt_id === correlatedMessageId) {
    if (ticket.pending_reply_staff_id !== senderId || !ticket.pending_reply_expires_at || new Date(ticket.pending_reply_expires_at).getTime() < Date.now()) {
      await db.clearReplyPrompt(ticketId);
      await middleware.reply(ctx, 'Запрос ответа истёк или принадлежит другому сотруднику. Нажмите «Ответить» снова.');
      return;
    }
    if (replyText.startsWith('🔒 Заметка')) {
      const current = await db.getTicketById(ticketId, null);
      if (!current || current.status === 'closed' || !team.canManageTicket(senderId, current.assigned_to)) {
        await middleware.reply(ctx, 'Владелец или состояние тикета изменились; заметка не сохранена.');
        return;
      }
      await team.addInternalNoteCommand(ctx, ticketId, staffMessage);
      await db.clearReplyPrompt(ticketId, senderId);
      await refreshStaffCard(ticketId);
      return;
    }
  }

  if (staffMessage.startsWith('!note ') || staffMessage.startsWith('!internal ')) {
    if (!team.canManageTicket(senderId, ticket.assigned_to)) {
      await middleware.reply(ctx, 'Только текущий владелец активного тикета может добавить заметку.');
      return;
    }
    const noteText = staffMessage.replace(/^!(?:note|internal)\s+/i, '');
    await team.addInternalNoteCommand(ctx, ticketId, noteText);
    return;
  }

  if (!team.canManageTicket(senderId, ticket.assigned_to)) {
    await middleware.reply(ctx, ticket.assigned_to
      ? 'This ticket is owned by another engineer.'
      : 'Take the ticket first with /take.');
    return;
  }

  cache.ticketStatus[ticketId] = false;

  if (ticket.userid.includes('WEB')) {
    // Persist before the external delivery side effect so a history failure is
    // safe to retry and can never replay an already delivered staff reply.
    const reserved = typeof db.reserveStaffReply === 'function'
      ? await db.reserveStaffReply(ticketId, senderId, staffMessage, deliveryKey) : null;
    if (reserved?.delivered_at) return;
    if (!reserved) await db.persistTicketMessage(ticketId, 'staff', senderId, staffMessage);
    try {
      const socketId = ticket.userid.split('WEB')[1];
      cache.io.to(socketId).emit('chat_staff', ticketMsg(name, ctx.message));
      if (reserved) await markDeliveredWithRetry(deliveryKey);
    } catch (e) {
      middleware.sendMessage(
        ctx.chat.id,
        ticket.messenger,
        'Web chat already closed.',
      ).catch(log.error);
      log.error('Web reply delivery failed', e);
      return;
    }
  } else {
    let replyContent = ticketMsg(name, ctx.message);
    if (cache.config.translate_enabled) {
      const translated = await import('./addons/llm.js').then(m => m.translateText(staffMessage));
      if (translated) {
        replyContent = ticketMsg(name, { text: translated, from: ctx.message.from });
      }
    }

    // Translation is still pre-delivery and may safely fail/retry. Once the
    // immutable history write succeeds, the only remaining throwing operation
    // before the delivery boundary is the delivery itself.
    const reserved = typeof db.reserveStaffReply === 'function'
      ? await db.reserveStaffReply(ticketId, senderId, staffMessage, deliveryKey) : null;
    if (reserved?.delivered_at) return;
    if (!reserved) await db.persistTicketMessage(ticketId, 'staff', senderId, staffMessage);
    await middleware.sendMessage(ticket.userid, ticket.messenger, replyContent);
    if (reserved) await markDeliveredWithRetry(deliveryKey);
  }

  if (!ticket.first_response_at) {
    await db.setFirstResponseAt(ticketId);
  }
  db.recordAnalyticsEventBestEffort('ticket.message.staff', ticketId, senderId);

  middleware.sendMessage(
    ctx.chat.id,
    cache.config.staffchat_type,
    `${cache.config.language.msg_sent} ${middleware.strictEscape(name)}`,
  ).catch(log.error);

  log.info(`Staff reply sent for #T${ticketId}`);
  delete cache.ticketSent[ticketId];

  await forwardReplyToParent(ctx, ticket, staffMessage);
  db.recordAnalyticsEventBestEffort('ticket.replied', ticketId, senderId);
  webhooks.webhooks.ticketReplied(ticketId, senderId, staffMessage.substring(0, 200));

  if (cache.config.auto_close_tickets) {
    const closed = await transitionTicketAfterDelivery(ticketId, 'closed');
    if (closed) {
      db.recordAnalyticsEventBestEffort('ticket.closed', ticketId, senderId);
      webhooks.webhooks.ticketClosed(ticketId, senderId);
      await analytics.sendCSATSurvey(ticket.userid, ticket.messenger, ticketId).catch((err) => {
        log.error(`CSAT delivery failed after closing #T${ticketId}:`, err);
      });
    }
  }
  if (typeof db.clearReplyPrompt === 'function') await db.clearReplyPrompt(ticketId, senderId);
  await refreshStaffCard(ticketId);
}

export { chat, ticketMsg, extractSupporteeId, findParentCategory, forwardReplyToParent };
