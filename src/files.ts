import * as db from './db';
import cache from './cache';
import { reply, sendMessage } from './middleware';
import { Addon, Context } from './interfaces';
import { ISupportee } from './db';
import * as ticketState from './ticket-state';
import * as team from './team';
import * as log from './logger'
import { persistStaffMessageCorrelation } from './staff-correlation';
import { refreshStaffCard } from './ticket-ui';
import { isManualTicket } from './manual-ticket-guard';
import * as visibility from './ticket-visibility';
import * as clientOrganization from './client-organization';
import * as routing from './ticket-routing';

const escapeRegex = (str: string): string => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function resolveStaffFileTicket(ctx: Context): Promise<ISupportee | null> {
  const replyMessage = ctx.message?.reply_to_message;
  if (!replyMessage) return null;

  const replyMessageId = (replyMessage as typeof replyMessage & { message_id?: number }).message_id;
  const correlatedMessageId = replyMessageId ?? ctx.message.external_reply?.message_id;
  if (typeof correlatedMessageId === 'number') {
    const correlated = await db.getTicketByInternalId(correlatedMessageId);
    if (correlated) return correlated;
  }

  // Compatibility fallback for historical staff messages without persisted ids.
  const replyText = replyMessage.text || replyMessage.caption || '';
  const match = replyText.match(/#T0*(\d+)\b/);
  if (!match) return null;

  return await db.getTicketById(parseInt(match[1], 10), ctx.session.groupCategory);
}

/**
 * Handles forwarding of files (document, photo, video, sticker).
 * Users send files to staff surfaces; engineers reply with files only from the
 * closed staff group and delivery to the user always goes through the bot.
 */
async function fileHandler(type: string, bot: Addon, ctx: Context) {
  const { message, session } = ctx;
  const { config } = cache;
  const actor = String(ctx.from.id);
  const privateStaff = ctx.chat?.type === 'private' && String(ctx.chat.id) === actor && Boolean(team.getStaffRole(actor));
  const staffInput = session.admin || privateStaff;
  let mediaClaim: string | null = null;
  let ticket: ISupportee | null = null;
  let replyText = '';
  let userInfo: string | undefined;

  if (staffInput) {
    const actorId = ctx.from.id.toString();
    if (!team.canPerformAction(actorId, 'reply')) {
      await reply(ctx, 'У вас нет прав отвечать по заявкам.');
      return;
    }

    if (privateStaff) {
      ticket = await db.findActiveReplyCompose(actor, String(ctx.chat.id), null);
      const replied = (message.reply_to_message as { message_id?: number } | undefined)?.message_id;
      if (!ticket || ticket.pending_reply_kind !== 'reply' || (replied && replied !== ticket.pending_reply_prompt_id)) {
        await reply(ctx, 'Откройте личную карточку и выберите «Написать клиенту».'); return;
      }
    } else ticket = await resolveStaffFileTicket(ctx);
    if (!ticket) {
      await reply(ctx, config.language.ticketClosedError);
      return;
    }
    if (ticket.status === 'closed') {
      await reply(ctx, config.language.ticketClosedError);
      return;
    }
    if (!team.canManageTicket(actorId, ticket.assigned_to)) {
      await reply(ctx, ticket.assigned_to
        ? 'Эта заявка назначена другому сотруднику.'
        : 'Сначала возьмите заявку командой /take.');
      return;
    }

    // A manual ticket has no client channel: never send or record a file as delivered.
    if (isManualTicket(ticket)) {
      await reply(ctx, 'Ручная заявка: файлы клиенту не отправляются. Запишите результат текстом через «Записать ответ».');
      return;
    }

    replyText = message.reply_to_message?.text || message.reply_to_message?.caption || '';
  } else {
    userInfo = await forwardFile(ctx);
    if (userInfo === undefined) return;
    ticket = await db.getTicketByUserId(message.from.id.toString(), session.groupCategory);
    if (!ticket || ticket.status === 'closed') {
      await reply(ctx, config.language.textFirst);
      return;
    }
  }

  if (!staffInput && ticket.routing?.state === 'offered') {
    await routing.deliverOffer(ticket);
    const offered = await db.getTicketById(ticket.ticketId, null);
    if (!offered) return;
    ticket = offered;
  }
  const current = await visibility.freshTicket(ticket);
  if (!current) return;
  ticket = current;
  if (staffInput && (ctx.chat?.type !== 'private' && !visibility.isCommonTicket(ticket))) {
    await reply(ctx, 'Откройте личную карточку в боте.'); return;
  }
  let receiverId: string | number = config.staffchat_id;
  let captionText = `${config.language.ticket} #T${ticket.ticketId
    .toString()
    .padStart(6, '0')} ${userInfo ?? ''}\n${message.caption || ''}`;

  if (staffInput) {
    receiverId = ticket.userid;
    captionText = message.caption || '';
  }
  // A personal ticket's client media goes only to its registered owner's bot DM.
  const personalRoute = !staffInput && !visibility.isCommonTicket(ticket);
  const candidateOwner = ticket.routing?.state === 'offered' ? ticket.routing.offered_to : ticket.assigned_to;
  const personalOwner = personalRoute && candidateOwner && team.getStaffRole(candidateOwner) ? candidateOwner : null;
  if (personalOwner) receiverId = personalOwner;

  if (!['document', 'photo', 'video', 'sticker'].includes(type)) return;
  if (type === 'sticker' && !bot.sendSticker) return;

  // The legacy web widget supports text only. Do not persist a staff file as
  // delivered and do not throw into ingress/retry for a transport that cannot
  // ever handle media.
  if (staffInput && ticket.userid.includes('WEB')) {
    await reply(ctx, 'Отправка файлов в веб-чат не поддерживается.');
    return;
  }

  const fileResult = await ctx.getFile();
  const fileId = (fileResult as { file_id: string }).file_id;
  const quiet = staffInput || ticket.routing?.state === 'offered' || !(ctx as any).staffImportantEvent;
  const commonOptions = { caption: captionText, disable_notification: quiet };

  // Persist immutable conversation history before the primary external
  // delivery side effect. A failure here is safe for ingress to retry.
  const historyText = `[file:${type}]${message.caption ? ` ${message.caption}` : ''}`;
  await db.persistTicketMessage(
    ticket.ticketId,
    staffInput ? 'staff' : 'user',
    staffInput ? ctx.from.id.toString() : message.from.id.toString(),
    historyText,
  );

  let messageId: string | null | undefined;
  const shouldForwardToGroup = (
    !personalRoute &&
    !staffInput &&
    session.group !== '' &&
    session.group !== config.staffchat_id
  );

  try {
    const live = await visibility.freshTicket(ticket);
    if (!live || (staffInput && !team.canManageTicket(String(ctx.from.id), live.assigned_to))) return;
    if (privateStaff) {
      mediaClaim = `telegram:${ctx.update_id || message.message_id}:ticket:${ticket.ticketId}:media`;
      const claimed = await db.claimReplyCompose(ticket.ticketId, actor, String(ctx.chat.id), null,
        ticket.pending_reply_version, mediaClaim, ticket.assigned_to ?? undefined);
      if (!claimed) { await reply(ctx, 'Ввод устарел или уже обрабатывается.'); return; }
      ticket = claimed;
      if (!await visibility.freshTicket(ticket)) return;
    }
    if (personalRoute && !personalOwner) throw new Error(`Owner of personal ticket #T${ticket.ticketId} is not registered staff`);
    switch (type) {
      case 'document':
        messageId = await bot.sendDocument(receiverId, fileId, commonOptions) as string | null;
        break;
      case 'photo':
        messageId = await bot.sendPhoto(receiverId, fileId, commonOptions) as string | null;
        break;
      case 'video':
        messageId = await bot.sendVideo(receiverId, fileId, commonOptions) as string | null;
        break;
      case 'sticker': {
        const stickerMessageId = await bot.sendSticker!(receiverId, fileId, { disable_notification: quiet });
        messageId = typeof stickerMessageId === 'string' ? stickerMessageId : null;
        break;
      }
      default:
        return;
    }
  } catch (err) {
    if (privateStaff && mediaClaim) {
      log.error('Private media outcome UNKNOWN; compose remains claimed', err);
      await reply(ctx, 'Результат отправки не подтверждён. Проверьте историю; автоматического повтора не будет.'); return;
    }
    if (!personalRoute) throw err;
    log.error(`Личный чат владельца заявки #T${ticket.ticketId} недоступен для файла:`, err);
    messageId = null;
  }

  // Media addons report transport failure by returning null rather than
  // rejecting. Surface that failure so fenced ingress releases the update for
  // retry instead of recording a delivery that never happened. No secondary
  // side effect is started until this primary boundary is confirmed.
  // A blocked owner DM is not retryable and never falls back to the shared chat.
  if (!messageId && privateStaff && mediaClaim) {
    log.error('Private media outcome UNKNOWN; compose remains claimed');
    await reply(ctx, 'Результат отправки не подтверждён. Проверьте историю; автоматического повтора не будет.'); return;
  }
  if (messageId && mediaClaim) await db.completeReplyCompose(ticket.ticketId, actor, ticket.pending_reply_version, mediaClaim);
  if (!messageId && personalRoute) {
    log.error('Personal media delivery unavailable or UNKNOWN; no shared fallback');
  } else if (!messageId) {
    throw new Error(
      `Primary ${type} delivery failed for #T${ticket.ticketId} to ${receiverId}`,
    );
  }

  if (messageId && type === 'sticker' && captionText.trim()) {
    const headerMessenger = staffInput ? ticket.messenger : config.staffchat_type;
    sendMessage(receiverId, headerMessenger, captionText, { disable_notification: true }).catch(log.error);
  }

  if (shouldForwardToGroup && await visibility.freshTicket(ticket)) {
    switch (type) {
      case 'document':
        Promise.resolve(bot.sendDocument(session.group, fileId, { caption: captionText, disable_notification: quiet })).catch(log.error);
        break;
      case 'photo':
        Promise.resolve(bot.sendPhoto(session.group, fileId, { caption: captionText, disable_notification: quiet })).catch(log.error);
        break;
      case 'video':
        Promise.resolve(bot.sendVideo(session.group, fileId, { caption: captionText, disable_notification: quiet })).catch(log.error);
        break;
      case 'sticker':
        Promise.resolve(bot.sendSticker!(session.group, fileId, { disable_notification: quiet })).catch(log.error);
        break;
    }
  }

  // Correlation ids are staff-chat message ids only. A staff -> user Telegram
  // message id belongs to another chat and must never enter internalIds.
  if (messageId && !staffInput && !personalRoute) {
    await persistStaffMessageCorrelation(
      ticket.ticketId,
      messageId,
      ctx.message.from.first_name,
    );
  }
  await refreshStaffCard(ticket.ticketId);

  if (staffInput) {
    const actorId = ctx.from.id.toString();
    if (!ticket.first_response_at) await db.setFirstResponseAt(ticket.ticketId);
    db.recordAnalyticsEventBestEffort(
      'ticket.message.staff',
      ticket.ticketId,
      actorId,
      { kind: 'file', type },
    );
    db.recordAnalyticsEventBestEffort(
      'ticket.replied',
      ticket.ticketId,
      actorId,
      { kind: 'file', type },
    );
  } else {
    db.recordAnalyticsEventBestEffort(
      'ticket.message.user',
      ticket.ticketId,
      message.from.id.toString(),
      { kind: 'file', type },
    );
  }

  if (!config.autoreply_confirmation) return;

  let confirmationMessage = `${config.language.confirmationMessage}${config.show_user_ticket
    ? config.language.yourTicketId + ' #T' + ticket.ticketId.toString().padStart(6, '0')
    : ''}`;

  if (staffInput) {
    const nameMatch = replyText.match(
      new RegExp(`${escapeRegex(config.language.from)} (.*) ${escapeRegex(config.language.language)}`)
    );
    confirmationMessage = nameMatch
      ? `${config.language.file_sent} ${nameMatch[1]}`
      : config.language.file_sent;
  }

  sendMessage(ctx.chat.id, ticket.messenger, confirmationMessage).catch(log.error);
};

/**
 * Ensures an incoming user file belongs to an active ticket and applies the same
 * account ban and lifecycle rules as incoming text.
 */
async function forwardFile(ctx: Context): Promise<string | undefined> {
  if (ctx.session.admin) return undefined;

  const userId = ctx.message.from.id.toString();
  cache.userId = userId;

  if (await db.checkBan(userId, ctx.messenger)) {
    await reply(ctx, cache.config.language.banned);
    return undefined;
  }

  let ticket = await db.getTicketByUserId(userId, ctx.session.groupCategory);
  // Media never becomes an organization value; it only waits until the organization is known.
  const createsTicket = !ticket || ticket.status === 'closed' || Boolean(cache.config.ticket_per_message);
  if (createsTicket) (ctx as any).staffImportantEvent = true;
  let organization: string | null | undefined;
  if (createsTicket) {
    const gate = await clientOrganization.requireForNewTicket(ctx);
    if (!gate.ok) return undefined;
    organization = gate.organization;
  }
  const openTicket = async () => {
    const planned = typeof db.getClientProfile === 'function' ? await routing.planNewTicketRouting(String(userId), ctx.messenger, organization) : null;
    if (planned && (planned.routing.state === 'offered' || planned.routing.audit[0]?.reason !== 'organization_unconfirmed')) return db.addNewTicket(userId, ctx.session.groupCategory, ctx.messenger, organization, planned);
    return organization === undefined ? db.addNewTicket(userId, ctx.session.groupCategory, ctx.messenger)
      : db.addNewTicket(userId, ctx.session.groupCategory, ctx.messenger, organization);
  };
  if (!ticket || ticket.status === 'closed') {
    await openTicket();
    ticket = await db.getTicketByUserId(userId, ctx.session.groupCategory);
  } else if (ticket.status === 'waiting_user') {
    const resumed = await ticketState.resumeWaitingTicket(ticket.ticketId);
    if (resumed) {
      (ctx as any).staffImportantEvent = true;
      ticket = resumed;
      await db.recordAnalyticsEvent('ticket.resumed', ticket.ticketId, null, { reason: 'user_file' });
    } else {
      const latest = await db.getTicketById(ticket.ticketId, ctx.session.groupCategory);
      if (latest?.status === 'closed') {
        (ctx as any).staffImportantEvent = true;
        organization = await clientOrganization.currentOrganization(ctx);
        await openTicket();
        ticket = await db.getTicketByUserId(userId, ctx.session.groupCategory);
      } else {
        ticket = latest;
      }
    }
  } else if (cache.config.ticket_per_message) {
    await openTicket();
    ticket = await db.getTicketByUserId(userId, ctx.session.groupCategory);
  }

  if (!ticket) return undefined;

  const sentCount = cache.ticketSent[userId];
  if (sentCount === undefined) {
    setTimeout(() => {
      delete cache.ticketSent[userId];
    }, cache.config.spam_time);
    cache.ticketSent[userId] = 0;
    return forwardHandler(ctx);
  }
  if (sentCount < cache.config.spam_cant_msg) {
    cache.ticketSent[userId] = sentCount + 1;
    return forwardHandler(ctx);
  }
  if (sentCount === cache.config.spam_cant_msg) {
    cache.ticketSent[userId] = sentCount + 1;
    sendMessage(ctx.chat.id, ticket.messenger, cache.config.language.blockedSpam, {}).catch(log.error);
  }

  return undefined;
};

function forwardHandler(ctx: Context): string | undefined {
  if (ctx.chat.type === 'private') {
    cache.userId = ctx.message.from.id;
    return `${cache.config.language.from} ${ctx.message.from.first_name} ${cache.config.language.language}: ${ctx.message.from.language_code}\n\n`;
  }
  return undefined;
};

export { fileHandler, forwardFile, forwardHandler, resolveStaffFileTicket };
