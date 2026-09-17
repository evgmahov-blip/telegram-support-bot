const mockReply = jest.fn().mockResolvedValue(undefined);
const mockSendMessage = jest.fn().mockResolvedValue('staff-message');
const mockGetTicketByUserId = jest.fn();
const mockAddTicketMessage = jest.fn().mockResolvedValue(undefined);
const mockRecordAnalyticsEvent = jest.fn().mockResolvedValue(undefined);
const mockCreateAIDraft = jest.fn().mockResolvedValue(undefined);
const mockGetResponseFromLLM = jest.fn();

jest.mock('../src/middleware', () => ({
  reply: mockReply,
  sendMessage: mockSendMessage,
  strictEscape: jest.fn((value: string) => value),
}));

jest.mock('../src/db', () => ({
  getTicketByUserId: mockGetTicketByUserId,
  addTicketMessage: mockAddTicketMessage,
  persistTicketMessage: jest.fn().mockResolvedValue(undefined),
  recordAnalyticsEvent: mockRecordAnalyticsEvent,
  recordAnalyticsEventBestEffort: jest.fn(),
  addIdAndName: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../src/ai-draft', () => ({
  createAIDraft: mockCreateAIDraft,
}));

jest.mock('../src/addons/llm', () => ({
  getResponseFromLLM: mockGetResponseFromLLM,
}));

jest.mock('../src/webhooks', () => ({
  webhooks: { ticketCreated: jest.fn().mockResolvedValue(undefined) },
}));

jest.mock('../src/workflows', () => ({
  isWithinBusinessHours: jest.fn().mockReturnValue(true),
}));

jest.mock('../src/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
}));

jest.mock('../src/cache', () => ({
  __esModule: true,
  default: {
    config: {
      use_llm: true,
      auto_triage: true,
      autoreply: [],
      show_auto_replied: true,
      autoreply_confirmation: false,
      show_user_ticket: false,
      spam_time: 60000,
      spam_cant_msg: 5,
      staffchat_id: 'staff-group',
      staffchat_type: 'telegram',
      staffchat_parse_mode: 'MarkdownV2',
      parse_mode: 'MarkdownV2',
      anonymous_tickets: true,
      clean_replies: false,
      language: {
        ticket: 'Ticket',
        from: 'from',
        language: 'Language',
        blockedSpam: 'Too many messages',
      },
    },
    userId: '',
    ticketIDs: {},
    ticketStatus: {},
    ticketSent: {},
    staffMembers: new Map(),
  },
}));

import cache from '../src/cache';
import * as users from '../src/users';

const ctx: any = {
  message: {
    text: 'Please help',
    from: { id: 'user-1', first_name: 'Alice', language_code: 'en' },
  },
  from: { id: 'user-1' },
  session: {
    groupCategory: null,
    groupTag: '',
    group: '',
    lastContactDate: 0,
  },
  messenger: 'telegram',
};

describe('users AI draft-only flow', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    cache.userId = '';
    cache.ticketIDs = {};
    cache.ticketStatus = {};
    cache.ticketSent = {};
    mockGetTicketByUserId.mockResolvedValue({
      ticketId: 51,
      userid: 'user-1',
      messenger: 'telegram',
      status: 'open',
      priority: 'normal',
      assigned_to: null,
      tags: [],
    });
  });

  it('forwards the ticket to staff and delegates AI only to the draft module', async () => {
    await users.chat(ctx, { id: 'user-1' });

    expect(mockSendMessage).toHaveBeenCalledWith(
      'staff-group',
      'telegram',
      expect.stringContaining('#T000051'),
    );
    expect(mockCreateAIDraft).toHaveBeenCalledWith(
      expect.objectContaining({ ticketId: 51 }),
      ctx,
    );
    expect(mockGetResponseFromLLM).not.toHaveBeenCalled();
    expect(mockReply).not.toHaveBeenCalled();
  });
});
