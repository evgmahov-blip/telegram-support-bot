import axios, { AxiosInstance } from 'axios';
import { Addon, Context } from '../../interfaces';
import cache from '../../cache';
import { registerCommonHandlers } from '../../handlers';
import * as log from '../../logger';
import { AsyncWorkTracker } from '../../async-work';

const DISCORD_API = 'https://discord.com/api/v10';
const GATEWAY_URL = 'wss://gateway.discord.gg';

class DiscordAddon implements Addon {
  private axiosInstance: AxiosInstance;
  private errorHandler: ((error: any, ctx?: any) => void) | null = null;
  private eventHandlers: Record<string, ((ctx: any) => void)[]> = {};
  private commandHandlers: Map<string, ((ctx: any) => void)[]> = new Map();
  private hearsHandlers: Array<{ trigger: string | RegExp; callback: (ctx: any) => void }> = [];
  private ws: any | null = null;
  private botUserId: string = '';
  private channels: Map<string, { name: string; id: string }> = new Map();
  private sequence: number | null = null;
  private session_id: string | null = null;
  private started = false;
  private stopping = false;
  private handlersRegistered = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private readonly inFlight = new AsyncWorkTracker();

  private static instance: DiscordAddon | null = null;

  private constructor() {
    this.axiosInstance = axios.create({
      baseURL: DISCORD_API,
      timeout: 10000,
      headers: {
        'Authorization': `Bot ${cache.config.discord_bot_token}`,
        'Content-Type': 'application/json',
        'X-RateLimit-Timeout': '1',
      },
    });
  }

  public static getInstance(): DiscordAddon {
    if (!DiscordAddon.instance) {
      DiscordAddon.instance = new DiscordAddon();
    }
    return DiscordAddon.instance;
  }

  /**
   * Sends a text message to a Discord channel.
   */
  async sendMessage(chatId: string | number, text: string, options?: any): Promise<string | null> {
    try {
      const channelId = this.resolveChannelId(chatId);
      if (!channelId) {
        log.error(`Discord: Cannot resolve channel ID for ${chatId}`);
        return null;
      }

      const payload: Record<string, any> = {
        content: text.substring(0, 2000),
      };

      // Handle thread replies
      if (options?.message_id) {
        payload.message_reference = {
          message_id: options.message_id,
          channel_id: channelId,
        };
      }

      const response = await this.axiosInstance.post(`/channels/${channelId}/messages`, payload);

      log.info(`Discord message sent to ${channelId}`);
      return response.data.id;
    } catch (error) {
      const err = error as { response?: { data: unknown } };
      log.error('Error sending Discord message:', err.response?.data || error);
      if (this.errorHandler) this.errorHandler(error);
      return null;
    }
  }

  /**
   * Sends a photo to Discord.
   */
  async sendPhoto(chatId: string | number, photo: any, options?: any): Promise<string | null> {
    try {
      const channelId = this.resolveChannelId(chatId);
      if (!channelId) return null;

      const form = new FormData();
      form.append('content', options?.caption || '');
      form.append('files[0]', photo, options?.filename || 'photo.jpg');

      await this.axiosInstance.post(`/channels/${channelId}/messages`, form, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });

      log.info(`Discord photo sent to ${channelId}`);
      return 'uploaded';
    } catch (error) {
      log.error('Error sending Discord photo:', error);
      if (this.errorHandler) this.errorHandler(error);
      return null;
    }
  }

  /**
   * Sends a document to Discord.
   */
  async sendDocument(chatId: string | number, document: any, options?: any): Promise<string | null> {
    try {
      const channelId = this.resolveChannelId(chatId);
      if (!channelId) return null;

      const form = new FormData();
      form.append('content', options?.caption || '');
      form.append('files[0]', document, options?.filename || 'document');

      await this.axiosInstance.post(`/channels/${channelId}/messages`, form, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });

      log.info(`Discord document sent to ${channelId}`);
      return 'uploaded';
    } catch (error) {
      log.error('Error sending Discord document:', error);
      if (this.errorHandler) this.errorHandler(error);
      return null;
    }
  }

  /**
   * Sends a video to Discord.
   */
  async sendVideo(chatId: string | number, video: any, options?: any): Promise<string | null> {
    try {
      const channelId = this.resolveChannelId(chatId);
      if (!channelId) return null;

      const form = new FormData();
      form.append('content', options?.caption || '');
      form.append('files[0]', video, options?.filename || 'video.mp4');

      await this.axiosInstance.post(`/channels/${channelId}/messages`, form, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });

      log.info(`Discord video sent to ${channelId}`);
      return 'uploaded';
    } catch (error) {
      log.error('Error sending Discord video:', error);
      if (this.errorHandler) this.errorHandler(error);
      return null;
    }
  }

  /**
   * Registers a command handler.
   */
  command(command: string, callback: (ctx: any) => void): void {
    const handlers = this.commandHandlers.get(command) || [];
    handlers.push(callback);
    this.commandHandlers.set(command, handlers);
  }

  /**
   * Registers an event handler.
   */
  on(event: string | string[], callback: (ctx: any) => void): void {
    if (typeof event === 'string') {
      const handlers = this.eventHandlers[event] || [];
      handlers.push(callback);
      this.eventHandlers[event] = handlers;
    } else {
      event.forEach((ev) => this.on(ev, callback));
    }
  }

  /**
   * Registers a hears handler (text matching).
   */
  hears(trigger: string | string[] | RegExp, callback: (ctx: any) => void): void {
    if (Array.isArray(trigger)) {
      trigger.forEach(t => this.hears(t, callback));
    } else {
      this.hearsHandlers.push({ trigger, callback });
    }
  }

  /**
   * Sets up an error handler.
   */
  catch(handler: (error: any, ctx?: any) => void): void {
    this.errorHandler = handler;
  }

  /**
   * Starts the Discord addon — connects to gateway and registers handlers.
   */
  start(): void {
  if (!cache.config.discord_enabled || this.started) return;
  this.started = true;
  this.stopping = false;
  log.info('Starting Discord Addon...');
  if (!this.handlersRegistered) {
    registerCommonHandlers(this);
    this.handlersRegistered = true;
  }
  this.connectGateway();
}

