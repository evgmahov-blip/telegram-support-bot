import * as db from './db';
import cache from './cache';
import { reply, sendMessage } from './middleware';
import { Addon, Context } from './interfaces';
import * as ticketState from './ticket-state';
import * as log from './logger'

const escapeRegex = (str: string): string => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Handles forwarding of files (document, photo, video, sticker).
 * User files go to the staff surfaces; staff files are sent to the ticket user
 * through the bot. MOST has no private/direct engineer reply mode.
 */
async function fileHandler(type: string, bot: Addon, ctx: Context) {
  const { message, session } = ctx;
  const { config } = cache;
  let userid: string | null = null;
  let replyText = '';

  // Staff file reply: resolve the ticket from the replied staff-chat message.
  if (message?.reply_to_message && session.admin) {
    replyText = message.reply_to_message.text || message.reply_to_message.caption || '';
    const replyMessageId = (message.reply_to_message as typeof message.reply_to_message & { message_id?: number }).message_id;
    const correlatedMessageId = replyMessageId ?? message.external_reply?.message_id;
    if (typeof correlatedMessageId === 'number') {
      const ticket = await db.getTicketByInternalId(correlatedMessageId);
      userid = ticket?.userid ?? null;
    }

    // Historical/file-message fallback where no internal message id was stored.
    if (!userid && replyText) {
      const match = replyText.match(/#T0*(\d+)\b/);
      if (match) {
        const ticket = await db.getTicketById(parseInt(match[1], 10), session.groupCategory);
        userid = ticket?.userid ?? null;
      }
    }
  }

  if (!userid) userid = message.from.id;

  const userInfo = await forwardFile(ctx);
  let receiverId: string | number = config.staffchat_id;

  const ticket = await db.getTicketByUserId(userid.toString(), session.groupCategory);
  if (!ticket) {
    if (session.admin && userInfo === undefined) {
      reply(ctx, config.language.ticketClosedError);
    } else {
      reply(ctx, config.language.textFirst);
    }
    return;
  }

  if (ticket.status === 'closed') {
    reply(ctx, config.language.ticketClosedError);
    return;
  }

  let captionText = `${config.language.ticket} #T${(ticket.ticketId ?? ticket.id ?? 0)
    .toString()
    .padStart(6, '0')} ${userInfo ?? ''}\n${message.caption || ''}`;

  // Staff -> user file delivery. No engineer identity or private-session markup.
  if (session.admin && userInfo === undefined) {
    receiverId = ticket.userid;
    captionText = message.caption || '';
  }

  const fileResult = await ctx.getFile();
  const fileId = (fileResult as { file_id: string }).file_id;
  const commonOptions = { caption: captionText };

  let messageId: string | null | undefined = undefined;
  const shouldForwardToGroup = (
    !session.admin &&
    session.group !== '' &&
    session.group !== config.staffchat_id
  );

  switch (type) {
    case 'document':
      messageId = (await bot.sendDocument(receiverId, fileId, commonOptions)) as string | null;
      if (shouldForwardToGroup) {
        Promise.resolve(bot.sendDocument(session.group, fileId, { caption: captionText })).catch(log.error);
      }
      break;
    case 'photo':
      messageId = (await bot.sendPhoto(receiverId, fileId, commonOptions)) as string | null;
      if (shouldForwardToGroup) {
        Promise.resolve(bot.sendPhoto(session.group, fileId, { caption: captionText })).catch(log.error);
      }
      break;
    case 'video':
      messageId = (await bot.sendVideo(receiverId, fileId, commonOptions)) as string | null;
      if (shouldForwardToGroup) {
        Promise.resolve(bot.sendVideo(session.group, fileId, { caption: captionText })).catch(log.error);
      }
      break;
    case 'sticker': {
      if (!bot.sendSticker) return;
      messageId = (await bot.sendSticker(receiverId, fileId)) as string | null;
      const headerMessenger = session.admin && userInfo === undefined ? ticket.messenger : config.staffchat_type;
      if (captionText.trim()) {
        sendMessage(receiverId, headerMessenger, captionText).catch(log.error);
      }
      if (shouldForwardToGroup) {
        Promise.resolve(bot.sendSticker(session.group, fileId)).catch(log.error);
      }
      break;
    }
  }

  // Only staff-facing copies are valid reply-correlation ids. User-private
  // message ids are from a different Telegram chat and must not pollute internalIds.
  if (messageId && !session.admin) {
    db.addIdAndName(ticket.ticketId, messageId, ctx.message.from.first_name);
  }

  if (!config.autoreply_confirmation) return;
  let confirmationMessage = `${config.language.confirmationMessage}${config.show_user_ticket
    ? config.language.yourTicketId + ' #T' + (ticket.ticketId ?? ticket.id ?? 0).toString().padStart(6, '0')
    : ''
    }`;
  if (session.admin && userInfo === undefined) {
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
 * ban/lifecycle rules as text messages.
 */
async function forwardFile(ctx: Context): Promise<string | undefined> {
  // Staff file replies are handled against the replied ticket; they must never
  // create or resume a ticket for the staff member themselves.
  if (ctx.session.admin) return undefined;

  const userId = ctx.message.from.id.toString();
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

  const sentCount = cache.ticketSent[cache.userId];
  if (sentCount === undefined) {
    setTimeout(() => {
      delete cache.ticketSent[cache.userId];
    }, cache.config.spam_time);
    cache.ticketSent[cache.userId] = 0;
    return forwardHandler(ctx);
  } else if (sentCount < cache.config.spam_cant_msg) {
    cache.ticketSent[cache.userId] = sentCount + 1;
    return forwardHandler(ctx);
  } else if (sentCount === cache.config.spam_cant_msg) {
    cache.ticketSent[cache.userId] = sentCount + 1;
    sendMessage(ctx.chat.id, ticket.messenger, cache.config.language.blockedSpam, {}).catch(log.error);
  }
};

function forwardHandler(ctx: Context): string | undefined {
  if (ctx.chat.type === 'private') {
    cache.userId = ctx.message.from.id;
    const userInfo = `${cache.config.language.from} ${ctx.message.from.first_name} ${cache.config.language.language}: ${ctx.message.from.language_code}\n\n`;
    return userInfo;
  }
  return undefined;
};

export { fileHandler, forwardFile, forwardHandler };
