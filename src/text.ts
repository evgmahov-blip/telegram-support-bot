import * as db from './db';
import cache from './cache';
import * as staff from './staff';
import * as users from './users';
import * as middleware from './middleware';
import * as ticketState from './ticket-state';
import { Addon, Context } from './interfaces';
import { ISupportee } from './db';

const isMessageInCategories = (message: string): boolean => {
  const { categories } = cache.config;
  return Array.isArray(categories) && categories.length > 0 &&
    categories.some(category => category.msg.includes(message));
};

const shouldReplyWithCategoryKeyboard = (ctx: Context): boolean => {
  const { categories } = cache.config;
  return Array.isArray(categories) &&
    categories.length > 0 &&
    !isMessageInCategories(ctx.message.text) &&
    !ctx.session.admin &&
    !ctx.session.group;
};

export async function handleText(bot: Addon, ctx: Context, keys: string[][] = []): Promise<void> {
  if (shouldReplyWithCategoryKeyboard(ctx)) {
    await middleware.reply(ctx, cache.config.language.services, {
      reply_markup: { keyboard: keys },
    });
    return;
  }

  await ticketHandler(bot, ctx);
}

export async function ticketHandler(bot: Addon, ctx: Context): Promise<ISupportee | null> {
  const { chat, message, session, messenger } = ctx;

  if (chat.type === 'private') {
    const userId = message.from.id;

    if (await db.checkBan(userId, messenger)) {
      await middleware.reply(ctx, cache.config.language.banned);
      return null;
    }

    let ticket = await db.getTicketByUserId(userId, session.groupCategory);

    if (!ticket || ticket.status === 'closed') {
      await db.addNewTicket(userId, session.groupCategory, messenger);
      ticket = await db.getTicketByUserId(userId, session.groupCategory);
    } else if (ticket.status === 'waiting_user') {
      const resumed = await ticketState.resumeWaitingTicket(ticket.ticketId);
      if (resumed) {
        ticket = resumed;
        await db.recordAnalyticsEvent('ticket.resumed', ticket.ticketId, null, { reason: 'user_reply' });
      } else {
        ticket = await db.getTicketById(ticket.ticketId, session.groupCategory);
        if (ticket?.status === 'closed') {
          await db.addNewTicket(userId, session.groupCategory, messenger);
          ticket = await db.getTicketByUserId(userId, session.groupCategory);
        }
      }
    } else if (cache.config.ticket_per_message) {
      await db.addNewTicket(userId, session.groupCategory, messenger);
      ticket = await db.getTicketByUserId(userId, session.groupCategory);
    }

    await users.chat(ctx, message.chat);
    return ticket;
  }

  await staff.chat(ctx);
  return null;
}
