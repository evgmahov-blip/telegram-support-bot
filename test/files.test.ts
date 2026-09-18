const mockSendMessage = jest.fn();
const mockReply = jest.fn().mockResolvedValue(undefined);
const mockGetTicketByUserId = jest.fn();
const mockGetTicketById = jest.fn();
const mockGetTicketByInternalId = jest.fn();
const mockAddNewTicket = jest.fn().mockResolvedValue(2);
const mockCheckBan = jest.fn().mockResolvedValue(null);
const mockRecordAnalyticsEvent = jest.fn().mockResolvedValue(undefined);
const mockRecordAnalyticsEventBestEffort = jest.fn();
const mockPersistTicketMessage = jest.fn().mockResolvedValue(undefined);
const mockSetFirstResponseAt = jest.fn().mockResolvedValue(undefined);
const mockAddIdAndName = jest.fn().mockResolvedValue(undefined);
const mockResumeWaitingTicket = jest.fn();
const mockCanPerformAction = jest.fn().mockReturnValue(true);
const mockCanManageTicket = jest.fn().mockReturnValue(true);

jest.mock('../src/middleware', () => ({
  sendMessage: mockSendMessage,
  reply: mockReply,
}));

jest.mock('../src/db', () => ({
  getTicketByUserId: mockGetTicketByUserId,
  getTicketById: mockGetTicketById,
  getTicketByInternalId: mockGetTicketByInternalId,
  addNewTicket: mockAddNewTicket,
  checkBan: mockCheckBan,
  recordAnalyticsEvent: mockRecordAnalyticsEvent,
  recordAnalyticsEventBestEffort: mockRecordAnalyticsEventBestEffort,
  persistTicketMessage: mockPersistTicketMessage,
  setFirstResponseAt: mockSetFirstResponseAt,
  addIdAndName: mockAddIdAndName,
}));

jest.mock('../src/ticket-state', () => ({
  resumeWaitingTicket: mockResumeWaitingTicket,
}));

jest.mock('../src/team', () => ({
  canPerformAction: mockCanPerformAction,
  canManageTicket: mockCanManageTicket,
}));

jest.mock('../src/cache', () => ({
  config: {
    language: {
      from: 'from',
      language: 'Language',
      banned: 'Banned',
      blockedSpam: 'Slow down',
      ticket: 'Ticket',
      textFirst: 'Send text first',
      ticketClosedError: 'Ticket closed',
      confirmationMessage: 'Thanks',
      yourTicketId: 'Ticket',
      file_sent: 'File sent',
    },
    staffchat_id: 'staff123',
    staffchat_type: 'telegram',
    spam_time: 60000,
    spam_cant_msg: 5,
    ticket_per_message: false,
    autoreply_confirmation: false,
    show_user_ticket: false,
  },
  ticketSent: {},
  userId: '',
}));

import * as files from '../src/files';
import { Context, Messenger } from '../src/interfaces';
import cache from '../src/cache';

const activeTicket = {
  ticketId: 1001,
  userid: 'user123',
  messenger: 'telegram',
  status: 'open',
  category: 'support',
  assigned_to: 'agent1',
  first_response_at: null,
};

