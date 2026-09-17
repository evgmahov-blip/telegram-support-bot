import { Bot, Context as GrammyContext, SessionFlavor, session } from 'grammy';
import { Addon, Context, Messenger, ModeData, SessionData } from '../../interfaces';
import { apiThrottler } from '@grammyjs/transformer-throttler';
import * as middleware from '../../middleware';
import * as permissions from '../../permissions';
import * as inline from '../../inline';
import cache from '../../cache';
import { registerCommonHandlers } from '../../handlers';
import * as log from '../../logger'

type BotContext = GrammyContext & SessionFlavor<SessionData>;

class TelegramAddon implements Addon {
  public bot: Bot<BotContext>;
  public botInfo: Record<string, unknown> = {};

  private static instance: TelegramAddon | null = null;

  private constructor(token: string) {
    this.bot = new Bot<BotContext>(token);
    const throttler = apiThrottler();
    this.bot.api.config.use(throttler);
    this.initBotInfo();
  }

  private async initBotInfo(): Promise<void> {
    try {
      await this.bot.init();
      this.botInfo = this.bot.botInfo as unknown as Record<string, unknown>;
    } catch (err) {
      log.error('Failed to initialize Telegram bot info:', err);
    }
  }

  public static getInstance(token?: string): TelegramAddon {
    if (!TelegramAddon.instance) {
      if (!token) {
        throw new Error(
          'Token must be provided when creating the TelegramAddon for the first time.'
        );
      }
      TelegramAddon.instance = new TelegramAddon(token);
    }
    return TelegramAddon.instance;
  }

  initSession() {
    const initial = (): SessionData => ({
      admin: null,
      modeData: { ticketid: '', userid: '', name: null, category: '' } as ModeData,
      mode: null,
      lastContactDate: 0,
      groupCategory: null,
      groupTag: '',
      group: '',
      groupAdmin: null,
      getSessionKey: () => null,
    });

    return session({
      initial,
      getSessionKey: (ctx: BotContext) => {
        if (!ctx.from) return undefined;
        return `${ctx.from.id}:${ctx.chat?.id ?? ctx.from.id}`;
      },
    });
  }

  private withThread(chatId: string | number, options: Record<string, unknown> = {}): Record<string, unknown> {
    const threadId = cache.config.staffchat_thread_id;
    if (
      threadId &&
      String(chatId) === String(cache.config.staffchat_id) &&
      options.message_thread_id === undefined
    ) {
      options.message_thread_id = threadId;
    }
    return options;
  }

  async sendMessage(chatId: string | number, text: string, options: Record<string, unknown> = {}): Promise<string | null> {
    options.disable_web_page_preview = true as unknown as string;
    if (typeof chatId !== 'string' && typeof chatId !== 'number') return null;
    options = this.withThread(chatId, options);
    const validModes = ['HTML', 'MarkdownV2'];
    if (options?.parse_mode === 'Markdown') {
      options.parse_mode = 'HTML';
    } else if (options?.parse_mode && !validModes.includes(options.parse_mode as string)) {
      delete options.parse_mode;
    }
    const response = await this.bot.api.sendMessage(chatId.toString(), text, options);
    return response.message_id.toString();
  }

  async sendDocument(
    chatId: string | number,
    document: unknown,
    other?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<string | null> {
    try {
      const response = await this.bot.api.sendDocument(
        chatId,
        document as never,
        this.withThread(chatId, other) as never,
        signal as any,
      );
      return response?.message_id?.toString() ?? null;
    } catch (err) {
      log.error('Failed to send document:', err);
      return null;
    }
  }

  async sendPhoto(chatId: string | number, photo: unknown, options?: Record<string, unknown>): Promise<string | null> {
    try {
      const response = await this.bot.api.sendPhoto(chatId, photo as never, this.withThread(chatId, options) as never);
      return response?.message_id?.toString() ?? null;
    } catch (err) {
      log.error('Failed to send photo:', err);
      return null;
    }
  }

  async sendVideo(chatId: string | number, video: unknown, options?: Record<string, unknown>): Promise<string | null> {
    try {
      const response = await this.bot.api.sendVideo(chatId, video as never, this.withThread(chatId, options) as never);
      return response?.message_id?.toString() ?? null;
    } catch (err) {
      log.error('Failed to send video:', err);
      return null;
    }
  }

  async sendSticker(chatId: string | number, sticker: unknown, options?: Record<string, unknown>): Promise<string | null> {
    try {
      const response = await this.bot.api.sendSticker(chatId, sticker as never, this.withThread(chatId, options) as never);
      return response?.message_id?.toString() ?? null;
    } catch (err) {
      log.error('Failed to send sticker:', err);
      return null;
    }
  }

  command(command: string, callback: (ctx: Context) => void): void {
    this.bot.command(command, (gCtx) => callback(gCtx as unknown as Context));
  }

  on(filter: string | string[], ...callbacks: ((ctx: Context) => void)[]): void {
    (this.bot.on as any)(filter, ...(callbacks.map(cb => (gCtx: never) => cb(gCtx as unknown as Context))));
  };

  catch(handler: (error: Error, ctx?: Context) => void): void {
    (this.bot.catch as any)((err: Error, gCtx: BotContext | undefined) => handler(err, gCtx as unknown as Context | undefined));
  }

  hears(trigger: string | string[] | RegExp, callback: (ctx: Context) => void): void {
    this.bot.hears(trigger, (gCtx) => callback(gCtx as unknown as Context));
  }

  start(): void {
    log.info('Starting Telegram Addon...');

    this.bot.use(this.initSession());
    this.bot.use(async (ctx: BotContext, next) => {
      const typedCtx = ctx as unknown as Context;
      typedCtx.messenger = Messenger.TELEGRAM;

      if (cache.config.dev_mode) {
        await middleware.reply(
          typedCtx,
          `_Dev mode is on: You might notice some delay in messages, no replies or other errors._`
        );
      }
      permissions.checkPermissions(typedCtx, next, cache.config);
    });

    const keys = inline.initInline(this);
    registerCommonHandlers(this, keys);

    this.bot.start();
  }
}

export default TelegramAddon;