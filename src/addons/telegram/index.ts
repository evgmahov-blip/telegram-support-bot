import { Bot, Context as GrammyContext, SessionFlavor, session } from 'grammy';
import { Addon, Context, Messenger, ModeData, SessionData } from '../../interfaces';
import { apiThrottler } from '@grammyjs/transformer-throttler';
import * as middleware from '../../middleware';
import * as permissions from '../../permissions';
import * as inline from '../../inline';
import * as mostCommands from '../../most-commands';
import * as updateDedup from '../../telegram-update-dedup';
import cache from '../../cache';
import { registerCommonHandlers } from '../../handlers';
import * as log from '../../logger'
import { assertDeliverableRecipient } from '../../manual-ticket-guard';

type BotContext = GrammyContext & SessionFlavor<SessionData>;

export function bindTelegramCompatibility(ctx: BotContext): Context {
  const typedCtx = ctx as unknown as Context;
  typedCtx.messenger = Messenger.TELEGRAM;
  typedCtx.answerCbQuery = (text?: string, showAlert = false) =>
    ctx.answerCallbackQuery({ text, show_alert: showAlert }).then(() => undefined);
  return typedCtx;
}

class TelegramAddon implements Addon {
  public bot: Bot<BotContext>;
  public botInfo: Record<string, unknown> = {};

  private static instance: TelegramAddon | null = null;
  private started = false;

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
      lastOfflineNoticeDate: 0,
      groupCategory: null,
      groupTag: '',
      group: '',
      groupAdmin: null,
      getSessionKey: () => null,
    });

    return session({
      initial,
      getSessionKey: (ctx) => {
        if (!ctx.from) return undefined;
        return `${ctx.from.id}:${ctx.chat?.id ?? ctx.from.id}`;
      },
    });
  }

  private withThread(chatId: string | number, options: Record<string, unknown> = {}): Record<string, unknown> {
    options = { ...options };
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
    if (typeof chatId !== 'string' && typeof chatId !== 'number') return null;
    assertDeliverableRecipient(chatId);
    options = this.withThread(chatId, { ...options, disable_web_page_preview: true });
    const validModes = ['HTML', 'MarkdownV2'];
    if (options?.parse_mode === 'Markdown') {
      options.parse_mode = 'HTML';
    } else if (options?.parse_mode && !validModes.includes(options.parse_mode as string)) {
      delete options.parse_mode;
    }
    let response;
    try {
      response = await this.bot.api.sendMessage(chatId.toString(), text, options);
    } catch (err) {
      const telegramError = err as { error_code?: number; description?: string };
      const isEntityParseError = telegramError.error_code === 400
        && /can't parse entities/i.test(telegramError.description || '');
      if (!isEntityParseError) throw err;

      log.info(`Retrying Telegram message to ${chatId} as plain text after entity parse error: ${telegramError.description || 'unknown description'}`);
      const plainOptions = { ...options };
      delete plainOptions.parse_mode;
      delete plainOptions.entities;
      response = await this.bot.api.sendMessage(chatId.toString(), text, plainOptions);
    }
    return response.message_id.toString();
  }

  async editMessage(chatId: string | number, messageId: number, text: string, options: Record<string, unknown> = {}): Promise<void> {
    const validModes = ['HTML', 'MarkdownV2'];
    if (!validModes.includes(options.parse_mode as string)) delete options.parse_mode;
    try {
      await this.bot.api.editMessageText(chatId, messageId, text, { ...options, disable_web_page_preview: true } as never);
    } catch (err) {
      const description = String((err as { description?: string }).description || err);
      if (!/message is not modified/i.test(description)) throw err;
    }
  }

  async sendDocument(
    chatId: string | number,
    document: unknown,
    other?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<string | null> {
    assertDeliverableRecipient(chatId);
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
    assertDeliverableRecipient(chatId);
    try {
      const response = await this.bot.api.sendPhoto(chatId, photo as never, this.withThread(chatId, options) as never);
      return response?.message_id?.toString() ?? null;
    } catch (err) {
      log.error('Failed to send photo:', err);
      return null;
    }
  }

  async sendVideo(chatId: string | number, video: unknown, options?: Record<string, unknown>): Promise<string | null> {
    assertDeliverableRecipient(chatId);
    try {
      const response = await this.bot.api.sendVideo(chatId, video as never, this.withThread(chatId, options) as never);
      return response?.message_id?.toString() ?? null;
    } catch (err) {
      log.error('Failed to send video:', err);
      return null;
    }
  }

  async sendSticker(chatId: string | number, sticker: unknown, options?: Record<string, unknown>): Promise<string | null> {
    assertDeliverableRecipient(chatId);
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
    (this.bot.catch as any)((botError: { error: Error; ctx: BotContext }) =>
      handler(botError.error, botError.ctx as unknown as Context));
  }

  hears(trigger: string | string[] | RegExp, callback: (ctx: Context) => void): void {
    this.bot.hears(trigger, (gCtx) => callback(gCtx as unknown as Context));
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    log.info('Starting Telegram Addon...');

    // Claim update_id before any session or business middleware mutates state.
    // The claim is completed only after the entire downstream chain resolves.
    this.bot.use(async (ctx: BotContext, next) => {
      const updateId = ctx.update.update_id;
      const claimId = await updateDedup.claimTelegramUpdate(updateId);
      if (!claimId) {
        log.info(`Skipping duplicate Telegram update ${updateId}.`);
        return;
      }

      let downstreamCompleted = false;
      try {
        await next();
        downstreamCompleted = true;
        await updateDedup.completeTelegramUpdate(updateId, claimId);
      } catch (err) {
        // Handler failures release only the lease owned by this worker. If the
        // handler succeeded but completion persistence failed, keep the claim
        // leased rather than immediately risking duplicate side effects.
        if (!downstreamCompleted) {
          try {
            await updateDedup.releaseTelegramUpdate(updateId, claimId);
          } catch (releaseErr) {
            log.error(`Failed to release Telegram update ${updateId}:`, releaseErr);
          }
        }
        throw err;
      }
    });

    this.bot.use(this.initSession());
    this.bot.use(async (ctx: BotContext, next) => {
      const typedCtx = bindTelegramCompatibility(ctx);

      if (cache.config.dev_mode) {
        await middleware.reply(
          typedCtx,
          `_Dev mode is on: You might notice some delay in messages, no replies or other errors._`
        );
      }
      await permissions.checkPermissions(typedCtx, next, cache.config);
    });

    const keys = inline.initInline(this);
    registerCommonHandlers(this, keys);
    this.command('queue', (ctx: Context) => mostCommands.queueCommand(ctx));

    void this.bot.start().catch((err) => {
      this.started = false;
      log.error('Telegram polling stopped with an error:', err);
    });
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    log.info('Stopping Telegram Addon...');
    await this.bot.stop();
    this.started = false;
  }
}

export default TelegramAddon;
