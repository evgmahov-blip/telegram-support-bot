// Mock dependencies with better structure
const mockReply = jest.fn().mockResolvedValue(undefined);
const mockSendMessage = jest.fn().mockResolvedValue(undefined);
const mockCloseAll = jest.fn().mockResolvedValue(undefined);
const mockTransitionTicketStatus = jest.fn().mockResolvedValue({ ticketId: 1001, status: 'open' });
const mockBanUser = jest.fn().mockResolvedValue(undefined);
const mockUnbanUser = jest.fn().mockResolvedValue(undefined);

jest.mock('../src/middleware', () => ({
  reply: mockReply,
  sendMessage: mockSendMessage,
  strictEscape: jest.fn((value: string) => value),
}));

jest.mock('../src/db', () => ({
  closeAll: mockCloseAll,
  open: jest.fn().mockResolvedValue([]),
  getByTicketId: jest.fn().mockResolvedValue({ userid: 'user123', id: { toString: () => 'ticket1' } }),
  getTicketById: jest.fn().mockResolvedValue({
    ticketId: 1001,
    userid: 'user123',
    messenger: 'telegram',
    status: 'closed',
    category: null,
  }),
  getTicketByUserId: jest.fn().mockResolvedValue(null),
  transitionTicketStatus: mockTransitionTicketStatus,
  banUser: mockBanUser,
  unbanUser: mockUnbanUser,
  addTicketMessage: jest.fn().mockResolvedValue(undefined),
  recordAnalyticsEvent: jest.fn().mockResolvedValue(undefined),
  getInternalNotes: jest.fn().mockResolvedValue([]),
  getConversationHistory: jest.fn().mockResolvedValue([]),
}));

jest.mock('../src/cache', () => ({
  config: {
    language: {
      helpCommandText: 'Help: /start, /help',
      helpCommandStaffText: 'Staff: /clear, /open, /close',
      from: 'From:',
      openTickets: 'Open Tickets',
      ticket: 'Ticket',
      closed: 'closed',
      ticketClosed: 'Your ticket has been closed.',
      ticketClosedError: 'Ticket closed error',
      banned: 'banned',
      usr_with_ticket: 'User with ticket',
    },
    parse_mode: 'MarkdownV2',
    categories: [],
    user_commands: [],
    allow_broadcast: false,
  },
  ticketIDs: {},
  ticketStatus: {},
  ticketSent: {},
  staffMembers: new Map(),
}));

jest.mock('../src/team', () => ({
  canPerformAction: jest.fn().mockReturnValue(true),
}));

jest.mock('../src/workflows', () => ({
  listCannedResponses: jest.fn().mockReturnValue(''),
  getCannedResponse: jest.fn().mockReturnValue(null),
}));

jest.mock('../src/analytics', () => ({
  sendCSATSurvey: jest.fn().mockResolvedValue(undefined),
  showStatsCommand: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../src/webhooks', () => ({
  webhooks: {
    ticketClosed: jest.fn().mockResolvedValue(undefined),
  },
}));

import * as commands from '../src/commands';
import { Context, Messenger } from '../src/interfaces';
import cache from '../src/cache';

