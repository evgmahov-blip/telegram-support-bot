// «Записать ответ» on a manual ticket records staff history only and never claims client delivery.
const mockReply = jest.fn().mockResolvedValue(undefined);
const mockSendMessage = jest.fn().mockResolvedValue('sent');
const mockGetTicketByInternalId = jest.fn();
const mockRecordStaffWork = jest.fn();
const mockReserveStaffReply = jest.fn();
const mockPersistTicketMessage = jest.fn();
const mockClearReplyPrompt = jest.fn();
const mockRecordEventBestEffort = jest.fn();
const mockSetFirstResponseAt = jest.fn();
const mockTransitionTicketStatus = jest.fn();
const mockTicketReplied = jest.fn();
const mockSendCSATSurvey = jest.fn();
const mockRefreshStaffCard = jest.fn();
const mockHandleFormReply = jest.fn();
const mockCanManageTicket = jest.fn().mockReturnValue(true);

jest.mock('../src/cache', () => ({ __esModule: true, default: {
  config: { clean_replies: false, translate_enabled: false, forward_replies_to_parent: false, auto_close_tickets: true,
    staffchat_type: 'telegram', staffchat_id: 'staff123', staffchat_thread_id: 7, autoreply_confirmation: true,
    language: { dear: 'Dear', regards: 'R', regardsGroup: 'G', msg_sent: 'Sent', ticketClosedError: 'Ticket closed',
      ticket: 'Ticket', from: 'from', language: 'language', customer: 'customer', file_sent: 'File sent' } },
  ticketStatus: {}, ticketSent: {}, io: { to: jest.fn(() => ({ emit: jest.fn() })) },
} }));
jest.mock('../src/middleware', () => ({ strictEscape: (v: string) => v, reply: mockReply, sendMessage: mockSendMessage }));
jest.mock('../src/db', () => ({
  getTicketByInternalId: mockGetTicketByInternalId, getTicketById: mockGetTicketByInternalId, getTicketByUserId: jest.fn(),
  recordStaffWork: mockRecordStaffWork, reserveStaffReply: mockReserveStaffReply, persistTicketMessage: mockPersistTicketMessage,
  markStaffReplyDelivered: jest.fn(), clearReplyPrompt: mockClearReplyPrompt, recordAnalyticsEventBestEffort: mockRecordEventBestEffort,
  setFirstResponseAt: mockSetFirstResponseAt, transitionTicketStatus: mockTransitionTicketStatus,
}));
jest.mock('../src/team', () => ({ canPerformAction: () => true, canManageTicket: mockCanManageTicket, addInternalNoteCommand: jest.fn() }));
jest.mock('../src/webhooks', () => ({ webhooks: { ticketReplied: mockTicketReplied, ticketClosed: jest.fn() } }));
jest.mock('../src/analytics', () => ({ sendCSATSurvey: mockSendCSATSurvey }));
jest.mock('../src/ticket-ui', () => ({ refreshStaffCard: mockRefreshStaffCard }));
jest.mock('../src/manual-intake', () => ({ handleFormReply: mockHandleFormReply }));
jest.mock('../src/logger', () => ({ info: jest.fn(), error: jest.fn() }));

import { chat } from '../src/staff';
import { fileHandler } from '../src/files';

const manual = () => ({ ticketId: 9, userid: 'MANUAL:3f1c', messenger: 'manual', status: 'open', name: 'ООО Ромашка',
  assigned_to: 'agent1', first_response_at: null, category: null, pending_reply_prompt_id: 700, pending_reply_staff_id: 'agent1',
  pending_reply_kind: 'reply', pending_reply_expires_at: new Date(Date.now() + 60_000) });
function ctx(text = 'Перезвонил, проблема решена'): any {
  return { update_id: 4242, session: { admin: true }, from: { id: 'agent1' }, chat: { id: 'staff123' },
    message: { message_id: 801, message_thread_id: 7, text, from: { first_name: 'Eng' },
      reply_to_message: { message_id: 700, text: 'prompt' } } };
}
const noClientSend = () => {
  expect(mockSendMessage).not.toHaveBeenCalledWith('MANUAL:3f1c', expect.anything(), expect.anything());
  expect(mockSendMessage.mock.calls.every((c) => c[0] === 'staff123')).toBe(true);
};