describe('Files Module', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    cache.ticketSent = {};
    cache.userId = '';
    cache.config.ticket_per_message = false;
    mockCheckBan.mockResolvedValue(null);
    mockCanPerformAction.mockReturnValue(true);
    mockCanManageTicket.mockReturnValue(true);
  });

  const createMockContext = (
    chatType: string = 'private',
    isAdmin: boolean = false,
  ): Context => ({
    message: {
      text: '',
      from: {
        id: isAdmin ? 'agent1' : 'user123',
        first_name: isAdmin ? 'Engineer' : 'John',
        username: isAdmin ? 'engineer' : 'john_doe',
        is_bot: false,
        language_code: 'en',
      },
      chat: {
        id: isAdmin ? 'staff123' : 'chat123',
        first_name: '',
        username: '',
        type: chatType,
      },
      message_id: 1,
      date: 1640995200,
      web_msg: false,
      reply_to_message: {
        from: { is_bot: true },
        text: 'Ticket #T001001 from John Language: en',
        caption: '',
        ...({ message_id: 777 } as any),
      },
      external_reply: { message_id: 777 },
      caption: '',
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
        category: '',
      },
      groupCategory: 'support',
      groupTag: 'SUPPORT',
      group: '',
      groupAdmin: null,
      getSessionKey: () => '',
    },
    chat: {
      id: isAdmin ? 'staff123' : 'chat123',
      first_name: '',
      username: '',
      type: chatType,
    },
    update_id: 1,
    callbackQuery: { data: '', from: { id: '' }, id: '' },
    from: { username: isAdmin ? 'engineer' : 'john_doe', id: isAdmin ? 'agent1' : 'user123' },
    inlineQuery: null,
    answerCbQuery: async () => {},
    reply: async () => {},
    getChat: async () => ({ id: '', first_name: '', username: '', type: '' }),
    getFile: async () => ({ file_id: 'file-1' }),
  });

  describe('forwardFile', () => {
    it('reuses an active user ticket and initializes spam cache with the real user id', async () => {
      const ctx = createMockContext();
      mockGetTicketByUserId.mockResolvedValue(activeTicket);

      const result = await files.forwardFile(ctx);

      expect(result).toContain('John');
      expect(cache.userId).toBe('user123');
      expect(cache.ticketSent['user123']).toBe(0);
      expect(mockAddNewTicket).not.toHaveBeenCalled();
    });

    it('blocks banned users before ticket mutation', async () => {
      const ctx = createMockContext();
      mockCheckBan.mockResolvedValue({ userid: 'user123' });

      const result = await files.forwardFile(ctx);

      expect(result).toBeUndefined();
      expect(mockReply).toHaveBeenCalledWith(ctx, 'Banned');
      expect(mockGetTicketByUserId).not.toHaveBeenCalled();
      expect(mockAddNewTicket).not.toHaveBeenCalled();
    });

    it('resumes WAITING_USER with the guarded transition', async () => {
      const ctx = createMockContext();
      const waiting = { ...activeTicket, status: 'waiting_user' };
      const resumed = { ...activeTicket, status: 'open' };
      mockGetTicketByUserId.mockResolvedValue(waiting);
      mockResumeWaitingTicket.mockResolvedValue(resumed);

      await files.forwardFile(ctx);

      expect(mockResumeWaitingTicket).toHaveBeenCalledWith(1001);
      expect(mockRecordAnalyticsEvent).toHaveBeenCalledWith(
        'ticket.resumed',
        1001,
        null,
        { reason: 'user_file' },
      );
    });

    it('creates a fresh ticket after CLOSED', async () => {
      const ctx = createMockContext();
      mockGetTicketByUserId
        .mockResolvedValueOnce({ ...activeTicket, status: 'closed' })
        .mockResolvedValueOnce({ ...activeTicket, ticketId: 1002, status: 'open' });

      await files.forwardFile(ctx);

      expect(mockAddNewTicket).toHaveBeenCalledWith('user123', 'support', 'telegram');
    });

    it('does not create tickets for staff file replies', async () => {
      const ctx = createMockContext('supergroup', true);

      const result = await files.forwardFile(ctx);

      expect(result).toBeUndefined();
      expect(mockGetTicketByUserId).not.toHaveBeenCalled();
      expect(mockAddNewTicket).not.toHaveBeenCalled();
    });
  });

  describe('fileHandler staff replies', () => {
    const bot = {
      sendDocument: jest.fn().mockResolvedValue('900'),
      sendPhoto: jest.fn().mockResolvedValue('901'),
      sendVideo: jest.fn().mockResolvedValue('902'),
      sendMessage: jest.fn(),
    } as any;

    beforeEach(() => {
      bot.sendDocument.mockClear();
      bot.sendPhoto.mockClear();
      bot.sendVideo.mockClear();
    });

    it('uses message-id correlation and the exact replied ticket', async () => {
      const ctx = createMockContext('supergroup', true);
      const olderTicket = { ...activeTicket, ticketId: 41, userid: 'user123', assigned_to: 'agent1' };
      mockGetTicketByInternalId.mockResolvedValue(olderTicket);

      await files.fileHandler('document', bot, ctx);

      expect(mockGetTicketByInternalId).toHaveBeenCalledWith(777);
      expect(mockGetTicketByUserId).not.toHaveBeenCalled();
      expect(bot.sendDocument).toHaveBeenCalledWith('user123', 'file-1', { caption: '' });
      expect(mockAddIdAndName).not.toHaveBeenCalled();
      expect(mockPersistTicketMessage).toHaveBeenCalledWith(
        41,
        'staff',
        'agent1',
        '[file:document]',
        'telegram:message:staff123:update:1',
      );
      expect(mockRecordAnalyticsEventBestEffort).toHaveBeenCalledWith(
        'ticket.message.staff',
        41,
        'agent1',
        { kind: 'file', type: 'document' },
      );
      expect(mockRecordAnalyticsEventBestEffort).toHaveBeenCalledWith(
        'ticket.replied',
        41,
        'agent1',
        { kind: 'file', type: 'document' },
      );
    });

    it('enforces ownership before sending a staff file', async () => {
      const ctx = createMockContext('supergroup', true);
      mockGetTicketByInternalId.mockResolvedValue({ ...activeTicket, assigned_to: 'agent2' });
      mockCanManageTicket.mockReturnValue(false);

      await files.fileHandler('photo', bot, ctx);

      expect(bot.sendPhoto).not.toHaveBeenCalled();
      expect(mockReply).toHaveBeenCalledWith(ctx, 'This ticket is owned by another engineer.');
    });
  });

  describe('forwardHandler', () => {
    it('returns user info for private chats', () => {
      const ctx = createMockContext();
      const result = files.forwardHandler(ctx);
      expect(result).toContain('John');
      expect(cache.userId).toBe('user123');
    });

    it('returns undefined for non-private chats', () => {
      const ctx = createMockContext('group');
      expect(files.forwardHandler(ctx)).toBeUndefined();
    });
  });
});