describe('Commands Module', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockTransitionTicketStatus.mockResolvedValue({ ticketId: 1001, status: 'open' });
    Object.keys(cache.ticketIDs).forEach(k => delete cache.ticketIDs[k]);
    Object.keys(cache.ticketStatus).forEach(k => delete cache.ticketStatus[k]);
    Object.keys(cache.ticketSent).forEach(k => delete cache.ticketSent[k]);
  });

  const createMockContext = (isAdmin: boolean = false): Context => ({
    message: {
      text: '/help',
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
        type: 'private',
      },
      message_id: 1,
      date: 1640995200,
      web_msg: false,
      reply_to_message: {
        from: { is_bot: true },
        text: '#T001001 From: John Doe',
        caption: '',
      },
      external_reply: { message_id: 0 },
      caption: '',
      getFile: jest.fn(),
    },
    messenger: Messenger.TELEGRAM,
    session: {
      lastContactDate: 0,
      admin: isAdmin,
      mode: null,
      modeData: {
        ticketid: '',
        userid: '',
        name: '',
        category: 'support',
      },
      groupCategory: 'support',
      groupTag: 'SUPPORT',
      group: '',
      groupAdmin: null,
      getSessionKey: () => '',
    },
    chat: {
      id: 'chat123',
      first_name: 'John',
      username: 'john_doe',
      type: 'private',
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

  describe('helpCommand', () => {
    it('should show help text for regular users', () => {
      const ctx = createMockContext(false);

      commands.helpCommand(ctx);

      expect(mockReply).toHaveBeenCalledWith(
        ctx,
        'Help: /start, /help',
        { parse_mode: 'MarkdownV2' }
      );
    });

    it('should show staff help text for admin users', () => {
      const ctx = createMockContext(true);

      commands.helpCommand(ctx);

      expect(mockReply).toHaveBeenCalledWith(
        ctx,
        expect.stringContaining('/clear'),
        { parse_mode: 'MarkdownV2' }
      );
    });
  });

  describe('clearCommand', () => {
    it('should clear all tickets for admin users', async () => {
      const ctx = createMockContext(true);

      await commands.clearCommand(ctx);

      expect(mockCloseAll).toHaveBeenCalled();
      expect(Object.keys(cache.ticketIDs)).toHaveLength(0);
      expect(mockReply).toHaveBeenCalledWith(ctx, 'All tickets closed.');
    });

    it('should reject non-admin users', async () => {
      const ctx = createMockContext(false);

      await commands.clearCommand(ctx);

      expect(mockCloseAll).not.toHaveBeenCalled();
      expect(mockReply).not.toHaveBeenCalled();
    });
  });

  describe('openCommand', () => {
    it('should process open tickets for admin users', async () => {
      const ctx = createMockContext(true);

      await commands.openCommand(ctx);

      expect(mockReply).toHaveBeenCalled();
    });

    it('should reject non-admin users', async () => {
      const ctx = createMockContext(false);

      await commands.openCommand(ctx);

      expect(mockReply).not.toHaveBeenCalled();
    });
  });

  describe('closeCommand', () => {
    it('closes the resolved ticket through the lifecycle API', async () => {
      const ctx = createMockContext(true);
      mockTransitionTicketStatus.mockResolvedValue({ ticketId: 1001, status: 'closed' });

      await commands.closeCommand(ctx);

      expect(mockTransitionTicketStatus).toHaveBeenCalledWith(1001, 'closed');
    });
  });

  describe('reopenCommand', () => {
    it('reopens the resolved ticket through the lifecycle API', async () => {
      const ctx = createMockContext(true);

      await commands.reopenCommand(ctx);

      expect(mockTransitionTicketStatus).toHaveBeenCalledWith(1001, 'open');
    });
  });

  describe('banCommand', () => {
    it('stores a user ban separately from ticket state', async () => {
      const ctx = createMockContext(true);

      await commands.banCommand(ctx);

      expect(mockBanUser).toHaveBeenCalledWith('user123', 'telegram');
    });
  });

  describe('unbanCommand', () => {
    it('removes the user ban without reopening the ticket', async () => {
      const ctx = createMockContext(true);

      await commands.unbanCommand(ctx);

      expect(mockUnbanUser).toHaveBeenCalledWith('user123', 'telegram');
      expect(mockTransitionTicketStatus).not.toHaveBeenCalled();
    });
  });

  describe('Error handling', () => {
    it('should handle missing reply message gracefully', async () => {
      const ctx = createMockContext(true);
      ctx.message.reply_to_message = {
        from: { is_bot: false },
        text: '',
        caption: '',
      };

      await expect(commands.closeCommand(ctx)).resolves.not.toThrow();
      await expect(commands.reopenCommand(ctx)).resolves.not.toThrow();
    });
  });
});