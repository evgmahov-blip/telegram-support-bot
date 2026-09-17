import { Context, ParseMode } from './interfaces';
import cache from './cache';
import * as db from './db';
import { strictEscape as esc, reply, sendMessage } from './middleware';
import { ISupportee } from './db';
import * as log from './logger'
import * as aiDraft from './ai-draft';
import * as webhooks from './webhooks';
import * as workflows from './workflows';

const TIME_BETWEEN_CONFIRMATION_MESSAGES = 86400000; // 24 hours

function formatMessageAsTicket(
  ticket: { toString: () => string },
  ctx: Context,
  autoReplyInfo?: any,
): string {
  const { config, userId } = cache;
  let name = `[${esc(ctx.message.from.first_name,)}](tg://user?id=${userId})`;
  if (config.anonymous_tickets || config.staffchat_parse_mode === ParseMode.PLAINTEXT) {
    name = ctx.message.from.first_name;
  }

  const priorityIcons: Record<string, string> = { urgent: '🔴', high: '🟠', normal: '🟡', low: '⚪' };
  const ticketObj = (ctx.session as any).ticketData;
  let priorityPrefix = '';
  if (ticketObj && ticketObj.priority && ticketObj.priority !== 'normal') {
    priorityPrefix = `${priorityIcons[ticketObj.priority] || ''} `;
  }

  let assignPrefix = '';
  if (ticketObj && ticketObj.assigned_to) {
    const assignedMember = cache.staffMembers?.get(ticketObj.assigned_to);
    const assignName = assignedMember?.name || ticketObj.assigned_to;
    assignPrefix = `📋 Assigned: ${assignName}\n`;
  }

  let tagsPrefix = '';
  if (ticketObj && ticketObj.tags && ticketObj.tags.length > 0) {
    tagsPrefix = `🏷️ ${ticketObj.tags.map((t: string) => `#${t}`).join(' ')}\n`;
  }

  return `${priorityPrefix}${config.language.ticket} #T${ticket
    .toString()
    .padStart(6, '0')} ${config.language.from} ${name} ${config.language.language}: ${ctx.message.from.language_code} ${ctx.session.groupTag}\n\n${assignPrefix}${tagsPrefix}${esc(
      ctx.message.text,
    )}\n\n${autoReplyInfo ? `*${autoReplyInfo}*` : ''}`;
}

function createAutoReplyMessage(msg: string, ctx: Context): string {
  const { config } = cache;
  const senderName = ctx.message.from.first_name;
  return config.clean_replies
    ? msg
    : `${config.language.dear} ${esc(senderName)},\n\n${msg}\n\n${config.language.regards}\n${config.language.automatedReplyAuthor}\n\n*${config.language.automatedReply}*`;
}

/** Static configured replies may answer users. AI never does. */
async function autoReply(ctx: Context): Promise<boolean> {
  const { autoreply } = cache.config;
  const messageText = ctx.message.text.toString();

  if (autoreply && autoreply.length > 0 && autoreply[0]?.question) {
    for (const autoReplyItem of autoreply) {
      if (messageText.includes(autoReplyItem.question)) {
        reply(ctx, createAutoReplyMessage(autoReplyItem.answer, ctx));
        return true;
      }
    }
  }

  return false;
}

