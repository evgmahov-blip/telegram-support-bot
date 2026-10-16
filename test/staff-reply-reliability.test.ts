const mockReply = jest.fn();
const mockSendMessage = jest.fn();
const mockGetTicketByInternalId = jest.fn();
const mockPersistTicketMessage = jest.fn();
const mockSetFirstResponseAt = jest.fn();
const mockRecordEventBestEffort = jest.fn();
const mockTransitionTicketStatus = jest.fn();
const mockCanPerformAction = jest.fn();
const mockCanManageTicket = jest.fn();
const mockTicketRepliedWebhook = jest.fn();
const mockTicketClosedWebhook = jest.fn();
const mockSendCSATSurvey = jest.fn();
const mockLogError = jest.fn();
const mockClearReplyPrompt = jest.fn();
const mockGetTicketById = jest.fn();
const mockAddInternalNote = jest.fn();
const mockReserveStaffReply = jest.fn();
const mockMarkStaffReplyDelivered = jest.fn();

jest.mock('../src/cache', () => ({
  __esModule: true,
  default: {
    config: {
      clean_replies: false,
      translate_enabled: false,
      forward_replies_to_parent: false,
      auto_close_tickets: false,
      staffchat_type: 'telegram',
      staffchat_id: 'staff123',
      staffchat_thread_id: 7,
      language: {
        dear: 'Dear',
        regards: 'Regards',
        regardsGroup: 'Support Team',
        msg_sent: 'Sent',
        ticketClosedError: 'Ticket closed',
        ticket: 'Ticket',
        from: 'from',
        language: 'language',
        customer: 'customer',
      },
    },
    ticketStatus: {},
    ticketSent: {},
  },
}));

jest.mock('../src/middleware', () => ({
  strictEscape: jest.fn((value) => value),
  reply: mockReply,
  sendMessage: mockSendMessage,
}));

jest.mock('../src/db', () => ({
  getTicketByInternalId: mockGetTicketByInternalId,
  getTicketById: mockGetTicketById,
  getTicketByUserId: jest.fn(),
  persistTicketMessage: mockPersistTicketMessage,
  setFirstResponseAt: mockSetFirstResponseAt,
  recordAnalyticsEventBestEffort: mockRecordEventBestEffort,
  transitionTicketStatus: mockTransitionTicketStatus,
  clearReplyPrompt: mockClearReplyPrompt,
  reserveStaffReply: mockReserveStaffReply,
  markStaffReplyDelivered: mockMarkStaffReplyDelivered,
}));

jest.mock('../src/team', () => ({
  canPerformAction: mockCanPerformAction,
  canManageTicket: mockCanManageTicket,
  addInternalNoteCommand: mockAddInternalNote,
}));

jest.mock('../src/webhooks', () => ({
  webhooks: {
    ticketReplied: mockTicketRepliedWebhook,
    ticketClosed: mockTicketClosedWebhook,
  },
}));

jest.mock('../src/analytics', () => ({
  sendCSATSurvey: mockSendCSATSurvey,
}));

jest.mock('../src/logger', () => ({
  info: jest.fn(),
  error: mockLogError,
}));

import cache from '../src/cache';
import { chat } from '../src/staff';

function createContext(): any {
  return {
    session: {
      admin: true,
      groupCategory: 'general',
    },
    from: {
      id: 'agent1',
    },
    chat: {
      id: 'staff123',
    },
    message: {
      message_thread_id: 7,
      text: 'We fixed it',
      from: {
        first_name: 'Engineer Name',
      },
      reply_to_message: {
        message_id: 700,
        text: 'Ticket #T000042',
        caption: '',
      },
      external_reply: {
        message_id: 0,
      },
    },
  };
}

function openTicket(): any {
  return {
    ticketId: 42,
    userid: 'user123',
    messenger: 'telegram',
    status: 'open',
    name: 'Jane',
    assigned_to: null,
    first_response_at: null,
    category: null,
  };
}

