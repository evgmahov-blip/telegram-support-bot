import cache from './cache';
import SignalAddon from './addons/signal';
import { Context, Messenger } from './interfaces';
import TelegramAddon from './addons/telegram';

/**
 * Escapes special characters for MarkdownV2, HTML, or Markdown formats.
 *
 * @param str - The string to escape.
 * @returns The escaped string.
 */
const strictEscape = (str: string): string => {
  const { parse_mode } = cache.config;
  switch (parse_mode) {
    case 'MarkdownV2':
      // Escape all special MarkdownV2 characters
      return str.replace(/([[\]()_*~`>#+\-=\|{}.!\\])/g, '\\$1');
    case 'HTML':
      return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;'); // Escape single quotes
    case 'Markdown':
      return str
        .replace(/([[\]_*`])/g, '\$1')
        .replace(/(\[|\])/g, '\$1');
    default:
      return str.toString();
  }
};

/**
 * Sends a message through the appropriate messenger addon.
 */
async function sendMessage (
  id: string | number,
  messenger: string,
  msg: string,
  extra: any = { parse_mode: cache.config.parse_mode }
): Promise<string | null> {
  const messengerType = messenger as Messenger;
  const cleanedMsg = msg.replace(/ {2,}/g, ' ');

  switch (messengerType) {
    case Messenger.TELEGRAM:
      return await TelegramAddon.getInstance().sendMessage(id, cleanedMsg, extra);
    case Messenger.SIGNAL:
      return await SignalAddon.getInstance().sendMessage(id, cleanedMsg, extra);
    case Messenger.WEB: {
      const socketId = id.toString().split('WEB')[1];
      cache.io.to(socketId).emit('chat_staff', cleanedMsg);
      return null;
    }
    default:
      throw new Error('Invalid messenger type');
  }
};

/**
 * Replies to a message within the given context.
 */
const reply = async (
  ctx: Context,
  msgText: string,
  extra: any = { parse_mode: cache.config.parse_mode }
): Promise<void> => {
  const chatId = ctx.message?.chat?.id ?? ctx.chat?.id;
  if (!chatId) return;
  await sendMessage(chatId, ctx.messenger, msgText, extra);
};

export { strictEscape, sendMessage, reply };
