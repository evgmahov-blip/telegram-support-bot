// Tests for the Telegram addon: staffchat_thread_id injection, media correlation ids and stickers.
const mockApi = {
  sendMessage: jest.fn().mockResolvedValue({ message_id: 5 }),
  sendPhoto: jest.fn().mockResolvedValue({ message_id: 6 }),
  sendDocument: jest.fn().mockResolvedValue({ message_id: 7 }),
  sendVideo: jest.fn().mockResolvedValue({ message_id: 8 }),
  sendSticker: jest.fn().mockResolvedValue({ message_id: 9 }),
  config: { use: jest.fn() },
};

jest.mock('grammy', () => ({
  Bot: jest.fn().mockImplementation(() => ({
    init: jest.fn().mockResolvedValue({}),
    api: mockApi,
    botInfo: { username: 'dummy_bot' },
    use: jest.fn(),
    command: jest.fn(),
    on: jest.fn(),
    hears: jest.fn(),
    catch: jest.fn(),
    start: jest.fn(),
  })),
  session: jest.fn(() => (_ctx: unknown, next: () => unknown) => next()),
}));
jest.mock('@grammyjs/transformer-throttler', () => ({ apiThrottler: () => jest.fn() }));
jest.mock('../src/middleware', () => ({ reply: jest.fn() }));
jest.mock('../src/permissions', () => ({ checkPermissions: jest.fn() }));
jest.mock('../src/inline', () => ({ initInline: jest.fn().mockReturnValue([]) }));
jest.mock('../src/handlers', () => ({ registerCommonHandlers: jest.fn() }));
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
});
