import * as db from './db';
import cache from './cache';
import { reply, sendMessage } from './middleware';
import { Addon, Context } from './interfaces';
import { ISupportee } from './db';
import * as ticketState from './ticket-state';
import * as team from './team';
import * as log from './logger'
import { persistStaffMessageCorrelation } from './staff-correlation';

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
  let ticket: ISupportee | null = null;
  let replyText = '';
  let userInfo: string | undefined;

  if (session.admin) {
    const actorId = ctx.from.id.toString();
    if (!team.canPerformAction(actorId, 'reply')) {
      await reply(ctx, 'You do not have permission to reply to tickets.');
      return;
    }

    ticket = await resolveStaffFileTicket(ctx);
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
        ? 'This ticket is owned by another engineer.'
        : 'Take the ticket first with /take.');
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

  let receiverId: string | number = config.staffchat_id;
  let captionText = `${config.language.ticket} #T${ticket.ticketId
    .toString()
    .padStart(6, '0')} ${userInfo ?? ''}\n${message.caption || ''}`;

  if (session.admin) {
    receiverId = ticket.userid;
    captionText = message.caption || '';
  }

  if (!['document', 'photo', 'video', 'sticker'].includes(type)) return;
  if (type === 'sticker' && !bot.sendSticker) return;

  // The legacy web widget supports text only. Do not persist a staff file as
  // delivered and do not throw into ingress/retry for a transport that cannot
  // ever handle media.
  if (session.admin && ticket.userid.includes('WEB')) {
    await reply(ctx, 'File delivery to web chat is not supported.');
    return;
  }

  const fileResult = await ctx.getFile();
  const fileId = (fileResult as { file_id: string }).file_id;
  const commonOptions = { caption: captionText };

  // Persist immutable conversation history before the primary external
  // delivery side effect. A failure here is safe for ingress to retry.
  const historyText = `[file:${type}]${message.caption ? ` ${message.caption}` : ''}`;
  await db.persistTicketMessage(
    ticket.ticketId,
    session.admin ? 'staff' : 'user',
    session.admin ? ctx.from.id.toString() : message.from.id.toString(),
    historyText,
  );

  let messageId: string | null | undefined;
  const shouldForwardToGroup = (
    !session.admin &&
    session.group !== '' &&
    session.group !== config.staffchat_id
  );

  switch (type) {
    case 'document':
      messageId = await bot.sendDocument(receiverId, fileId, commonOptions) as string | null;
      if (shouldForwardToGroup) {
        Promise.resolve(bot.sendDocument(session.group, fileId, { caption: captionText })).catch(log.error);
      }
      break;
    case 'photo':
      messageId = await bot.sendPhoto(receiverId, fileId, commonOptions) as string | null;
      if (shouldForwardToGroup) {
        Promise.resolve(bot.sendPhoto(session.group, fileId, { caption: captionText })).catch(log.error);
      }
      break;
    case 'video':
      messageId = await bot.sendVideo(receiverId, fileId, commonOptions) as string | null;
      if (shouldForwardToGroup) {
        Promise.resolve(bot.sendVideo(session.group, fileId, { caption: captionText })).catch(log.error);
      }
      break;
    case 'sticker': {
      const stickerMessageId = await bot.sendSticker!(receiverId, fileId);
      messageId = typeof stickerMessageId === 'string' ? stickerMessageId : null;
      const headerMessenger = session.admin ? ticket.messenger : config.staffchat_type;
      if (captionText.trim()) {
        sendMessage(receiverId, headerMessenger, captionText).catch(log.error);
      }
      if (shouldForwardToGroup) {
        Promise.resolve(bot.sendSticker!(session.group, fileId)).catch(log.error);
      }
      break;
    }
    default:
      return;
  }

  // Media addons report transport failure by returning null rather than
  // rejecting. Surface that failure so fenced ingress releases the update for
  // retry instead of recording a delivery that never happened.
  if (!messageId) {
    throw new Error(
      `Primary ${type} delivery failed for #T${ticket.ticketId} to ${receiverId}`,
    );
  }

  // Correlation ids are staff-chat message ids only. A staff -> user Telegram
  // message id belongs to another chat and must never enter internalIds.
  if (messageId && !session.admin) {
    await persistStaffMessageCorrelation(
      ticket.ticketId,
      messageId,
      ctx.message.from.first_name,
    );
  }

  if (session.admin) {
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

  if (session.admin) {
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
  if (!ticket || ticket.status === 'closed') {
    await db.addNewTicket(userId, ctx.session.groupCategory, ctx.messenger);
    ticket = await db.getTicketByUserId(userId, ctx.session.groupCategory);
  } else if (ticket.status === 'waiting_user') {
    const resumed = await ticketState.resumeWaitingTicket(ticket.ticketId);
    if (resumed) {
      ticket = resumed;
      await db.recordAnalyticsEvent('ticket.resumed', ticket.ticketId, null, { reason: 'user_file' });
    } else {
      const latest = await db.getTicketById(ticket.ticketId, ctx.session.groupCategory);
      if (latest?.status === 'closed') {
        await db.addNewTicket(userId, ctx.session.groupCategory, ctx.messenger);
        ticket = await db.getTicketByUserId(userId, ctx.session.groupCategory);
      } else {
        ticket = latest;
      }
    }
  } else if (cache.config.ticket_per_message) {
    await db.addNewTicket(userId, ctx.session.groupCategory, ctx.messenger);
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