async function processTicket(
  ticket: ISupportee,
  ctx: Context,
  chatId: string,
  autoReplyInfo?: string,
) {
  const { config } = cache;

  (ctx.session as any).ticketData = {
    priority: ticket.priority,
    assigned_to: ticket.assigned_to,
    tags: ticket.tags || [],
  };

  await db.addTicketMessage(ticket.ticketId, 'user', ctx.from.id.toString(), ctx.message.text);

  // Legacy push webhooks remain for compatibility. The canonical persisted
  // ticket.created event is emitted exactly once by db.addNewTicket().
  if (!autoReplyInfo) {
    await webhooks.webhooks.ticketCreated(ticket.ticketId, ctx.from.id.toString(), ctx.message.text.substring(0, 200));
  }

  if (
    !autoReplyInfo &&
    config.autoreply_confirmation &&
    (ctx.session.lastContactDate === undefined ||
      ctx.session.lastContactDate < Date.now() - TIME_BETWEEN_CONFIRMATION_MESSAGES)
  ) {
    ctx.session.lastContactDate = Date.now();
    const confirmationMsg =
      config.language.confirmationMessage +
      '\n' +
      (config.show_user_ticket
        ? `${config.language.ticket} #T${ticket.ticketId.toString().padStart(6, '0')}`
        : '');
    sendMessage(chatId, ticket.messenger, confirmationMsg).catch(log.error);
  }

  const messageId = await sendMessage(
    config.staffchat_id,
    config.staffchat_type,
    formatMessageAsTicket(
      ticket.ticketId,
      ctx,
      autoReplyInfo,
    ),
  );
  if (messageId) {
    db.addIdAndName(ticket.ticketId, messageId, ctx.message.from.first_name);
  }

  // Category groups remain internal staff surfaces. MOST never adds a private
  // engineer-reply button; replies must happen in the staff group/thread.
  if (ctx.session.group && ctx.session.group !== config.staffchat_id) {
    sendMessage(
      ctx.session.group,
      ticket.messenger,
      formatMessageAsTicket(
        ticket.ticketId,
        ctx,
        autoReplyInfo,
      ),
      { parse_mode: config.parse_mode },
    ).catch(log.error);
  }

  if (!autoReplyInfo) {
    await aiDraft.createAIDraft(ticket, ctx);
  }
}

async function chat(ctx: Context, chat: { id: string }) {
  const { config } = cache;

  // After-hours is a notification policy, never a data-loss gate. The message
  // is still persisted and forwarded to the staff queue.
  if (!workflows.isWithinBusinessHours()) {
  const now = Date.now();
  if (
    ctx.session.lastOfflineNoticeDate === undefined ||
    ctx.session.lastOfflineNoticeDate < now - TIME_BETWEEN_CONFIRMATION_MESSAGES
  ) {
    ctx.session.lastOfflineNoticeDate = now;
    const offlineMsg = config.language.businessHoursClosed || 'Our support team is currently offline. We will respond during business hours.';
    await reply(ctx, offlineMsg);
  }
}

  cache.userId = ctx.message.from.id;
  const isAutoReply = await autoReply(ctx);
  if (isAutoReply && !config.show_auto_replied) return;
  const autoReplyInfo = isAutoReply ? config.language.automatedReplySent : undefined;

  if (cache.ticketIDs[cache.userId] === undefined) {
    cache.ticketIDs[cache.userId] = cache.userId;
  }
  cache.ticketStatus[cache.userId] = true;

  const sentCount = cache.ticketSent[cache.userId];
  if (sentCount === undefined) {
    const ticket = await db.getTicketByUserId(chat.id, ctx.session.groupCategory);
    if (ticket) {
      await processTicket(ticket, ctx, chat.id, autoReplyInfo);
    }

    const spamUserId = cache.userId;
    setTimeout(() => {
      delete cache.ticketSent[spamUserId];
    }, config.spam_time);
    cache.ticketSent[cache.userId] = 0;
  } else if (sentCount < config.spam_cant_msg) {
    cache.ticketSent[cache.userId] = sentCount + 1;
    const ticket = await db.getTicketByUserId(cache.userId, ctx.session.groupCategory);
    if (!ticket) return;

    await db.addTicketMessage(ticket.ticketId, 'user', ctx.from.id.toString(), ctx.message.text);

    sendMessage(
      config.staffchat_id,
      config.staffchat_type,
      formatMessageAsTicket(
        ticket.ticketId,
        ctx,
        autoReplyInfo,
      ),
    ).catch(log.error);
    if (ctx.session.group && ctx.session.group !== config.staffchat_id) {
      sendMessage(
        ctx.session.group,
        ticket.messenger,
        formatMessageAsTicket(
          ticket.ticketId,
          ctx,
          autoReplyInfo,
        ),
      ).catch(log.error);
    }

    if (!autoReplyInfo) {
      await aiDraft.createAIDraft(ticket, ctx);
    }
  } else if (sentCount === config.spam_cant_msg) {
    cache.ticketSent[cache.userId] = sentCount + 1;
    sendMessage(chat.id, ctx.messenger, config.language.blockedSpam).catch(log.error);
  }

  const logTicket = await db.getTicketByUserId(cache.userId, ctx.session.groupCategory);
  if (logTicket) {
    log.info(`User message processed for #T${logTicket.ticketId}`);
  }
}

export { chat };
