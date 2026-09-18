const mockReply = jest.fn();
const mockSendMessage = jest.fn();
const mockGetTicketByInternalId = jest.fn();
const mockGetTicketByUserId = jest.fn();
const mockCheckBan = jest.fn();
const mockPersistTicketMessage = jest.fn();
const mockSetFirstResponseAt = jest.fn();
const mockRecordEventBestEffort = jest.fn();
const mockPersistCorrelation = jest.fn();
const mockCanPerformAction = jest.fn();
const mockCanManageTicket = jest.fn();

jest.mock('../src/cache', () => ({
  __esModule: true,
  default: {
    userId: '',
    ticketSent: { user1: 0 },
    config: {
      staffchat_id: 'staff123',
      staffchat_type: 'telegram',
      autoreply_confirmation: false,
      show_user_ticket: false,
      spam_time: 1000,
      spam_cant_msg: 10,
      ticket_per_message: false,
      language: {
        ticket: 'Ticket',
        from: 'from',
        language: 'language',
        ticketClosedError: 'Ticket closed',
        textFirst: 'Text first',
        confirmationMessage: 'Sent',
        yourTicketId: 'Your ticket',
        file_sent: 'File sent',
        banned: 'Banned',
        blockedSpam: 'Slow down',
      },
    },
  },
}));

jest.mock('../src/middleware', () => ({
  reply: mockReply,
  sendMessage: mockSendMessage,
}));

jest.mock('../src/db', () => ({
  getTicketByInternalId: mockGetTicketByInternalId,
  getTicketById: jest.fn(),
  getTicketByUserId: mockGetTicketByUserId,
  checkBan: mockCheckBan,
  addNewTicket: jest.fn(),
  persistTicketMessage: mockPersistTicketMessage,
  setFirstResponseAt: mockSetFirstResponseAt,
  recordAnalyticsEventBestEffort: mockRecordEventBestEffort,
  recordAnalyticsEvent: jest.fn(),
}));

jest.mock('../src/ticket-state', () => ({
  resumeWaitingTicket: jest.fn(),
}));

jest.mock('../src/team', () => ({
  canPerformAction: mockCanPerformAction,
  canManageTicket: mockCanManageTicket,
}));

jest.mock('../src/logger', () => ({
  error: jest.fn(),
}));

jest.mock('../src/staff-correlation', () => ({
  persistStaffMessageCorrelation: mockPersistCorrelation,
}));

import cache from '../src/cache';
import { fileHandler } from '../src/files';

function ticket(): any {
  return {
    ticketId: 42,
    userid: 'user1',
    messenger: 'telegram',
    status: 'open',
    assigned_to: null,
    first_response_at: null,
  };
}

function userContext(): any {
  return {
    messenger: 'telegram',
    from: { id: 'user1' },
    chat: { id: 'user1', type: 'private' },
    session: {
      admin: false,
      group: '',
      groupCategory: null,
    },
    message: {
      caption: 'screen.png',
      from: {
        id: 'user1',
        first_name: 'Alice',
        language_code: 'en',
      },
      reply_to_message: null,
    },
    getFile: jest.fn().mockResolvedValue({ file_id: 'file-1' }),
  };
}

function staffContext(): any {
  return {
    messenger: 'telegram',
    from: { id: 'agent1' },
    chat: { id: 'staff123', type: 'supergroup' },
    session: {
      admin: true,
      group: '',
      groupCategory: null,
    },
    message: {
      caption: 'diagnostic.zip',
      from: {
        id: 'agent1',
        first_name: 'Engineer',
        language_code: 'en',
      },
      reply_to_message: {
        message_id: 700,
        text: 'Ticket #T000042 from Alice language: en',
        caption: '',
      },
    },
    getFile: jest.fn().mockResolvedValue({ file_id: 'file-2' }),
  };
}

