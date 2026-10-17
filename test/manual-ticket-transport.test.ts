// The Telegram transport itself fails closed for the synthetic manual-ticket namespace.
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
    init: jest.fn().mockResolvedValue({}), api: mockApi, botInfo: { username: 'dummy_bot' },
    use: jest.fn(), command: jest.fn(), on: jest.fn(), hears: jest.fn(), catch: jest.fn(),
    start: jest.fn().mockResolvedValue(undefined), stop: jest.fn().mockResolvedValue(undefined),
  })),
  session: jest.fn(() => (_ctx: unknown, next: () => unknown) => next()),
}));
jest.mock('@grammyjs/transformer-throttler', () => ({ apiThrottler: () => jest.fn() }));
jest.mock('../src/middleware', () => ({ reply: jest.fn() }));
jest.mock('../src/permissions', () => ({ checkPermissions: jest.fn() }));
jest.mock('../src/inline', () => ({ initInline: jest.fn().mockReturnValue([]) }));
jest.mock('../src/handlers', () => ({ registerCommonHandlers: jest.fn() }));
jest.mock('../src/most-commands', () => ({ queueCommand: jest.fn() }));
jest.mock('../src/telegram-update-dedup', () => ({}));
jest.mock('../src/cache', () => ({ __esModule: true, default: { config: { staffchat_id: '-100123', staffchat_thread_id: null } } }));

import TelegramAddon from '../src/addons/telegram';
import { ManualTicketDeliveryError } from '../src/manual-ticket-guard';

describe('Telegram transport guard for manual tickets', () => {
  const addon = TelegramAddon.getInstance('token');
  beforeEach(() => jest.clearAllMocks());

  it('rejects text and every media type to a MANUAL: recipient without any Bot API call', async () => {
    await expect(addon.sendMessage('MANUAL:abc', 'hi')).rejects.toBeInstanceOf(ManualTicketDeliveryError);
    await expect(addon.sendDocument('MANUAL:abc', 'file')).rejects.toBeInstanceOf(ManualTicketDeliveryError);
    await expect(addon.sendPhoto('MANUAL:abc', 'file')).rejects.toBeInstanceOf(ManualTicketDeliveryError);
    await expect(addon.sendVideo('MANUAL:abc', 'file')).rejects.toBeInstanceOf(ManualTicketDeliveryError);
    await expect(addon.sendSticker('MANUAL:abc', 'file')).rejects.toBeInstanceOf(ManualTicketDeliveryError);
    for (const fn of Object.values(mockApi)) if (typeof fn === 'function') expect(fn).not.toHaveBeenCalled();
  });

  it('keeps ordinary Telegram delivery unchanged', async () => {
    await expect(addon.sendMessage('12345', 'hi')).resolves.toBe('5');
    expect(mockApi.sendMessage).toHaveBeenCalledWith('12345', 'hi', expect.anything());
    await expect(addon.sendDocument('12345', 'file')).resolves.toBe('7');
  });
});