describe('staff reply delivery reliability', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (cache.config as any).auto_close_tickets = false;
    (cache.config as any).translate_enabled = false;
    mockCanPerformAction.mockReturnValue(true);
    mockCanManageTicket.mockReturnValue(true);
    mockGetTicketByInternalId.mockResolvedValue(openTicket());
    mockGetTicketById.mockResolvedValue(openTicket());
    mockPersistTicketMessage.mockResolvedValue(undefined);
    mockSetFirstResponseAt.mockResolvedValue(undefined);
    mockTransitionTicketStatus.mockResolvedValue(null);
    mockSendCSATSurvey.mockResolvedValue(undefined);
    mockSendMessage.mockResolvedValue('sent');
    mockReserveStaffReply.mockResolvedValue(null);
    mockMarkStaffReplyDelivered.mockResolvedValue(undefined);
  });

  it('accepts a durable prompt owned by the replying engineer and clears it after delivery', async () => {
    mockGetTicketByInternalId.mockResolvedValue({ ...openTicket(), assigned_to: 'agent1',
      pending_reply_prompt_id: 700, pending_reply_staff_id: 'agent1', pending_reply_expires_at: new Date(Date.now() + 60_000) });
    const context = createContext(); context.message.reply_to_message.text = 'Engineer, ответ для #T42: ответьте на это сообщение.';
    await chat(context);
    expect(mockSendMessage).toHaveBeenCalledWith('user123', 'telegram', expect.anything());
    expect(mockClearReplyPrompt).toHaveBeenCalledWith(42, 'agent1');
  });

  it('does not let another engineer cancel or use an active prompt', async () => {
    mockGetTicketByInternalId.mockResolvedValue({ ...openTicket(), assigned_to: 'agent1',
      pending_reply_prompt_id: 700, pending_reply_staff_id: 'agent1', pending_reply_expires_at: new Date(Date.now() + 60_000) });
    const context = createContext(); context.from.id = 'agent2';
    context.message.reply_to_message.text = 'Engineer, ответ для #T42: ответьте на это сообщение.';
    await chat(context);
    expect(mockClearReplyPrompt).not.toHaveBeenCalled();
    expect(mockSendMessage).not.toHaveBeenCalledWith('user123', expect.anything(), expect.anything());
  });

  it('expires a prompt without delivering its text', async () => {
    mockGetTicketByInternalId.mockResolvedValue({ ...openTicket(), assigned_to: 'agent1',
      pending_reply_prompt_id: 700, pending_reply_staff_id: 'agent1', pending_reply_expires_at: new Date(Date.now() - 1) });
    const context = createContext(); context.message.reply_to_message.text = 'Engineer, ответ для #T42: ответьте на это сообщение.';
    await chat(context);
    expect(mockClearReplyPrompt).toHaveBeenCalledWith(42, 'agent1');
    expect(mockSendMessage).not.toHaveBeenCalledWith('user123', expect.anything(), expect.anything());
  });

  it('stores a note prompt staff-only and never sends note text to the client', async () => {
    const prompted = { ...openTicket(), assigned_to: 'agent1', pending_reply_prompt_id: 700,
      pending_reply_staff_id: 'agent1', pending_reply_expires_at: new Date(Date.now() + 60_000) };
    mockGetTicketByInternalId.mockResolvedValue(prompted); mockGetTicketById.mockResolvedValue(prompted);
    const context = createContext(); context.message.text = 'private note';
    context.message.reply_to_message.text = 'Engineer, 🔒 заметка для #T42: ответьте на это сообщение.';
    await chat(context);
    expect(mockAddInternalNote).toHaveBeenCalledWith(context, 42, 'private note');
    expect(mockSendMessage).not.toHaveBeenCalledWith('user123', expect.anything(), expect.stringContaining('private note'));
  });

  it('rejects a prompt reply from the wrong configured topic', async () => {
    const context = createContext(); context.message.message_thread_id = 8;
    await chat(context);
    expect(mockPersistTicketMessage).not.toHaveBeenCalled();
    expect(mockSendMessage).not.toHaveBeenCalledWith('user123', expect.anything(), expect.anything());
    expect(mockReply).toHaveBeenCalledWith(context, expect.stringContaining('настроенной теме'));
  });

  it('reuses the same delivery reservation when a failed send is retried with the same update', async () => {
    const reservation = { delivered_at: null };
    mockReserveStaffReply.mockResolvedValue(reservation);
    mockSendMessage.mockRejectedValueOnce(new Error('temporary Telegram failure')).mockResolvedValueOnce('sent');
    const context = createContext(); context.update_id = 12345; context.message.message_id = 91;
    await expect(chat(context)).rejects.toThrow('temporary Telegram failure');
    await expect(chat(context)).resolves.toBeUndefined();
    expect(mockReserveStaffReply).toHaveBeenNthCalledWith(1, 42, 'agent1', 'We fixed it', 'telegram:12345:ticket:42');
    expect(mockReserveStaffReply).toHaveBeenNthCalledWith(2, 42, 'agent1', 'We fixed it', 'telegram:12345:ticket:42');
    expect(mockMarkStaffReplyDelivered).toHaveBeenCalledTimes(1);
  });

  it('short-circuits a retry whose reservation is already delivered', async () => {
    mockReserveStaffReply.mockResolvedValue({ delivered_at: new Date() });
    const context = createContext(); context.update_id = 12346;
    await chat(context);
    expect(mockSendMessage).not.toHaveBeenCalledWith('user123', expect.anything(), expect.anything());
    expect(mockMarkStaffReplyDelivered).not.toHaveBeenCalled();
  });

  it('fails before delivery when immutable history cannot be persisted', async () => {
    const error = new Error('history unavailable');
    mockPersistTicketMessage.mockRejectedValueOnce(error);

    await expect(chat(createContext())).rejects.toBe(error);

    expect(mockPersistTicketMessage).toHaveBeenCalledWith(
      42,
      'staff',
      'agent1',
      'We fixed it',
    );
    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(mockRecordEventBestEffort).not.toHaveBeenCalled();
  });

  it('propagates the primary user delivery failure after history is durable', async () => {
    const error = new Error('user delivery failed');
    mockSendMessage.mockRejectedValueOnce(error);

    await expect(chat(createContext())).rejects.toBe(error);

    expect(mockPersistTicketMessage).toHaveBeenCalledTimes(1);
    expect(mockRecordEventBestEffort).not.toHaveBeenCalled();
    expect(mockTransitionTicketStatus).not.toHaveBeenCalled();
  });

  it('never forwards an ordinary reply to a navigation message containing a ticket number', async () => {
    mockGetTicketByInternalId.mockResolvedValueOnce(null);
    const context = createContext();
    context.message.reply_to_message.text = 'История #T42';

    await expect(chat(context)).resolves.toBeUndefined();

    expect(mockPersistTicketMessage).not.toHaveBeenCalled();
    expect(mockSendMessage).not.toHaveBeenCalledWith('user123', expect.anything(), expect.anything());
    expect(mockReply).toHaveBeenCalledWith(context, 'Ticket closed');
  });

  it('does not replay a delivered reply when auto-close persistence keeps failing', async () => {
    (cache.config as any).auto_close_tickets = true;
    const error = new Error('mongo unavailable');
    mockTransitionTicketStatus.mockRejectedValue(error);

    await expect(chat(createContext())).resolves.toBeUndefined();

    const userDeliveries = mockSendMessage.mock.calls.filter((call) => call[0] === 'user123');
    expect(userDeliveries).toHaveLength(1);
    expect(mockTransitionTicketStatus).toHaveBeenCalledTimes(3);
    expect(mockLogError).toHaveBeenCalledWith(
      'Post-delivery ticket transition failed for #T42 -> closed:',
      error,
    );
    expect(mockRecordEventBestEffort).toHaveBeenCalledWith(
      'ticket.message.staff',
      42,
      'agent1',
    );
    expect(mockRecordEventBestEffort).toHaveBeenCalledWith(
      'ticket.replied',
      42,
      'agent1',
    );
  });

  it('treats CSAT failure as post-delivery best-effort after a successful close', async () => {
    (cache.config as any).auto_close_tickets = true;
    mockTransitionTicketStatus.mockResolvedValue(openTicket());
    const error = new Error('csat unavailable');
    mockSendCSATSurvey.mockRejectedValueOnce(error);

    await expect(chat(createContext())).resolves.toBeUndefined();

    const userDeliveries = mockSendMessage.mock.calls.filter((call) => call[0] === 'user123');
    expect(userDeliveries).toHaveLength(1);
    expect(mockRecordEventBestEffort).toHaveBeenCalledWith(
      'ticket.closed',
      42,
      'agent1',
    );
    expect(mockTicketClosedWebhook).toHaveBeenCalledWith(42, 'agent1');
    expect(mockLogError).toHaveBeenCalledWith(
      'CSAT delivery failed after closing #T42:',
      error,
    );
  });
});
