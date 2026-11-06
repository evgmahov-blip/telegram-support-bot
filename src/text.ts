import * as db from './db';
import cache from './cache';
import * as staff from './staff';
import * as users from './users';
import * as middleware from './middleware';
import * as ticketState from './ticket-state';
import * as team from './team';
import * as clientOrganization from './client-organization';
import { planNewTicketRouting } from './ticket-routing';
import * as resolutionCase from './ticket-resolution-case';
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

/**
 * Private-chat inputs that are not client messages: an engineer's closure
 * explanation typed in their bot DM, and an armed organization input.
 */
async function handlePrivateInput(ctx: Context): Promise<boolean> {
  if (ctx.chat?.type !== 'private' || !ctx.message) return false;
  if (team.getStaffRole(String(ctx.from?.id))) {
    if (await resolutionCase.handleTextInput(ctx)) return true;
    if (ctx.message.reply_to_message) {
      // A reply in the DM would otherwise become the engineer's own client ticket.
      await middleware.reply(ctx, 'Ответ клиенту здесь не отправляется. Используйте «✉️ Написать клиенту» на карточке заявки в рабочей группе.');
      return true;
    }
  }
  return await clientOrganization.handleTextInput(ctx);
}

export async function handleText(bot: Addon, ctx: Context, keys: string[][] = []): Promise<void> {
  if (await handlePrivateInput(ctx)) return;
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
    // The organization is asked before any new ticket exists; follow-ups to an active ticket are never blocked.
    let organization: string | null | undefined;
    const createsTicket = !ticket || ticket.status === 'closed' || ticket.pending_new_request === true
      || Boolean(cache.config.ticket_per_message);
    if (createsTicket) {
      const gate = await clientOrganization.requireForNewTicket(ctx);
      if (!gate.ok) return null;
      organization = gate.organization;
    }
    const openTicket = async () => {
      if (!createsTicket) organization = await clientOrganization.currentOrganization(ctx);
      const planned = typeof db.getClientProfile === 'function' ? await planNewTicketRouting(String(userId), messenger, organization) : null;
      if (planned && (planned.routing.state === 'offered' || planned.routing.audit[0]?.reason !== 'organization_unconfirmed')) return db.addNewTicket(userId, session.groupCategory, messenger, organization, planned);
      return organization === undefined
        ? db.addNewTicket(userId, session.groupCategory, messenger)
        : db.addNewTicket(userId, session.groupCategory, messenger, organization);
    };

    const requestedNewTicket = typeof db.consumeNewTicketRequest === 'function'
      ? await db.consumeNewTicketRequest(String(userId), messenger) : null;
    if (requestedNewTicket) {
      await openTicket();
      ticket = await db.getTicketByUserId(userId, session.groupCategory);
    }

    if (!ticket || ticket.status === 'closed') {
      await openTicket();
      ticket = await db.getTicketByUserId(userId, session.groupCategory);
    } else if (requestedNewTicket) {
      // The requested ticket was just opened; the message belongs to it.
    } else if (ticket.status === 'waiting_user') {
      const resumed = await ticketState.resumeWaitingTicket(ticket.ticketId);
      if (resumed) {
        ticket = resumed;
        await db.recordAnalyticsEvent('ticket.resumed', ticket.ticketId, null, { reason: 'user_reply' });
      } else {
        ticket = await db.getTicketById(ticket.ticketId, session.groupCategory);
        if (ticket?.status === 'closed') {
          await openTicket();
          ticket = await db.getTicketByUserId(userId, session.groupCategory);
        }
      }
    } else if (cache.config.ticket_per_message) {
      await openTicket();
      ticket = await db.getTicketByUserId(userId, session.groupCategory);
    }

    await users.chat(ctx, message.chat);
    return ticket;
  }

  await staff.chat(ctx);
  return null;
}
