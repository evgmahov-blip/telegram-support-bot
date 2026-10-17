const reply = jest.fn().mockResolvedValue(undefined);
const sendMessage = jest.fn().mockResolvedValue('sent');
const findCompose = jest.fn();
const findIntake = jest.fn().mockResolvedValue(null);
const claimCompose = jest.fn();
const releaseCompose = jest.fn().mockResolvedValue({});
const completeCompose = jest.fn().mockResolvedValue({});
const reserveReply = jest.fn();
const markDelivered = jest.fn().mockResolvedValue(undefined);
const addNote = jest.fn().mockResolvedValue(undefined);

jest.mock('../src/cache', () => ({ __esModule: true, default: {
  config: { clean_replies: true, translate_enabled: false, forward_replies_to_parent: false,
    auto_close_tickets: false, staffchat_type: 'telegram', staffchat_id: '-100', staffchat_thread_id: 7,
    language: { dear: '', regards: '', regardsGroup: '', msg_sent: 'Sent', ticketClosedError: 'Closed',
      ticket: 'Ticket', from: 'from', language: 'language', customer: 'customer' } },
  ticketStatus: {}, ticketSent: {}, io: { to: jest.fn(() => ({ emit: jest.fn() })) },
} }));
jest.mock('../src/middleware', () => ({ strictEscape: (v: string) => v, reply, sendMessage }));
jest.mock('../src/db', () => ({
  findActiveReplyCompose: findCompose, findAnyActiveManualDraft: findIntake,
  claimReplyCompose: claimCompose, releaseReplyCompose: releaseCompose, completeReplyCompose: completeCompose,
  reserveStaffReply: reserveReply, markStaffReplyDelivered: markDelivered,
  setFirstResponseAt: jest.fn(), recordAnalyticsEventBestEffort: jest.fn(), transitionTicketStatus: jest.fn(),
  getTicketById: jest.fn(), getTicketByInternalId: jest.fn(), getTicketByUserId: jest.fn(), clearReplyPrompt: jest.fn(),
}));
jest.mock('../src/team', () => ({ canPerformAction: () => true, canManageTicket: () => true,
  getStaffRole: () => 'agent', addInternalNoteCommand: addNote }));
jest.mock('../src/manual-intake', () => ({ handleTextInput: jest.fn().mockResolvedValue(false), handleFormReply: jest.fn().mockResolvedValue(false) }));
jest.mock('../src/ticket-ui', () => ({ refreshStaffCard: jest.fn() }));
jest.mock('../src/webhooks', () => ({ webhooks: { ticketReplied: jest.fn(), ticketClosed: jest.fn() } }));
jest.mock('../src/analytics', () => ({ sendCSATSurvey: jest.fn() }));
jest.mock('../src/logger', () => ({ info: jest.fn(), error: jest.fn() }));

import { chat } from '../src/staff';

const base = { ticketId: 42, userid: 'user42', messenger: 'telegram', status: 'open', name: 'Клиент',
  assigned_to: '11', first_response_at: new Date(), category: null, pending_reply_prompt_id: 700,
  pending_reply_staff_id: '11', pending_reply_kind: 'reply', pending_reply_expires_at: new Date(Date.now() + 60_000),
  pending_reply_chat_id: '-100', pending_reply_thread_id: 7, pending_reply_version: 3 };
const context = (text = 'Готово', actor = '11', thread = 7): any => ({ update_id: 9001,
  session: { admin: true }, from: { id: actor }, chat: { id: '-100' },
  message: { message_id: 800, message_thread_id: thread, text, from: { first_name: 'Инженер' } } });

