const mockReply = jest.fn().mockResolvedValue(undefined);
const mockSendMessage = jest.fn().mockResolvedValue(undefined);
const mockGetTicketByInternalId = jest.fn();
const mockGetTicketById = jest.fn();
const mockGetTicketByUserId = jest.fn();
const mockTransition = jest.fn();
const mockRecordEvent = jest.fn().mockResolvedValue(undefined);
const mockWebhook = jest.fn();
const mockGetStaffRole = jest.fn().mockReturnValue('agent');
const mockCanPerformAction = jest.fn().mockReturnValue(true);
const mockCanManageTicket = jest.fn().mockReturnValue(true);

jest.mock('../src/middleware', () => ({
  reply: mockReply,
  sendMessage: mockSendMessage,
  strictEscape: jest.fn((value: string) => value),
}));
jest.mock('../src/db', () => ({
  getTicketByInternalId: mockGetTicketByInternalId,
  getTicketById: mockGetTicketById,
  getTicketByUserId: mockGetTicketByUserId,
  transitionTicketStatus: jest.fn(),
  recordAnalyticsEvent: mockRecordEvent,
  closeAll: jest.fn(),
  open: jest.fn(),
  banUser: jest.fn(),
  unbanUser: jest.fn(),
  getInternalNotes: jest.fn(),
  getConversationHistory: jest.fn(),
}));
jest.mock('../src/ticket-state', () => ({ transitionTicketStateFrom: mockTransition }));
jest.mock('../src/team', () => ({
  getStaffRole: mockGetStaffRole,
  canPerformAction: mockCanPerformAction,
  canManageTicket: mockCanManageTicket,
}));
jest.mock('../src/webhooks', () => ({ webhooks: { ticketClosed: mockWebhook } }));
jest.mock('../src/analytics', () => ({ sendCSATSurvey: jest.fn(), showStatsCommand: jest.fn() }));
jest.mock('../src/workflows', () => ({ listCannedResponses: jest.fn(), getCannedResponse: jest.fn() }));
jest.mock('../src/cache', () => ({
  __esModule: true,
  default: {
    config: {
      language: {
        from: 'От', ticket: 'Тикет', closed: 'закрыт', ticketClosed: 'Ваш тикет закрыт.',
      },
      allow_user_close: false,
    },
    ticketIDs: { 'user-1': 1 },
    ticketStatus: { 'user-1': 'open' },
    ticketSent: { 'user-1': true },
    staffMembers: new Map(),
  },
}));

import * as commands from '../src/commands';
import cache from '../src/cache';
import { Context, Messenger } from '../src/interfaces';

const ticket = {
  ticketId: 1,
  userid: 'user-1',
  messenger: Messenger.TELEGRAM,
  status: 'open',
  assigned_to: 'staff-1',
  category: null,
};

function ctxWithReply(reply?: Record<string, unknown>): Context {
  return {
    update: {
      update_id: 101,
      message: {
        message_id: 22,
        date: 1,
        text: '/close',
        chat: { id: -1001, type: 'supergroup', title: 'Support' },
        from: { id: 700, is_bot: false, first_name: 'Staff' },
        ...(reply ? { reply_to_message: reply } : {}),
      },
    },
    message: {
      message_id: 22,
      date: 1,
      text: '/close',
      chat: { id: -1001, type: 'supergroup' },
      from: { id: 'staff-1', is_bot: false },
      ...(reply ? { reply_to_message: reply } : {}),
    },
    chat: { id: -1001, type: 'supergroup' },
    from: { id: 'staff-1' },
    messenger: Messenger.TELEGRAM,
    session: { admin: true, groupCategory: null },
  } as unknown as Context;
}

