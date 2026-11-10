const mockReply = jest.fn().mockResolvedValue(undefined);
const mockSendMessage = jest.fn().mockResolvedValue('staff-message');
const mockGetTicketByUserId = jest.fn();
const mockAddTicketMessage = jest.fn().mockResolvedValue(undefined);
const mockRecordAnalyticsEvent = jest.fn().mockResolvedValue(undefined);
const mockCreateAIDraft = jest.fn().mockResolvedValue(undefined);
const mockGetResponseFromLLM = jest.fn();
const mockDeliverOffer = jest.fn();
jest.mock('../src/ticket-routing', () => ({ deliverOffer: mockDeliverOffer }));
jest.mock('../src/ticket-ui', () => ({ refreshStaffCard: jest.fn() }));

jest.mock('../src/middleware', () => ({
  reply: mockReply,
  sendMessage: mockSendMessage,
  strictEscape: jest.fn((value: string) => value),
}));

jest.mock('../src/db', () => ({
  getTicketByUserId: mockGetTicketByUserId,
  getTicketById: jest.fn(() => mockGetTicketByUserId()),
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
import { notifyTicketStaff } from '../src/ticket-visibility';

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
    jest.useFakeTimers();
    mockCreateAIDraft.mockResolvedValue(undefined);
    ctx.session.group = '';
    cache.staffMembers.set('42', { telegram_id: '42', role: 'agent' } as any);
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

  afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

  it.each([undefined, 0])('uses the updated offered snapshot for staff content and AI drafts (sentCount=%s)', async sentCount => {
    const initial = { ticketId: 51, userid: 'user-1', messenger: 'telegram', status: 'open', assigned_to: null, routing: { state: 'offered', offered_to: '42', version: 1 } };
    const current = { ...initial, routing: { ...initial.routing, version: 2 } };
    mockGetTicketByUserId.mockResolvedValue(initial);
    cache.ticketSent['user-1'] = sentCount;
    mockDeliverOffer.mockImplementationOnce(async () => { mockGetTicketByUserId.mockResolvedValue(current); });
    mockCreateAIDraft.mockImplementationOnce(async ticket => {
      expect(await notifyTicketStaff(ticket, 'AI draft')).toEqual({ route: 'owner', messageId: 'staff-message' });
    });
    await users.chat(ctx, { id: 'user-1' });
    expect(mockCreateAIDraft).toHaveBeenCalledWith(current, ctx);
    expect(mockSendMessage).toHaveBeenCalledTimes(2);
    expect(mockSendMessage.mock.calls.every(call => call[0] === '42')).toBe(true);
  });

  it.each([undefined, 0])('keeps category delivery after an undelivered offer becomes common (sentCount=%s)', async sentCount => {
    const initial = { ticketId: 51, userid: 'user-1', messenger: 'telegram', status: 'open', assigned_to: null, routing: { state: 'offered', offered_to: '42', version: 1 } };
    const current = { ...initial, routing: { state: 'common', version: 3 } };
    mockGetTicketByUserId.mockResolvedValue(initial);
    cache.ticketSent['user-1'] = sentCount;
    ctx.session.group = 'category-group';
    mockDeliverOffer.mockImplementationOnce(async () => { mockGetTicketByUserId.mockResolvedValue(current); });
    await users.chat(ctx, { id: 'user-1' });
    expect(mockCreateAIDraft).toHaveBeenCalledWith(current, ctx);
    expect(mockSendMessage.mock.calls.map(call => call[0])).toEqual(['staff-group', 'category-group']);
  });

  it('forwards the ticket to staff and delegates AI only to the draft module', async () => {
    await users.chat(ctx, { id: 'user-1' });

    expect(mockSendMessage).toHaveBeenCalledWith(
      'staff-group',
      'telegram',
      expect.stringContaining('#T000051'),
      expect.objectContaining({ disable_notification: true }),
    );
    expect(mockCreateAIDraft).toHaveBeenCalledWith(
      expect.objectContaining({ ticketId: 51 }),
      ctx,
    );
    expect(mockGetResponseFromLLM).not.toHaveBeenCalled();
    expect(mockReply).not.toHaveBeenCalled();
  });
});