private scheduleReconnect(delayMs: number): void {
  if (this.stopping || this.reconnectTimer) return;
  this.reconnectTimer = setTimeout(() => {
    this.reconnectTimer = null;
    if (!this.stopping) this.connectGateway();
  }, delayMs);
  this.reconnectTimer.unref?.();
}

private connectGateway(): void {
  if (this.stopping) return;
  const WebSocket = require('ws');
  const socket = new WebSocket(GATEWAY_URL);
  this.ws = socket;

  socket.on('open', () => {
    if (this.stopping) {
      try { socket.close(); } catch { socket.terminate?.(); }
      return;
    }
    log.info('Discord Gateway WebSocket connected. Identifying...');
    this.send({
      op: 2,
      d: {
        token: `Bot ${cache.config.discord_bot_token}`,
        intents: 0 | 1 | 32 | 64 | 1 << 25,
        properties: {
          $os: 'linux',
          $browser: 'telegram-support-bot',
          $device: 'telegram-support-bot',
        },
      },
    });
  });

  socket.on('message', (data: Buffer) => {
    if (this.stopping) return;
    try {
      const message = JSON.parse(data.toString());
      this.inFlight.track(this.handleGatewayMessage(message), (error) => {
        log.error('Error processing Discord gateway message:', error);
        if (this.errorHandler) this.errorHandler(error);
      });
    } catch (err) {
      log.error('Error parsing Discord gateway message:', err);
    }
  });

  socket.on('error', (error: Error) => {
    if (this.stopping) return;
    log.error('Discord Gateway error:', error);
    if (this.errorHandler) this.errorHandler(error);
  });

  socket.on('close', () => {
    if (this.ws === socket) this.ws = null;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.stopping) {
      log.info('Discord Gateway closed.');
      return;
    }
    log.info('Discord Gateway closed. Reconnecting in 5 seconds...');
    this.scheduleReconnect(5000);
  });
}

private send(payload: any): void {
  if (this.ws && this.ws.readyState === WebSocket.OPEN) {
    this.ws.send(JSON.stringify(payload));
  }
}

private async handleGatewayMessage(message: any): Promise<void> {
  const { op, d, s, t } = message;
  if (op === 0 && t) await this.handleEvent(t, d);
  if (s !== null && s !== undefined) this.sequence = s;

  switch (op) {
    case 0:
      break;
    case 10:
      if (d?.heartbeat_interval) this.startHeartbeat(d.heartbeat_interval);
      break;
    case 9:
      log.error('Discord Gateway: Invalid session.');
      break;
    case 11:
      break;
  }
}

private async handleEvent(eventName: string, data: any): Promise<void> {
  switch (eventName) {
    case 'READY':
      this.botUserId = data.user.id;
      log.info(`Discord bot ready as ${data.user.username} (${this.botUserId})`);
      if (data.guilds) {
        await Promise.all(data.guilds.map((guild: any) => this.fetchGuildChannels(guild.id || guild)));
      }
      break;
    case 'GUILD_CREATE':
      await this.fetchGuildChannels(data.id);
      break;
    case 'MESSAGE_CREATE':
      await this.handleMessageCreate(data);
      break;
    case 'CHANNELS_UPDATE':
      if (data) {
        for (const ch of data) {
          this.channels.set(ch.name, { name: ch.name, id: ch.id });
          this.channels.set(ch.id, { name: ch.name, id: ch.id });
        }
      }
      break;
  }
}

