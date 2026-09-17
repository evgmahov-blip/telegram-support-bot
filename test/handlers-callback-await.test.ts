const mockInlineCallbackQuery = jest.fn();

jest.mock('../src/commands', () => ({
  openCommand: jest.fn(), closeCommand: jest.fn(), banCommand: jest.fn(), reopenCommand: jest.fn(),
  unbanCommand: jest.fn(), clearCommand: jest.fn(), assignCommand: jest.fn(), unassignCommand: jest.fn(),
  tagCommand: jest.fn(), untagCommand: jest.fn(), muteCommand: jest.fn(), unmuteCommand: jest.fn(),
  listStaffCommand: jest.fn(), statsCommand: jest.fn(), templatesCommand: jest.fn(), ticketCommand: jest.fn(),
  broadcastCommand: jest.fn(), helpCommand: jest.fn(), findUserCommand: jest.fn(),
}));

jest.mock('../src/most-commands', () => ({
  takeCommand: jest.fn(), transferCommand: jest.fn(), waitingCommand: jest.fn(), priorityCommand: jest.fn(),
  noteCommand: jest.fn(), notesCommand: jest.fn(), historyCommand: jest.fn(), cannedResponseCommand: jest.fn(),
}));

jest.mock('../src/middleware', () => ({ reply: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../src/inline', () => ({
  callbackQuery: mockInlineCallbackQuery,
  replyKeyboard: jest.fn(() => ({})),
}));
jest.mock('../src/files', () => ({ fileHandler: jest.fn() }));
jest.mock('../src/text', () => ({ handleText: jest.fn() }));
jest.mock('../src/analytics', () => ({
  handleCSATCallback: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../src/workflows', () => ({ getCannedResponse: jest.fn() }));
jest.mock('../src/edited', () => ({ handleEditedMessage: jest.fn() }));
jest.mock('../src/logger', () => ({ info: jest.fn(), error: jest.fn() }));
jest.mock('../src/cache', () => ({
  __esModule: true,
  default: {
    config: {
      start_keyboard: [],
      categories: [],
      pass_start: true,
      forward_stickers: false,
      forward_edited_messages: false,
      parse_mode: 'HTML',
      user_commands: [],
      language: {
        back: 'Back',
        csatThankYou: 'Thanks',
        faqCommandText: 'FAQ',
        links: 'Links',
      },
    },
  },
}));

import { registerCommonHandlers } from '../src/handlers';

function registerCallbackHandler(): (ctx: any) => Promise<void> {
  let callbackHandler!: (ctx: any) => Promise<void>;
  const addon: any = {
    platform: 'telegram',
    botInfo: { username: 'bot' },
    command: jest.fn(),
    on: jest.fn((event: string | string[], callback: (ctx: any) => Promise<void>) => {
      if (event === 'callback_query') callbackHandler = callback;
    }),
    hears: jest.fn(),
    catch: jest.fn(),
    sendMessage: jest.fn(),
    sendPhoto: jest.fn(),
    sendDocument: jest.fn(),
    sendVideo: jest.fn(),
    start: jest.fn(),
  };

  registerCommonHandlers(addon, []);
  return callbackHandler;
}

describe('callback query completion semantics', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('does not resolve the registered handler until inline callback work finishes', async () => {
    let finish!: () => void;
    mockInlineCallbackQuery.mockImplementationOnce(() => new Promise<void>((resolve) => {
      finish = resolve;
    }));

    const callback = registerCallbackHandler();
    const ctx = { callbackQuery: { data: 'assign:42' }, answerCbQuery: jest.fn() };
    let settled = false;
    const pending = callback(ctx).then(() => { settled = true; });

    await new Promise((resolve) => setImmediate(resolve));
    expect(mockInlineCallbackQuery).toHaveBeenCalledWith(ctx);
    expect(settled).toBe(false);

    finish();
    await pending;
    expect(settled).toBe(true);
  });

  it('propagates inline callback failures to the ingress guard', async () => {
    const error = new Error('assignment failed');
    mockInlineCallbackQuery.mockRejectedValueOnce(error);
    const callback = registerCallbackHandler();

    await expect(callback({
      callbackQuery: { data: 'assign:42' },
      answerCbQuery: jest.fn(),
    })).rejects.toBe(error);
  });
});
