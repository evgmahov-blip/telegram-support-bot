// Mock dependencies
const mockReply = jest.fn();
const mockSendMessage = jest.fn();
const mockAdd = jest.fn();
const mockAddNewTicket = jest.fn().mockResolvedValue(1);
const mockCheckBan = jest.fn().mockResolvedValue(null);
const mockGetTicketByUserId = jest.fn();
const mockTransitionTicketStatus = jest.fn();
const mockRecordAnalyticsEvent = jest.fn().mockResolvedValue(undefined);
const mockUserChat = jest.fn();
const mockPrivateReply = jest.fn();
const mockStaffChat = jest.fn();

jest.mock('../src/middleware', () => ({
  reply: mockReply,
  sendMessage: mockSendMessage,
}));

jest.mock('../src/db', () => ({
  add: mockAdd,
  addNewTicket: mockAddNewTicket,
  checkBan: mockCheckBan,
  getTicketByUserId: mockGetTicketByUserId,
  transitionTicketStatus: mockTransitionTicketStatus,
  addTicketMessage: jest.fn().mockResolvedValue(undefined),
  recordAnalyticsEvent: mockRecordAnalyticsEvent,
}));

jest.mock('../src/users', () => ({
  chat: mockUserChat,
}));

jest.mock('../src/staff', () => ({
  privateReply: mockPrivateReply,
  chat: mockStaffChat,
}));

jest.mock('../src/cache', () => ({
  config: {
    categories: [
      {
        name: 'Support',
        msg: 'Support',
        tag: 'SUPPORT',
        group_id: 'group1',
        subgroups: []
      },
      {
        name: 'Sales',
        msg: 'Sales',
        tag: 'SALES',
        group_id: 'group2',
        subgroups: []
      }
    ],
    parse_mode: 'MarkdownV2',
    ticket_per_message: false,
    language: {
      services: 'Please select a service:',
      prvChatOnly: 'This bot only works in private chat',
      banned: 'Banned',
    },
  },
}));

import * as text from '../src/text';
import { Context, Messenger } from '../src/interfaces';

