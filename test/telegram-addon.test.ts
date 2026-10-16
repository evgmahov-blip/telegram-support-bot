// Tests for the Telegram addon: ingress dedupe, graceful stop, thread injection and media ids.
const mockApi = {
  sendMessage: jest.fn().mockResolvedValue({ message_id: 5 }),
  sendPhoto: jest.fn().mockResolvedValue({ message_id: 6 }),
  sendDocument: jest.fn().mockResolvedValue({ message_id: 7 }),
  sendVideo: jest.fn().mockResolvedValue({ message_id: 8 }),
  sendSticker: jest.fn().mockResolvedValue({ message_id: 9 }),
  config: { use: jest.fn() },
};
const mockBotUse = jest.fn();
const mockBotStart = jest.fn().mockResolvedValue(undefined);
const mockBotStop = jest.fn().mockResolvedValue(undefined);
const mockBotCatch = jest.fn();
const mockClaimTelegramUpdate = jest.fn().mockResolvedValue('claim-default');
const mockCompleteTelegramUpdate = jest.fn().mockResolvedValue(undefined);
const mockReleaseTelegramUpdate = jest.fn().mockResolvedValue(undefined);

jest.mock('grammy', () => ({
  Bot: jest.fn().mockImplementation(() => ({
    init: jest.fn().mockResolvedValue({}),
    api: mockApi,
    botInfo: { username: 'dummy_bot' },
    use: mockBotUse,
    command: jest.fn(),
    on: jest.fn(),
    hears: jest.fn(),
    catch: mockBotCatch,
    start: mockBotStart,
    stop: mockBotStop,
  })),
  session: jest.fn(() => (_ctx: unknown, next: () => unknown) => next()),
}));
jest.mock('@grammyjs/transformer-throttler', () => ({ apiThrottler: () => jest.fn() }));
jest.mock('../src/middleware', () => ({ reply: jest.fn() }));
jest.mock('../src/permissions', () => ({
  checkPermissions: jest.fn(async (_ctx: unknown, next: () => unknown) => await next()),
}));
jest.mock('../src/inline', () => ({ initInline: jest.fn().mockReturnValue([]) }));
jest.mock('../src/handlers', () => ({ registerCommonHandlers: jest.fn() }));
jest.mock('../src/most-commands', () => ({ queueCommand: jest.fn() }));
jest.mock('../src/telegram-update-dedup', () => ({
  claimTelegramUpdate: mockClaimTelegramUpdate,
  completeTelegramUpdate: mockCompleteTelegramUpdate,
  releaseTelegramUpdate: mockReleaseTelegramUpdate,
}));
jest.mock('../src/cache', () => ({
  __esModule: true,
  default: {
    config: { staffchat_id: '-100123', staffchat_thread_id: null, dev_mode: false },
  },
}));

import cache from '../src/cache';
import TelegramAddon from '../src/addons/telegram';