describe('manual ticket reply = record only', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetTicketByInternalId.mockResolvedValue(manual());
    mockHandleFormReply.mockResolvedValue(false);
    mockRecordStaffWork.mockResolvedValue(true);
  });

  it('records the text in history, says nothing was sent, and skips delivery/auto-close/CSAT/webhook', async () => {
    const c = ctx();
    await chat(c);
    expect(mockRecordStaffWork).toHaveBeenCalledWith(9, 'agent1', 'Перезвонил, проблема решена', 'telegram:4242:ticket:9');
    expect(mockReply).toHaveBeenCalledWith(c, expect.stringContaining('Клиенту ничего не отправлено'));
    expect(mockReply).not.toHaveBeenCalledWith(c, expect.stringContaining('Sent'));
    expect(mockReserveStaffReply).not.toHaveBeenCalled();
    expect(mockTransitionTicketStatus).not.toHaveBeenCalled();
    expect(mockSendCSATSurvey).not.toHaveBeenCalled();
    expect(mockTicketReplied).not.toHaveBeenCalled();
    expect(mockRecordEventBestEffort).toHaveBeenCalledWith('ticket.work_recorded', 9, 'agent1', { manual: true });
    expect(mockRecordEventBestEffort).not.toHaveBeenCalledWith('ticket.replied', expect.anything(), expect.anything());
    expect(mockClearReplyPrompt).toHaveBeenCalledWith(9, 'agent1');
    expect(mockRefreshStaffCard).toHaveBeenCalledWith(9);
    noClientSend();
  });

  it('a replayed Telegram update writes no second record and repeats no side effect', async () => {
    mockRecordStaffWork.mockResolvedValue(false);
    await chat(ctx());
    expect(mockReply).not.toHaveBeenCalled();
    expect(mockRecordEventBestEffort).not.toHaveBeenCalled();
    noClientSend();
  });

  it('rejects an empty or oversized record', async () => {
    await chat(ctx('   '));
    await chat(ctx('x'.repeat(3001)));
    expect(mockRecordStaffWork).not.toHaveBeenCalled();
    noClientSend();
  });

  it('a non-owner agent cannot record work on someone else\'s manual ticket', async () => {
    mockCanManageTicket.mockReturnValueOnce(false);
    await chat(ctx());
    expect(mockRecordStaffWork).not.toHaveBeenCalled();
    noClientSend();
  });

  it('an expired or foreign prompt records nothing', async () => {
    mockGetTicketByInternalId.mockResolvedValue({ ...manual(), pending_reply_staff_id: 'agent2' });
    await chat(ctx());
    mockGetTicketByInternalId.mockResolvedValue({ ...manual(), pending_reply_expires_at: new Date(Date.now() - 1) });
    await chat(ctx());
    expect(mockRecordStaffWork).not.toHaveBeenCalled();
    noClientSend();
  });

  it('routes an intake form answer to manual intake before any ticket lookup', async () => {
    mockHandleFormReply.mockResolvedValue(true);
    await chat(ctx());
    expect(mockHandleFormReply).toHaveBeenCalledWith(expect.anything(), 700);
    expect(mockGetTicketByInternalId).not.toHaveBeenCalled();
    expect(mockRecordStaffWork).not.toHaveBeenCalled();
  });

  it('ordinary group chat (not a reply) is ignored', async () => {
    const c = ctx(); delete c.message.reply_to_message;
    await chat(c);
    expect(mockHandleFormReply).not.toHaveBeenCalled();
    expect(mockRecordStaffWork).not.toHaveBeenCalled();
  });

  it('a staff file reply to a manual ticket is refused without any send or history write', async () => {
    const bot: any = { sendDocument: jest.fn(), sendPhoto: jest.fn(), sendVideo: jest.fn() };
    const c = ctx(); c.message.caption = 'скан'; c.getFile = jest.fn();
    await fileHandler('document', bot, c);
    expect(bot.sendDocument).not.toHaveBeenCalled();
    expect(c.getFile).not.toHaveBeenCalled();
    expect(mockPersistTicketMessage).not.toHaveBeenCalled();
    expect(mockReply).toHaveBeenCalledWith(c, expect.stringContaining('файлы клиенту не отправляются'));
  });
});