describe('Text Handler Module', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCheckBan.mockResolvedValue(null);
  });

  const createMockContext = (
    messageText: string,
    chatType: string = 'private',
    mode: string | null = null,
    isAdmin: boolean = false,
    group: string = ''
  ): Context => ({
    message: {
      text: messageText,
      from: {
        id: 'user123',
        first_name: 'John',
        username: 'john_doe',
        is_bot: false,
        language_code: 'en',
      },
      chat: {
        id: 'chat123',
        first_name: 'John',
        username: 'john_doe',
        type: chatType,
      },
      message_id: 1,
      date: 1640995200,
      web_msg: false,
      reply_to_message: {
        from: { is_bot: false },
        text: '',
        caption: '',
      },
      external_reply: { message_id: 0 },
      caption: '',
    },
    messenger: Messenger.TELEGRAM,
    session: {
      lastContactDate: 0,
      admin: isAdmin,
      mode: mode,
      modeData: {
        ticketid: '',
        userid: '',
        name: '',
        category: '',
      },
      groupCategory: null,
      groupTag: '',
      group: group,
      groupAdmin: null,
      getSessionKey: () => '',
    },
    chat: {
      id: 'chat123',
      first_name: 'John',
      username: 'john_doe',
      type: chatType,
    },
    update_id: 1,
    callbackQuery: { data: '', from: { id: '' }, id: '' },
    from: { username: 'john_doe', id: 'user123' },
    inlineQuery: () => {},
    answerCbQuery: () => {},
    reply: () => {},
    getChat: () => {},
    getFile: () => {},
  });

  describe('handleText', () => {
    it('should handle private reply mode', () => {
      const ctx = createMockContext('Response message', 'private', 'private_reply');
      const mockAddon = { platform: 'telegram' };

      text.handleText(mockAddon as any, ctx, []);

      expect(mockPrivateReply).toHaveBeenCalledWith(ctx);
      expect(mockReply).not.toHaveBeenCalled();
    });

    it('should show category keyboard for regular messages when conditions are met', () => {
      const ctx = createMockContext('I need help with something');
      const mockAddon = { platform: 'telegram' };
      const keys = [['Support'], ['Sales']];

      text.handleText(mockAddon as any, ctx, keys);

      expect(mockReply).toHaveBeenCalledWith(
        ctx,
        'Please select a service:',
        expect.objectContaining({ reply_markup: { keyboard: keys } })
      );
    });
  });

  describe('ticketHandler', () => {
    const mockAddon = { platform: 'telegram' };

    it('creates a new ticket through addNewTicket, never legacy add(open)', async () => {
      const ctx = createMockContext('Help me');
      const createdTicket = { ticketId: 1, userid: 'user123', status: 'open', category: null };
      mockGetTicketByUserId
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(createdTicket);

      const result = await text.ticketHandler(mockAddon as any, ctx);

      expect(mockAddNewTicket).toHaveBeenCalledWith('user123', null, 'telegram');
      expect(mockAdd).not.toHaveBeenCalled();
      expect(mockUserChat).toHaveBeenCalledWith(ctx, ctx.message.chat);
      expect(result).toEqual(createdTicket);
    });

    it('reuses an existing OPEN ticket', async () => {
      const ctx = createMockContext('Follow up message');
      const existingTicket = {
        ticketId: 1001,
        userid: 'user123',
        status: 'open',
        category: null,
      };
      mockGetTicketByUserId.mockResolvedValue(existingTicket);

      const result = await text.ticketHandler(mockAddon as any, ctx);

      expect(mockAddNewTicket).not.toHaveBeenCalled();
      expect(mockUserChat).toHaveBeenCalledWith(ctx, ctx.message.chat);
      expect(result).toEqual(existingTicket);
    });

    it('resumes a WAITING_USER ticket and records the event', async () => {
      const ctx = createMockContext('User response');
      const waitingTicket = { ticketId: 77, userid: 'user123', status: 'waiting_user', category: null };
      const resumedTicket = { ...waitingTicket, status: 'open' };
      mockGetTicketByUserId.mockResolvedValue(waitingTicket);
      mockTransitionTicketStatus.mockResolvedValue(resumedTicket);

      const result = await text.ticketHandler(mockAddon as any, ctx);

      expect(mockTransitionTicketStatus).toHaveBeenCalledWith(77, 'open');
      expect(mockRecordAnalyticsEvent).toHaveBeenCalledWith(
        'ticket.resumed',
        77,
        null,
        { reason: 'user_reply' },
      );
      expect(result).toEqual(resumedTicket);
    });

    it('blocks banned users before touching tickets', async () => {
      const ctx = createMockContext('Help me');
      mockCheckBan.mockResolvedValue({ userid: 'user123', messenger: 'telegram' });

      const result = await text.ticketHandler(mockAddon as any, ctx);

      expect(result).toBeNull();
      expect(mockReply).toHaveBeenCalledWith(ctx, 'Banned');
      expect(mockGetTicketByUserId).not.toHaveBeenCalled();
      expect(mockAddNewTicket).not.toHaveBeenCalled();
    });

    it('routes group chats to staff handler', async () => {
      const ctx = createMockContext('Group message', 'group');

      await text.ticketHandler(mockAddon as any, ctx);

      expect(mockStaffChat).toHaveBeenCalledWith(ctx);
      expect(mockUserChat).not.toHaveBeenCalled();
    });

    it('passes the selected category to new-ticket creation', async () => {
      const ctx = createMockContext('Help me');
      ctx.session.groupCategory = 'support';
      mockGetTicketByUserId
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ ticketId: 2, userid: 'user123', status: 'open', category: 'support' });

      await text.ticketHandler(mockAddon as any, ctx);

      expect(mockGetTicketByUserId).toHaveBeenCalledWith('user123', 'support');
      expect(mockAddNewTicket).toHaveBeenCalledWith('user123', 'support', 'telegram');
    });
  });
});