describe('durable ordinary-text ticket compose', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    findIntake.mockResolvedValue(null); findCompose.mockResolvedValue(base);
    claimCompose.mockResolvedValue(base); reserveReply.mockResolvedValue({ delivered_at: null });
    sendMessage.mockResolvedValue('sent');
    jest.requireMock('../src/db').getTicketById.mockResolvedValue(base);
    jest.requireMock('../src/db').getTicketByInternalId.mockResolvedValue(base);
  });

  it('claims the exact actor/chat/topic/version, sends once, marks delivery and completes the compose', async () => {
    await chat(context());
    expect(findCompose).toHaveBeenCalledWith('11', '-100', 7);
    expect(claimCompose).toHaveBeenCalledWith(42, '11', '-100', 7, 3, 'telegram:9001:ticket:42', '11');
    expect(sendMessage).toHaveBeenCalledWith('user42', 'telegram', 'Готово');
    expect(markDelivered).toHaveBeenCalledWith('telegram:9001:ticket:42');
    expect(completeCompose).toHaveBeenCalledWith(42, '11', 3, 'telegram:9001:ticket:42');
    expect(reply).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('отправлен клиенту'), expect.objectContaining({ message_thread_id: 7 }));
  });

  it('releases the claim and retains the draft when client delivery fails', async () => {
    sendMessage.mockRejectedValueOnce(new Error('offline'));
    await expect(chat(context())).rejects.toThrow('offline');
    expect(releaseCompose).toHaveBeenCalledWith(42, '11', 3, 'telegram:9001:ticket:42');
    expect(completeCompose).not.toHaveBeenCalled();
  });

  it('does not consume commands, wrong actors/topics, conflicting intake, or a concurrent duplicate', async () => {
    await chat(context('/close'));
    expect(findCompose).not.toHaveBeenCalled();
    findCompose.mockResolvedValueOnce(null); await chat(context('чужой', '12'));
    await chat(context('не та тема', '11', 8));
    findCompose.mockResolvedValueOnce(base); findIntake.mockResolvedValueOnce({ token: 'draft' }); await chat(context('неоднозначно'));
    claimCompose.mockResolvedValueOnce(null); await chat(context('дубликат'));
    expect(sendMessage).not.toHaveBeenCalledWith('user42', 'telegram', expect.anything());
    expect(reply).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('два активных ввода'), expect.anything());
  });

  it('keeps an ordinary note internal and completes only after it is stored', async () => {
    const note = { ...base, pending_reply_kind: 'note' };
    findCompose.mockResolvedValue(note); claimCompose.mockResolvedValue(note);
    await chat(context('секретная заметка'));
    expect(addNote).toHaveBeenCalledWith(expect.anything(), 42, 'секретная заметка', 'telegram:9001:ticket:42');
    expect(sendMessage).not.toHaveBeenCalledWith('user42', expect.anything(), expect.anything());
    expect(completeCompose).toHaveBeenCalled();
  });

  it('puts explicit replies to a durable prompt through the same claim and rejects another topic', async () => {
    const explicit = context('явный ответ');
    explicit.message.reply_to_message = { message_id: 700, text: 'prompt' };
    await chat(explicit);
    expect(claimCompose).toHaveBeenCalledWith(42, '11', '-100', 7, 3, 'telegram:9001:ticket:42', '11');
    expect(sendMessage).toHaveBeenCalledWith('user42', 'telegram', 'явный ответ');

    jest.clearAllMocks();
    const cache = require('../src/cache').default;
    cache.config.staffchat_thread_id = null;
    try {
      const wrong = context('не та тема', '11', 8);
      wrong.message.reply_to_message = { message_id: 700, text: 'prompt' };
      jest.requireMock('../src/db').getTicketByInternalId.mockResolvedValue(base);
      await chat(wrong);
      expect(claimCompose).not.toHaveBeenCalled();
      expect(sendMessage).not.toHaveBeenCalledWith('user42', expect.anything(), expect.anything());
      expect(reply).toHaveBeenCalledWith(wrong, expect.stringContaining('другому чату или теме'), expect.anything());
    } finally { cache.config.staffchat_thread_id = 7; }
  });
});
