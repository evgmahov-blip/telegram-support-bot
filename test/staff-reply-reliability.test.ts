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

jest.mock('../src/cache', () => ({
  __esModule: true,
  default: {
    config: {
      clean_replies: false,
      translate_enabled: false,
      forward_replies_to_parent: false,
      auto_close_tickets: false,
      staffchat_type: 'telegram',
      language: {
        dear: 'Dear',
        regards: 'Regards',
        regardsGroup: 'Support Team',
        msg_sent: 'Sent',
        ticketClosedError: 'Ticket closed',
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
  getTicketById: jest.fn(),
  getTicketByUserId: jest.fn(),
  persistTicketMessage: mockPersistTicketMessage,
  setFirstResponseAt: mockSetFirstResponseAt,
  recordAnalyticsEventBestEffort: mockRecordEventBestEffort,
  transitionTicketStatus: mockTransitionTicketStatus,
}));

jest.mock('../src/team', () => ({
  canPerformAction: mockCanPerformAction,
  canManageTicket: mockCanManageTicket,
  addInternalNoteCommand: jest.fn(),
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
    mockPersistTicketMessage.mockResolvedValue(undefined);
    mockSetFirstResponseAt.mockResolvedValue(undefined);
    mockTransitionTicketStatus.mockResolvedValue(null);
    mockSendCSATSurvey.mockResolvedValue(undefined);
    mockSendMessage.mockResolvedValue('sent');
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
