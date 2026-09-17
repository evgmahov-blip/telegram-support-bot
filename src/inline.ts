import { Context, ModeData } from './interfaces';
import TelegramAddon from './addons/telegram';
import cache from './cache';
import * as middleware from './middleware';
import * as team from './team';

const replyKeyboard = (keys: any[]) => ({
  parse_mode: cache.config.parse_mode,
  reply_markup: { keyboard: keys },
});

const removeKeyboard = () => ({
  parse_mode: cache.config.parse_mode,
  reply_markup: { remove_keyboard: true },
});

const createCategoryHandler = (category: any) => (ctx: Context) => {
  ctx.session.mode = '';
  ctx.session.modeData = {} as ModeData;
  if (category.msg !== undefined) {
    middleware.reply(ctx, category.msg);
  } else {
    middleware.reply(
      ctx,
      `${cache.config.language.msgForwarding}\n*${category.name}*`,
      removeKeyboard()
    );
  }
  ctx.session.group = category.group_id;
  ctx.session.groupTag = category.tag || '';
  ctx.session.groupCategory = category.name;
};

const createSubcategoryHandler = (category: any, subgroup: any, displayName: string) => (ctx: Context) => {
  ctx.session.mode = '';
  ctx.session.modeData = {} as ModeData;
  middleware.reply(
    ctx,
    `${cache.config.language.msgForwarding}\n*${displayName}*`,
    removeKeyboard()
  );
  ctx.session.group = subgroup.group_id;
  ctx.session.groupCategory = subgroup.name;
};

function initInline(bot: TelegramAddon) {
  const keys: string[][] = [];
  const { categories, language } = cache.config;

  if (categories === undefined) {
    return keys;
  }
  for (const category of categories) {
    keys.push([category.name]);

    if (!Array.isArray(category.subgroups) || category.subgroups.length === 0) {
      const startStr = `/start ${category.name.replace(/[\[\]\:\ "]/g, '').substring(0, 63)}`;
      const handler = createCategoryHandler(category);

      bot.hears(startStr, handler);
      bot.hears(category.name, handler);
      continue;
    }

    const subKeys: string[][] = [];
    for (const subgroup of category.subgroups) {
      const fullDisplayName = `${category.name}: ${subgroup.name}`;
      const fullNameKey = [fullDisplayName];
      subKeys.push(fullNameKey);

      const startStr = `/start ${JSON.stringify(fullNameKey)
        .replace(/[\[\]\:\ "]/g, '')
        .substring(0, 63)}`;

      const subHandler = createSubcategoryHandler(category, subgroup, fullDisplayName);
      bot.hears(startStr, subHandler);
      bot.hears(fullNameKey, subHandler);
    }

    subKeys.push([language.back]);

    bot.hears(category.name, (ctx: Context) => {
      ctx.session.mode = '';
      ctx.session.modeData = {} as ModeData;
      middleware.reply(ctx, language.whatSubCategory, replyKeyboard(subKeys));
    });
  }
  return keys;
}

/**
 * Handles supported inline callbacks. MOST deliberately has no private/direct
 * reply callback: engineers operate only in the closed staff group.
 */
async function callbackQuery(ctx: Context) {
  const data = ctx.callbackQuery.data;

  if (data && data.startsWith('assign:')) {
    const parts = data.split(':');
    const staffId = parts[1];
    const ticketId = parseInt(parts[2]);

    if (!team.canPerformAction(ctx.callbackQuery.from.id.toString(), 'assign')) {
      await ctx.answerCbQuery('You cannot assign tickets.', true);
      return;
    }

    await team.assignTicketCommand(ctx, staffId, ticketId);
    await ctx.answerCbQuery('Ticket assigned!', true);
    return;
  }

  if (data && data.startsWith('unassign:')) {
    const parts = data.split(':');
    const ticketId = parseInt(parts[1]);

    await team.unassignTicketCommand(ctx, ticketId);
    await ctx.answerCbQuery('Ticket unassigned.', true);
    return;
  }

  // Old private-reply buttons may still exist on historical Telegram messages.
  // They must never recreate a private engineer session.
  ctx.session.mode = null;
  ctx.session.modeData = {} as ModeData;
  await ctx.answerCbQuery('This action is no longer available.', true);
}

export { callbackQuery, initInline, replyKeyboard, removeKeyboard };