describe('file delivery reliability', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    cache.ticketSent = { user1: 0 };
    mockCheckBan.mockResolvedValue(false);
    mockGetTicketByUserId.mockResolvedValue(ticket());
    mockGetTicketByInternalId.mockResolvedValue(ticket());
    mockPersistTicketMessage.mockResolvedValue(undefined);
    mockPersistCorrelation.mockResolvedValue(undefined);
    mockSetFirstResponseAt.mockResolvedValue(undefined);
    mockCanPerformAction.mockReturnValue(true);
    mockCanManageTicket.mockReturnValue(true);
  });

  it('persists user file history before primary staff delivery', async () => {
    const error = new Error('history unavailable');
    mockPersistTicketMessage.mockRejectedValueOnce(error);
    const bot = {
      sendDocument: jest.fn().mockResolvedValue('501'),
    } as any;

    await expect(fileHandler('document', bot, userContext())).rejects.toBe(error);

    expect(mockPersistTicketMessage).toHaveBeenCalledWith(
      42,
      'user',
      'user1',
      '[file:document] screen.png',
    );
    expect(bot.sendDocument).not.toHaveBeenCalled();
    expect(mockPersistCorrelation).not.toHaveBeenCalled();
    expect(mockRecordEventBestEffort).not.toHaveBeenCalled();
  });

  it('awaits user file correlation after staff delivery before completing', async () => {
    const bot = {
      sendDocument: jest.fn().mockResolvedValue('501'),
    } as any;

    let release!: () => void;
    mockPersistCorrelation.mockImplementationOnce(() => new Promise<void>((resolve) => {
      release = resolve;
    }));

    let settled = false;
    const processing = fileHandler('document', bot, userContext()).then(() => {
      settled = true;
    });

    await new Promise((resolve) => setImmediate(resolve));

    expect(bot.sendDocument).toHaveBeenCalledWith(
      'staff123',
      'file-1',
      expect.objectContaining({ caption: expect.stringContaining('Ticket #T000042') }),
    );
    expect(mockPersistCorrelation).toHaveBeenCalledWith(42, '501', 'Alice');
    expect(mockRecordEventBestEffort).not.toHaveBeenCalled();
    expect(settled).toBe(false);

    release();
    await processing;

    expect(mockRecordEventBestEffort).toHaveBeenCalledWith(
      'ticket.message.user',
      42,
      'user1',
      { kind: 'file', type: 'document' },
    );
  });

  it('persists staff file history before primary user delivery', async () => {
    const error = new Error('history unavailable');
    mockPersistTicketMessage.mockRejectedValueOnce(error);
    const bot = {
      sendDocument: jest.fn().mockResolvedValue('900'),
    } as any;

    await expect(fileHandler('document', bot, staffContext())).rejects.toBe(error);

    expect(mockPersistTicketMessage).toHaveBeenCalledWith(
      42,
      'staff',
      'agent1',
      '[file:document] diagnostic.zip',
    );
    expect(bot.sendDocument).not.toHaveBeenCalled();
    expect(mockRecordEventBestEffort).not.toHaveBeenCalled();
  });

  it('propagates staff primary file delivery failure only after history is durable', async () => {
    const error = new Error('user delivery failed');
    const bot = {
      sendDocument: jest.fn().mockRejectedValue(error),
    } as any;

    await expect(fileHandler('document', bot, staffContext())).rejects.toBe(error);

    expect(mockPersistTicketMessage).toHaveBeenCalledTimes(1);
    expect(mockRecordEventBestEffort).not.toHaveBeenCalled();
  });

  it('keeps all staff post-delivery analytics best-effort', async () => {
    const bot = {
      sendDocument: jest.fn().mockResolvedValue('900'),
    } as any;

    await expect(fileHandler('document', bot, staffContext())).resolves.toBeUndefined();

    expect(bot.sendDocument).toHaveBeenCalledWith(
      'user1',
      'file-2',
      { caption: 'diagnostic.zip' },
    );
    expect(mockSetFirstResponseAt).toHaveBeenCalledWith(42);
    expect(mockRecordEventBestEffort).toHaveBeenCalledWith(
      'ticket.message.staff',
      42,
      'agent1',
      { kind: 'file', type: 'document' },
    );
    expect(mockRecordEventBestEffort).toHaveBeenCalledWith(
      'ticket.replied',
      42,
      'agent1',
      { kind: 'file', type: 'document' },
    );
    expect(mockPersistCorrelation).not.toHaveBeenCalled();
  });
});