describe('TelegramAddon', () => {
  const addon = TelegramAddon.getInstance('token');

  beforeEach(() => {
    jest.clearAllMocks();
    cache.config.staffchat_thread_id = null;
    mockClaimTelegramUpdate.mockResolvedValue('claim-default');
    mockCompleteTelegramUpdate.mockResolvedValue(undefined);
    mockReleaseTelegramUpdate.mockResolvedValue(undefined);
    mockApi.sendMessage.mockResolvedValue({ message_id: 5 });
  });

  it('sends plain messages without a thread id by default', async () => {
    const id = await addon.sendMessage('-100123', 'hi', { parse_mode: 'HTML' });
    expect(id).toBe('5');
    expect(mockApi.sendMessage).toHaveBeenCalledWith('-100123', 'hi', expect.not.objectContaining({ message_thread_id: expect.anything() }));
  });

  it('adds message_thread_id for the staff chat when configured', async () => {
    cache.config.staffchat_thread_id = 42;
    await addon.sendMessage('-100123', 'hi');
    expect(mockApi.sendMessage.mock.calls[0][2]).toMatchObject({ message_thread_id: 42 });

    await addon.sendPhoto('-100123', 'photo', { caption: 'c' });
    expect(mockApi.sendPhoto.mock.calls[0][2]).toMatchObject({ message_thread_id: 42, caption: 'c' });

    await addon.sendDocument('-100123', 'doc', {});
    expect(mockApi.sendDocument.mock.calls[0][2]).toMatchObject({ message_thread_id: 42 });

    await addon.sendVideo('-100123', 'vid', {});
    expect(mockApi.sendVideo.mock.calls[0][2]).toMatchObject({ message_thread_id: 42 });
  });

  it('returns Telegram message ids for media so files can be correlated', async () => {
    expect(await addon.sendPhoto('-100123', 'photo')).toBe('6');
    expect(await addon.sendDocument('-100123', 'doc')).toBe('7');
    expect(await addon.sendVideo('-100123', 'vid')).toBe('8');
    expect(await addon.sendSticker('-100123', 'sticker')).toBe('9');
  });

  it('leaves user chats and explicit thread ids untouched', async () => {
    cache.config.staffchat_thread_id = 42;
    await addon.sendMessage('555', 'hi');
    expect(mockApi.sendMessage.mock.calls[0][2]).not.toHaveProperty('message_thread_id');

    await addon.sendMessage('-100123', 'hi', { message_thread_id: 7 });
    expect(mockApi.sendMessage.mock.calls[1][2]).toMatchObject({ message_thread_id: 7 });
  });

  it('converts legacy Markdown to HTML', async () => {
    await addon.sendMessage('555', 'hi', { parse_mode: 'Markdown' });
    expect(mockApi.sendMessage.mock.calls[0][2]).toMatchObject({ parse_mode: 'HTML' });
  });

  it('preserves valid formatted messages in a single send', async () => {
    await addon.sendMessage('555', '*valid*', { parse_mode: 'MarkdownV2' });
    expect(mockApi.sendMessage).toHaveBeenCalledTimes(1);
    expect(mockApi.sendMessage).toHaveBeenCalledWith('555', '*valid*', expect.objectContaining({
      parse_mode: 'MarkdownV2',
    }));
  });

  it('retries entity parse 400s once as plain text while preserving non-format options', async () => {
    const punctuation = '- # _ * [ ] ( ) ~ ` > + = | { } . !';
    mockApi.sendMessage
      .mockRejectedValueOnce({ error_code: 400, description: "Bad Request: can't parse entities: Character '-' is reserved" })
      .mockResolvedValueOnce({ message_id: 12 });

    await expect(addon.sendMessage('555', punctuation, {
      parse_mode: 'MarkdownV2',
      entities: [{ type: 'bold', offset: 0, length: 1 }],
      reply_markup: { inline_keyboard: [] },
      reply_parameters: { message_id: 9 },
    })).resolves.toBe('12');

    expect(mockApi.sendMessage).toHaveBeenCalledTimes(2);
    expect(mockApi.sendMessage.mock.calls[1][2]).toEqual(expect.objectContaining({
      reply_markup: { inline_keyboard: [] },
      reply_parameters: { message_id: 9 },
      disable_web_page_preview: true,
    }));
    expect(mockApi.sendMessage.mock.calls[1][2]).not.toHaveProperty('parse_mode');
    expect(mockApi.sendMessage.mock.calls[1][2]).not.toHaveProperty('entities');
  });

  it('does not retry unrelated failures and propagates fallback failures', async () => {
    const unrelated = { error_code: 400, description: 'Bad Request: chat not found' };
    mockApi.sendMessage.mockRejectedValueOnce(unrelated);
    await expect(addon.sendMessage('555', '#raw', { parse_mode: 'MarkdownV2' })).rejects.toBe(unrelated);
    expect(mockApi.sendMessage).toHaveBeenCalledTimes(1);

    mockApi.sendMessage.mockClear();
    const fallbackFailure = new Error('network failed');
    mockApi.sendMessage
      .mockRejectedValueOnce({ error_code: 400, description: "Bad Request: can't parse entities" })
      .mockRejectedValueOnce(fallbackFailure);
    await expect(addon.sendMessage('555', '-raw', { parse_mode: 'MarkdownV2' })).rejects.toBe(fallbackFailure);
    expect(mockApi.sendMessage).toHaveBeenCalledTimes(2);
  });

  it('does not mutate caller options during normalization or fallback', async () => {
    const options = {
      parse_mode: 'MarkdownV2',
      entities: [{ type: 'bold', offset: 0, length: 1 }],
      reply_markup: { force_reply: true },
    };
    const snapshot = JSON.parse(JSON.stringify(options));
    mockApi.sendMessage
      .mockRejectedValueOnce({ error_code: 400, description: "can't parse entities" })
      .mockResolvedValueOnce({ message_id: 13 });
    await addon.sendMessage('-100123', '#', options);
    expect(options).toEqual(snapshot);
  });

  it('returns null on media errors', async () => {
    mockApi.sendPhoto.mockRejectedValueOnce(new Error('photo boom'));
    mockApi.sendDocument.mockRejectedValueOnce(new Error('doc boom'));
    mockApi.sendVideo.mockRejectedValueOnce(new Error('video boom'));
    mockApi.sendSticker.mockRejectedValueOnce(new Error('sticker boom'));

    await expect(addon.sendPhoto('555', 'file-1')).resolves.toBeNull();
    await expect(addon.sendDocument('555', 'file-1')).resolves.toBeNull();
    await expect(addon.sendVideo('555', 'file-1')).resolves.toBeNull();
    await expect(addon.sendSticker('555', 'file-1')).resolves.toBeNull();
  });

  it('deduplicates updates around the full downstream chain and stops polling', async () => {
    addon.start();
    expect(mockBotUse).toHaveBeenCalledTimes(3);
    const guard = mockBotUse.mock.calls[0][0] as (ctx: any, next: () => Promise<void>) => Promise<void>;

    const order: string[] = [];
    mockClaimTelegramUpdate.mockImplementationOnce(async () => {
      order.push('claim');
      return 'claim-101';
    });
    mockCompleteTelegramUpdate.mockImplementationOnce(async () => {
      order.push('complete');
    });
    const downstream = jest.fn(async () => {
      order.push('downstream');
    });

    await guard({ update: { update_id: 101 } }, downstream);
    expect(order).toEqual(['claim', 'downstream', 'complete']);
    expect(mockCompleteTelegramUpdate).toHaveBeenCalledWith(101, 'claim-101');

    mockClaimTelegramUpdate.mockResolvedValueOnce(null);
    const duplicateDownstream = jest.fn().mockResolvedValue(undefined);
    await guard({ update: { update_id: 101 } }, duplicateDownstream);
    expect(duplicateDownstream).not.toHaveBeenCalled();

    const handlerError = new Error('handler failed');
    mockClaimTelegramUpdate.mockResolvedValueOnce('claim-102');
    await expect(guard(
      { update: { update_id: 102 } },
      jest.fn().mockRejectedValue(handlerError),
    )).rejects.toBe(handlerError);
    expect(mockReleaseTelegramUpdate).toHaveBeenCalledWith(102, 'claim-102');

    mockClaimTelegramUpdate.mockResolvedValueOnce('claim-103');
    mockCompleteTelegramUpdate.mockRejectedValueOnce(new Error('completion failed'));
    mockReleaseTelegramUpdate.mockClear();
    await expect(guard(
      { update: { update_id: 103 } },
      jest.fn().mockResolvedValue(undefined),
    )).rejects.toThrow('completion failed');
    expect(mockReleaseTelegramUpdate).not.toHaveBeenCalled();

    await addon.stop();
    expect(mockBotStop).toHaveBeenCalledTimes(1);
  });

  it.each([true, false])('maps callback alerts=%s onto a grammY-shaped context', async (showAlert) => {
    addon.start();
    const compatibility = mockBotUse.mock.calls[2][0] as (ctx: any, next: () => Promise<void>) => Promise<void>;
    const answerCallbackQuery = jest.fn().mockResolvedValue(true);
    const rawContext = { answerCallbackQuery };

    await compatibility(rawContext, async () => {
      expect(typeof rawContext.answerCbQuery).toBe('function');
      await rawContext.answerCbQuery('result', showAlert);
    });

    expect(answerCallbackQuery).toHaveBeenCalledWith({ text: 'result', show_alert: showAlert });
    await addon.stop();
  });

  it('unwraps grammY BotError into the registered error and context', () => {
    const handler = jest.fn();
    addon.catch(handler);
    const cause = new Error('handler failed');
    const rawContext = { callbackQuery: { id: 'q' } };
    const grammyCatch = mockBotCatch.mock.calls[0][0];
    grammyCatch({ error: cause, ctx: rawContext });
    expect(handler).toHaveBeenCalledWith(cause, rawContext);
  });
});