private async fetchGuildChannels(guildId: string): Promise<void> {
  try {
    const response = await this.axiosInstance.get(`/guilds/${guildId}/channels`);
    for (const ch of response.data) {
      if (ch.type === 0 || ch.type === 15) {
        this.channels.set(ch.name, { name: ch.name, id: ch.id });
        this.channels.set(ch.id, { name: ch.name, id: ch.id });
      }
    }
  } catch (error) {
    log.error(`Error fetching channels for guild ${guildId}:`, error);
  }
}

private async handleMessageCreate(msg: any): Promise<void> {
  if (msg.author?.bot) return;
  const targetChannel = cache.config.discord_channel_id;
  if (targetChannel && msg.channel_id !== targetChannel) return;
  const ctx = this.buildContext(msg);
  if (!ctx) return;

  const text = ctx.message.text || '';
  if (text.startsWith('!') || text.startsWith('/')) {
    const parts = text.split(' ');
    const commandName = parts[0].substring(1);
    const handlers = this.commandHandlers.get(commandName);
    if (handlers) {
      ctx.match = parts.slice(1).join(' ');
      for (const handler of handlers) await handler(ctx);
      return;
    }
  }

  for (const { trigger, callback } of this.hearsHandlers) {
    if (typeof trigger === 'string' && text === trigger) {
      await callback(ctx);
      return;
    } else if (trigger instanceof RegExp && trigger.test(text)) {
      ctx.match = trigger.exec(text)?.toString() || '';
      await callback(ctx);
      return;
    }
  }

  for (const handler of this.eventHandlers['message'] || []) await handler(ctx);
}

private buildContext(msg: any): Context | null {
  if (!msg.author) return null;
  const text = msg.content || '';
  const userId = msg.author.id;
  const chatId = msg.channel_id;
  let replyToText = '';
  if (msg.reference?.message_id) replyToText = `#T${msg.reference.message_id} from`;
  else if (msg.message_reference?.message_id) replyToText = `#T${msg.message_reference.message_id} from`;

  return {
    messenger: 'discord' as any,
    update_id: 0,
    message: {
      web_msg: false,
      message_id: parseInt(msg.id) || 0,
      from: {
        id: userId,
        is_bot: msg.author.bot || false,
        first_name: msg.author.username || `Discord User ${userId}`,
        username: msg.author.username || '',
        language_code: 'en',
      },
      chat: {
        id: chatId,
        first_name: this.channels.get(chatId)?.name || chatId,
        username: '',
        type: msg.channel_type === 0 ? 'group' : 'private',
      },
      date: Math.floor(new Date(msg.timestamp).getTime() / 1000),
      text,
      reply_to_message: { from: { is_bot: false }, text: replyToText, caption: '' },
      external_reply: { message_id: parseInt(msg.id) || 0 },
      getFile: undefined,
      caption: '',
    },
    chat: {
      id: chatId,
      first_name: this.channels.get(chatId)?.name || chatId,
      username: '',
      type: msg.channel_type === 0 ? 'group' : 'private',
    },
    session: {} as any,
    callbackQuery: { data: '', from: { id: userId }, id: msg.id || '' },
    from: { username: msg.author.username || '', id: userId },
    inlineQuery: null,
    reply: async (): Promise<void> => {},
    answerCbQuery: async (): Promise<void> => {},
    getChat: async (): Promise<{ id: string; first_name: string; username: string; type: string }> => ({ id: '', first_name: '', username: '', type: 'private' }),
    getFile: async (): Promise<unknown> => ({}),
  };
}

private startHeartbeat(intervalMs: number): void {
  if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
  if (this.stopping) return;
  this.heartbeatTimer = setInterval(() => {
    this.send({ op: 1, d: this.sequence });
  }, intervalMs);
  this.heartbeatTimer.unref?.();
  log.info(`Discord heartbeat started (${intervalMs}ms interval)`);
}

private resolveChannelId(chatId: string | number): string | null {
  const idStr = String(chatId);
  if (/^\d{17,20}$/.test(idStr)) return idStr;
  if (idStr === 'default' || !idStr) return cache.config.discord_channel_id || null;
  const channel = this.channels.get(idStr);
  return channel ? channel.id : idStr;
}

async stop(): Promise<void> {
  this.stopping = true;
  this.started = false;
  if (this.reconnectTimer) {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }
  if (this.heartbeatTimer) {
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }
  const socket = this.ws;
  this.ws = null;
  if (socket) {
    try { socket.close(); } catch { try { socket.terminate?.(); } catch { /* ignore */ } }
  }
  await this.inFlight.drain();
}
}

export default DiscordAddon;
