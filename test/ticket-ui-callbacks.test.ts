const reply = jest.fn().mockResolvedValue(undefined);
const send = jest.fn().mockResolvedValue('88');
const getTicket = jest.fn();
const answer = jest.fn().mockResolvedValue(undefined);
const close = jest.fn();
const timeline = jest.fn().mockResolvedValue([]);

jest.mock('../src/middleware', () => ({ reply, sendMessage: send }));
jest.mock('../src/db', () => ({
  getTicketById: getTicket, listUserTickets: jest.fn(), listStaffTickets: jest.fn(), addNewTicket: jest.fn().mockResolvedValue(9),
  getTicketMessageHistory: jest.fn().mockResolvedValue([]), getLatestTicketMessage: jest.fn().mockResolvedValue(null),
  getTicketTimelinePage: timeline,
  getInternalNotes: jest.fn().mockResolvedValue([]), setReplyPrompt: jest.fn(), clearReplyPrompt: jest.fn(),
  setPendingTicketAction: jest.fn(), consumePendingTicketAction: jest.fn(), recordAnalyticsEventBestEffort: jest.fn(),
}));
jest.mock('../src/ticket-audit', () => ({ getTicketAuditHistory: jest.fn().mockResolvedValue([]) }));
jest.mock('../src/ticket-state', () => ({ transitionTicketStateFrom: jest.fn(), closeTicketLifecycle: close }));
jest.mock('../src/ticket-ownership', () => ({ takeTicket: jest.fn(), transferTicket: jest.fn() }));
jest.mock('../src/team', () => ({
  getStaffRole: jest.fn((id: string) => id === '42' ? 'agent' : null), canPerformAction: jest.fn().mockReturnValue(true), canManageTicket: jest.fn().mockReturnValue(true),
}));
jest.mock('../src/addons/telegram', () => ({ __esModule: true, default: { getInstance: () => ({ editMessage: jest.fn() }) } }));
jest.mock('../src/cache', () => ({ __esModule: true, default: { config: {
  staffchat_id: '-100', staffchat_type: 'telegram', staffchat_thread_id: 7, language: { helpCommandText: 'help' },
}, staffMembers: new Map([['42',{ telegram_id:'42', name:'Иван', role:'agent' }]]) } }));

import { handleCallback } from '../src/ticket-ui';
import { Context, Messenger } from '../src/interfaces';

const ticket: any = { ticketId: 7, userid: 'client', messenger: 'telegram', status: 'open', assigned_to: '42',
  category: null, priority: 'normal', staff_card_chat_id: '-100', staff_card_message_id: 55, staff_card_thread_id: 7 };
function ctx(data: string, chat='-100', thread=7, messageId=55, actor='42'): Context {
  return { messenger: Messenger.TELEGRAM, chat: { id: chat, type: chat==='private'?'private':'supergroup' }, from: { id: actor },
    session: { admin: chat==='-100', groupCategory: null }, callbackQuery: { data, from: { id: actor }, id: 'q',
      message: { message_id: messageId, chat: { id: chat }, message_thread_id: thread } }, answerCbQuery: answer,
    message: { chat: { id: chat }, from: { id: actor } } } as Context;
}

describe('raw ticket card callbacks', () => {
  beforeEach(() => { jest.clearAllMocks(); getTicket.mockResolvedValue(ticket); });
  it('rejects staff actions in the wrong group or topic', async () => {
    await handleCallback(ctx('tc:take:7', '-999')); await handleCallback(ctx('tc:take:7', '-100', 8));
    expect(answer).toHaveBeenCalledTimes(2); expect(close).not.toHaveBeenCalled();
  });
  it('rejects a stale canonical-card binding', async () => {
    await handleCallback(ctx('tc:wait:7', '-100', 7, 54));
    expect(answer).toHaveBeenCalledWith(expect.stringContaining('устарела'), true);
  });
  it('does not expose another client ticket', async () => {
    const privateCtx = ctx('uc:open:7', 'private', 0, 1, 'intruder'); privateCtx.session.admin = false;
    await handleCallback(privateCtx); expect(answer).toHaveBeenCalledWith('Обращение недоступно.', true); expect(reply).not.toHaveBeenCalled();
  });
  it('never exposes staff actor or owner IDs in client history', async () => {
    getTicket.mockResolvedValue({ ...ticket, userid: 'client' });
    timeline.mockResolvedValueOnce([{ at: new Date(), kind: 'event', actor: 'engineer-secret', text: 'ticket.transferred', metadata: { owner: 'owner-secret' } }]);
    await handleCallback(ctx('uc:h:7:0', 'private', 0, 1, 'client'));
    const rendered = String(reply.mock.calls.at(-1)?.[1]);
    expect(rendered).not.toContain('engineer-secret'); expect(rendered).not.toContain('owner-secret');
  });
  it('rejects stale close confirmation without lifecycle side effects', async () => {
    const db = jest.requireMock('../src/db'); db.consumePendingTicketAction.mockResolvedValue(null);
    await handleCallback(ctx('tc:close:7:old', '-100', 7, 99));
    expect(close).not.toHaveBeenCalled(); expect(answer).toHaveBeenCalledWith('Подтверждение устарело.', true);
  });
  it('reports an ownership race after confirmed close', async () => {
    const db = jest.requireMock('../src/db'); db.consumePendingTicketAction.mockResolvedValue(ticket);
    close.mockResolvedValue({ outcome: 'stale', ticket: { ...ticket, assigned_to: '99' } });
    await handleCallback(ctx('tc:close:7:token', '-100', 7, 99));
    expect(answer).toHaveBeenCalledWith('Владелец или состояние изменились.', true);
  });
  it('rejects a transfer target that is not current staff', async () => {
    await handleCallback(ctx('tc:xfer:7:evil:token', '-100', 7, 99));
    expect(answer).toHaveBeenCalledWith('Выбор устарел или сотрудник недоступен.', true);
  });
  it('does not claim that a reply prompt exists when Telegram send fails', async () => {
    send.mockResolvedValueOnce(null);
    await handleCallback(ctx('tc:reply:7'));
    expect(answer).toHaveBeenCalledWith('Не удалось создать подсказку ответа.', true);
  });
});
