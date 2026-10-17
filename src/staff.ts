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
import * as manualIntake from './manual-intake';
import { isManualTicket } from './manual-ticket-guard';

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

function isLegacyTicketMessage(replyText: string): boolean {
  const { language } = cache.config;
  return replyText.includes(`${language.ticket} #T`)
    && replyText.includes(` ${language.from || 'from'} `)
    && replyText.includes(` ${language.language || 'language'}:`);
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

const MANUAL_REPLY_LIMIT = 3000;

/**
 * «Записать ответ» on a manual ticket: the text is staff history only. There
 * is no client channel, so nothing is sent, marked delivered or announced as sent.
 */
async function recordManualReply(ctx: Context, ticket: ISupportee, senderId: string, text: string, deliveryKey: string) {
  const ticketId = ticket.ticketId;
  const body = text.trim();
  if (!body) {
    await middleware.reply(ctx, 'Пустой ответ не записан.');
    return false;
  }
  if (body.length > MANUAL_REPLY_LIMIT) {
    await middleware.reply(ctx, `Ответ длиннее ${MANUAL_REPLY_LIMIT} символов и не записан. Сократите текст.`);
    return false;
  }
  // Keyed by Telegram update: a replayed update never writes a second history row.
  const created = await db.recordStaffWork(ticketId, senderId, body, deliveryKey);
  if (!created) return true;
  if (!ticket.first_response_at) await db.setFirstResponseAt(ticketId);
  db.recordAnalyticsEventBestEffort('ticket.work_recorded', ticketId, senderId, { manual: true });
  await middleware.reply(ctx, `Ответ записан в историю ручной заявки #T${ticketId.toString().padStart(6, '0')}. Клиенту ничего не отправлено.`);
  await middleware.reply(ctx, 'Запись сохранена. Куда перейти?', {
    message_thread_id: ctx.message.message_thread_id ?? undefined,
    reply_markup: { inline_keyboard: [[
      { text: '⬅️ К тикету', callback_data: `tc:open:${ticketId}` },
      { text: '🏠 Главная', callback_data: 'tm:home:0' },
    ]] },
  });
  await refreshStaffCard(ticketId);
  return true;
}

/** Handles replies written in the closed staff group. */
async function chat(ctx: Context) {
  if (!ctx.session.admin) return;
  if (cache.config.staffchat_id && String(ctx.chat.id) !== String(cache.config.staffchat_id)) return;
  const configuredThread = cache.config.staffchat_thread_id;
  if (configuredThread && ctx.message?.message_thread_id !== configuredThread) {
    await middleware.reply(ctx, 'Ответы на тикеты принимаются только в настроенной теме поддержки.');
    return;
  }

  const senderId = ctx.from.id.toString();
  if (!team.canPerformAction(senderId, 'reply')) {
    await middleware.reply(ctx, 'You do not have permission to reply to tickets.');
    return;
  }

  const replyMsg = ctx.message?.reply_to_message;
  const ordinaryText = !replyMsg && typeof ctx.message?.text === 'string' && !ctx.message.text.startsWith('/');
  let composeInput = false;
  let ticket: ISupportee | null = null;
  let ticketId = 0;
  // Replies belong to the existing ticket/prompt router. Only an ordinary
  // non-reply may be consumed by an explicitly active manual wizard step.
  if (ordinaryText && typeof db.findActiveReplyCompose === 'function') {
    const chatId = String(ctx.chat.id), threadId = ctx.message?.message_thread_id ?? null;
    const [compose, intake] = await Promise.all([
      db.findActiveReplyCompose(senderId, chatId, threadId),
      typeof db.findAnyActiveManualDraft === 'function' ? db.findAnyActiveManualDraft(senderId, chatId, threadId) : Promise.resolve(null),
    ]);
    if (compose && intake) {
      await middleware.reply(ctx, 'Обнаружены два активных ввода. Текст не использован: отмените один через его панель или Главную.', { message_thread_id: threadId ?? undefined });
      return;
    }
    if (compose) { ticket = compose; ticketId = compose.ticketId; composeInput = true; }
  }
  if (!composeInput && !replyMsg && typeof manualIntake.handleTextInput === 'function' && await manualIntake.handleTextInput(ctx)) return;
  if (!replyMsg && !composeInput) return;

  const replyText = replyMsg?.text || replyMsg?.caption || '';
  const replyToMessageId = (replyMsg as typeof replyMsg & { message_id?: number } | undefined)?.message_id;
  const correlatedMessageId = replyToMessageId ?? ctx.message.external_reply?.message_id;

  // Manual intake answers are bound to their own ForceReply prompt, never to a ticket.
  if (typeof replyToMessageId === 'number' && await manualIntake.handleFormReply(ctx, replyToMessageId)) return;

  if (!ticket && typeof correlatedMessageId === 'number') {
    ticket = await db.getTicketByInternalId(correlatedMessageId);
    if (ticket) ticketId = ticket.ticketId;
  }

  if (!ticket && replyText && isLegacyTicketMessage(replyText)) {
    const extractedId = extractTicketId(replyText);
    if (extractedId) {
      ticketId = parseInt(extractedId, 10);
      if (ticketId) ticket = await db.getTicketById(ticketId, ctx.session.groupCategory);
    }
  }

  if (!ticket && replyText && isLegacyTicketMessage(replyText)) {
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

  // Prompts are durable ticket state, so restart does not lose the selected ticket.
  if (composeInput || ticket.pending_reply_prompt_id === correlatedMessageId) {
    if (ticket.pending_reply_staff_id !== senderId || !ticket.pending_reply_expires_at || new Date(ticket.pending_reply_expires_at).getTime() < Date.now()) {
      const expired = !ticket.pending_reply_expires_at || new Date(ticket.pending_reply_expires_at).getTime() < Date.now();
      if (expired) {
        if (ticket.pending_reply_version == null) await db.clearReplyPrompt(ticketId, ticket.pending_reply_staff_id || undefined);
        else await db.clearReplyPrompt(ticketId, ticket.pending_reply_staff_id || undefined, ticket.pending_reply_version);
      }
      await middleware.reply(ctx, 'Запрос ответа истёк или принадлежит другому сотруднику. Нажмите кнопку ответа снова.');
      return;
    }
    // New prompts are bound to their exact Telegram surface. Treat an explicit
    // reply to one exactly like ordinary compose input so both routes share the
    // same atomic claim, fresh status/owner CAS and completion semantics.
    if (!composeInput && ticket.pending_reply_chat_id != null) {
      const actualThread = ctx.message.message_thread_id ?? null;
      if (ticket.pending_reply_chat_id !== String(ctx.chat.id)
        || (ticket.pending_reply_thread_id ?? null) !== actualThread) {
        await middleware.reply(ctx, 'Эта подсказка относится к другому чату или теме; текст не использован.',
          { message_thread_id: actualThread ?? undefined });
        return;
      }
      composeInput = true;
    }
    if (ticket.pending_reply_kind !== 'reply' && ticket.pending_reply_kind !== 'note') {
      if (ticket.pending_reply_version == null) await db.clearReplyPrompt(ticketId, senderId);
      else await db.clearReplyPrompt(ticketId, senderId, ticket.pending_reply_version);
      await middleware.reply(ctx, 'Тип подсказки не распознан. Нажмите «Ответить» или «Заметка» снова.');
      return;
    }
    if (ticket.pending_reply_kind === 'note') {
      const current = await db.getTicketById(ticketId, null);
      if (!current || current.status === 'closed' || !team.canManageTicket(senderId, current.assigned_to)) {
        await middleware.reply(ctx, 'Владелец или состояние тикета изменились; заметка не сохранена.');
        return;
      }
      let claim: string | null = null;
      if (composeInput && typeof db.claimReplyCompose === 'function') {
        claim = deliveryKey;
        const claimed = await db.claimReplyCompose(ticketId, senderId, String(ctx.chat.id), ctx.message.message_thread_id ?? null,
          ticket.pending_reply_version, claim, team.getStaffRole(senderId) === 'agent' ? senderId : undefined);
        if (!claimed) { await middleware.reply(ctx, 'Этот ввод уже обрабатывается или устарел; текст не использован.'); return; }
      }
      try { await team.addInternalNoteCommand(ctx, ticketId, staffMessage, deliveryKey); }
      catch (err) { if (claim) await db.releaseReplyCompose(ticketId, senderId, ticket.pending_reply_version, claim); throw err; }
      if (claim) await db.completeReplyCompose(ticketId, senderId, ticket.pending_reply_version, claim);
      else await db.clearReplyPrompt(ticketId, senderId);
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
    await refreshStaffCard(ticketId);
    return;
  }

  if (!team.canManageTicket(senderId, ticket.assigned_to)) {
    await middleware.reply(ctx, ticket.assigned_to
      ? 'This ticket is owned by another engineer.'
      : 'Take the ticket first with /take.');
    return;
  }

  if (composeInput && (!staffMessage.trim() || staffMessage.length > MANUAL_REPLY_LIMIT)) {
    await middleware.reply(ctx, !staffMessage.trim()
      ? 'Пустой текст не использован. Отправьте непустое сообщение или отмените ввод.'
      : `Текст длиннее ${MANUAL_REPLY_LIMIT} символов и не использован. Сократите его или отмените ввод.`,
    { message_thread_id: ctx.message.message_thread_id ?? undefined });
    return;
  }

  let composeClaim: string | null = null;
  if (composeInput && typeof db.claimReplyCompose === 'function') {
    composeClaim = deliveryKey;
    const claimed = await db.claimReplyCompose(ticketId, senderId, String(ctx.chat.id), ctx.message.message_thread_id ?? null,
      ticket.pending_reply_version, composeClaim, team.getStaffRole(senderId) === 'agent' ? senderId : undefined);
    if (!claimed) { await middleware.reply(ctx, 'Этот ввод уже обрабатывается или устарел; текст не использован.'); return; }
    ticket = claimed;
  }

  if (isManualTicket(ticket)) {
    try {
      const saved = await recordManualReply(ctx, ticket, senderId, staffMessage, deliveryKey);
      if (!saved) { if (composeClaim) await db.releaseReplyCompose(ticketId, senderId, ticket.pending_reply_version, composeClaim); return; }
      if (composeClaim) await db.completeReplyCompose(ticketId, senderId, ticket.pending_reply_version, composeClaim);
      else await db.clearReplyPrompt(ticketId, senderId);
    } catch (err) {
      if (composeClaim) await db.releaseReplyCompose(ticketId, senderId, ticket.pending_reply_version, composeClaim);
      throw err;
    }
    return;
  }

  cache.ticketStatus[ticketId] = false;

  try {
  if (ticket.userid.includes('WEB')) {
    // Persist before the external delivery side effect so a history failure is
    // safe to retry and can never replay an already delivered staff reply.
    const reserved = typeof db.reserveStaffReply === 'function'
      ? await db.reserveStaffReply(ticketId, senderId, staffMessage, deliveryKey) : null;
    if (reserved?.delivered_at) {
      if (composeClaim) await db.completeReplyCompose(ticketId, senderId, ticket.pending_reply_version, composeClaim);
      return;
    }
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
      throw e;
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
    if (reserved?.delivered_at) {
      if (composeClaim) await db.completeReplyCompose(ticketId, senderId, ticket.pending_reply_version, composeClaim);
      return;
    }
    if (!reserved) await db.persistTicketMessage(ticketId, 'staff', senderId, staffMessage);
    await middleware.sendMessage(ticket.userid, ticket.messenger, replyContent);
    if (reserved) await markDeliveredWithRetry(deliveryKey);
  }

  // The client transport has accepted the message. Retire only this fenced
  // compose version now; later analytics/navigation failures must not replay it.
  if (composeClaim) {
    await db.completeReplyCompose(ticketId, senderId, ticket.pending_reply_version, composeClaim);
    composeClaim = null;
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
  if (composeInput) {
    await middleware.reply(ctx, `✅ Ответ по #T${ticketId} отправлен клиенту ${name}.`, {
      message_thread_id: ctx.message.message_thread_id ?? undefined,
      reply_markup: { inline_keyboard: [[
        { text: '⬅️ К тикету', callback_data: `tc:open:${ticketId}` },
        { text: '🏠 Главная', callback_data: 'tm:home:0' },
      ]] },
    }).catch(log.error);
  }

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
  if (!composeInput && typeof db.clearReplyPrompt === 'function') await db.clearReplyPrompt(ticketId, senderId);
  await refreshStaffCard(ticketId);
  } catch (err) {
    if (composeClaim && typeof db.releaseReplyCompose === 'function')
      await db.releaseReplyCompose(ticketId, senderId, ticket.pending_reply_version, composeClaim).catch(log.error);
    throw err;
  }
}

export { chat, ticketMsg, extractSupporteeId, findParentCategory, forwardReplyToParent };