describe('production /close regression', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetStaffRole.mockReturnValue('agent');
    mockCanPerformAction.mockReturnValue(true);
    mockCanManageTicket.mockReturnValue(true);
    mockGetTicketByInternalId.mockResolvedValue(null);
    mockGetTicketById.mockResolvedValue(null);
    mockTransition.mockResolvedValue({ ...ticket, status: 'closed' });
    mockSendMessage.mockResolvedValue(undefined);
    Object.assign(cache.ticketIDs, { 'user-1': 1 });
    Object.assign(cache.ticketStatus, { 'user-1': 'open' });
    Object.assign(cache.ticketSent, { 'user-1': true });
  });

  it('closes persisted internalIds[6] from a plain non-bot staff reply', async () => {
    mockGetTicketByInternalId.mockResolvedValue(ticket);
    const ctx = ctxWithReply({ message_id: 6, text: 'Обычный ответ сотрудника', from: { id: 8, is_bot: false } });

    await commands.closeCommand(ctx);

    expect(mockGetTicketByInternalId).toHaveBeenCalledWith(6);
    expect(mockTransition).toHaveBeenCalledWith(1, ['open', 'waiting_user'], 'closed', 'staff-1');
    expect(mockRecordEvent).toHaveBeenCalledWith('ticket.closed', 1, 'staff-1');
    expect(mockWebhook).toHaveBeenCalledWith(1, 'user-1');
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    expect(cache.ticketIDs['user-1']).toBeUndefined();
  });

  it('keeps the bot-authored legacy text fallback', async () => {
    mockGetTicketById.mockResolvedValue(ticket);
    await commands.closeCommand(ctxWithReply({ text: 'Тикет #T000001 От Иван', from: { id: 9, is_bot: true } }));
    expect(mockGetTicketById).toHaveBeenCalledWith(1, null);
    expect(mockTransition).toHaveBeenCalled();
  });

  it.each([
    ['no reply', ctxWithReply(), 'Ответьте командой /close на сообщение тикета.'],
    ['unknown reply', ctxWithReply({ message_id: 404, text: 'нет тикета', from: { is_bot: false } }), 'Не удалось найти тикет по сообщению.'],
  ])('reports %s explicitly', async (_name, ctx, feedback) => {
    await commands.closeCommand(ctx);
    expect(mockReply).toHaveBeenCalledWith(ctx, feedback);
    expect(mockTransition).not.toHaveBeenCalled();
  });

  it('does not transition or notify an already closed ticket', async () => {
    mockGetTicketByInternalId.mockResolvedValue({ ...ticket, status: 'closed' });
    const ctx = ctxWithReply({ message_id: 6, from: { is_bot: false } });
    await commands.closeCommand(ctx);
    expect(mockReply).toHaveBeenCalledWith(ctx, 'Тикет уже закрыт.');
    expect(mockTransition).not.toHaveBeenCalled();
    expect(mockRecordEvent).not.toHaveBeenCalled();
    expect(mockWebhook).not.toHaveBeenCalled();
  });

  it('preserves staff ownership restrictions', async () => {
    mockGetTicketByInternalId.mockResolvedValue({ ...ticket, assigned_to: 'staff-2' });
    mockCanManageTicket.mockReturnValue(false);
    await commands.closeCommand(ctxWithReply({ message_id: 6, from: { is_bot: false } }));
    expect(mockTransition).not.toHaveBeenCalled();
    expect(mockReply).toHaveBeenCalledWith(expect.anything(), 'Этот тикет назначен другому сотруднику.');
  });

  it('is idempotent when another close wins the race', async () => {
    mockGetTicketByInternalId.mockResolvedValue(ticket);
    mockTransition.mockResolvedValue(null);
    mockGetTicketById.mockResolvedValue({ ...ticket, status: 'closed' });
    await commands.closeCommand(ctxWithReply({ message_id: 6, from: { is_bot: false } }));
    expect(mockReply).toHaveBeenCalledWith(expect.anything(), 'Тикет уже закрыт.');
    expect(mockRecordEvent).not.toHaveBeenCalled();
    expect(mockWebhook).not.toHaveBeenCalled();
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it('reports user notification failure honestly after the durable close', async () => {
    mockGetTicketByInternalId.mockResolvedValue(ticket);
    mockSendMessage.mockRejectedValue(new Error('Telegram blocked'));
    const ctx = ctxWithReply({ message_id: 6, from: { is_bot: false } });
    await commands.closeCommand(ctx);
    expect(mockRecordEvent).toHaveBeenCalledTimes(1);
    expect(mockWebhook).toHaveBeenCalledTimes(1);
    expect(mockReply).toHaveBeenCalledWith(ctx, 'Тикет закрыт, но уведомление пользователю не доставлено.');
  });
});
