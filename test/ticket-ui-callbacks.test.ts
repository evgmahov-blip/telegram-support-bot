const reply = jest.fn().mockResolvedValue(undefined);
const send = jest.fn().mockResolvedValue('88');
const getTicket = jest.fn();
const getTicketByInternalId = jest.fn();
const answer = jest.fn().mockResolvedValue(undefined);
const close = jest.fn();
const timeline = jest.fn().mockResolvedValue([]);
const edit = jest.fn().mockResolvedValue(undefined);

jest.mock('../src/middleware', () => ({ reply, sendMessage: send }));
jest.mock('../src/db', () => ({
  getTicketById: getTicket, getTicketByInternalId, listUserTickets: jest.fn(), listStaffTickets: jest.fn(), addNewTicket: jest.fn().mockResolvedValue(9),
  requestNewTicket: jest.fn().mockResolvedValue(null),
  getTicketMessageHistory: jest.fn().mockResolvedValue([]), getLatestTicketMessage: jest.fn().mockResolvedValue(null),
  getTicketTimelinePage: timeline,
  getInternalNotes: jest.fn().mockResolvedValue([]), setReplyPrompt: jest.fn(), clearReplyPrompt: jest.fn(),
  claimStaffCard: jest.fn(), releaseStaffCardClaim: jest.fn(), bindStaffCard: jest.fn(), clearStaffCardBinding: jest.fn(),
  setPendingTicketAction: jest.fn(), consumePendingTicketAction: jest.fn(), recordAnalyticsEventBestEffort: jest.fn(),
}));
jest.mock('../src/ticket-audit', () => ({ getTicketAuditHistory: jest.fn().mockResolvedValue([]) }));
jest.mock('../src/ticket-state', () => ({ transitionTicketStateFrom: jest.fn(), closeTicketLifecycle: close }));
jest.mock('../src/ticket-ownership', () => ({ takeTicket: jest.fn(), transferTicket: jest.fn() }));
jest.mock('../src/addons/telegram', () => ({ __esModule: true, default: { getInstance: () => ({ editMessage: edit }) } }));
jest.mock('../src/cache', () => ({ __esModule: true, default: { config: {
  staffchat_id: '-100', staffchat_type: 'telegram', staffchat_thread_id: 7, language: { helpCommandText: 'help' },
}, staffMembers: new Map([['42',{ telegram_id:'42', name:'Иван', role:'agent' }],
  ['43',{ telegram_id:'43', name:'Пётр', role:'agent' }]]) } }));

import { handleCallback, refreshStaffCard } from '../src/ticket-ui';
import { Context, Messenger } from '../src/interfaces';

const ticket: any = { ticketId: 7, userid: 'client', messenger: 'telegram', status: 'open', assigned_to: '42',
  category: null, priority: 'normal', staff_card_chat_id: '-100', staff_card_message_id: 55, staff_card_thread_id: 7 };
function ctx(data: string, chat=-100, thread=7, messageId=55, actor=42): Context {
  const update: any = { update_id: 900, callback_query: { data, from: { id: actor }, id: 'q',
    message: { message_id: messageId, chat: { id: chat, type: chat > 0 ? 'private' : 'supergroup' }, message_thread_id: thread } } };
  return { update_id: update.update_id, messenger: Messenger.TELEGRAM, chat: update.callback_query.message.chat,
    from: update.callback_query.from, session: { admin: chat === -100, groupCategory: null },
    callbackQuery: update.callback_query, answerCbQuery: answer } as Context;
}

describe('raw ticket card callbacks', () => {
  beforeEach(() => { jest.clearAllMocks(); getTicket.mockResolvedValue(ticket); getTicketByInternalId.mockResolvedValue(null); });
  it('rejects staff actions in the wrong group or topic', async () => {
    await handleCallback(ctx('tc:take:7', -999)); await handleCallback(ctx('tc:take:7', -100, 8));
    expect(answer).toHaveBeenCalledTimes(2); expect(close).not.toHaveBeenCalled();
  });
  it('rejects a stale canonical-card binding', async () => {
    await handleCallback(ctx('tc:wait:7', -100, 7, 54));
    expect(answer).toHaveBeenCalledWith(expect.stringContaining('устарела'), true);
  });
  it('does not expose another client ticket', async () => {
    const privateCtx = ctx('uc:open:7', 77, 0, 1, 77); privateCtx.session.admin = false;
    await handleCallback(privateCtx); expect(answer).toHaveBeenCalledWith('Обращение недоступно.', true); expect(reply).not.toHaveBeenCalled();
  });
  it('never exposes staff actor or owner IDs in client history', async () => {
    getTicket.mockResolvedValue({ ...ticket, userid: 'client' });
    timeline.mockResolvedValueOnce([{ at: new Date(), kind: 'event', actor: 'engineer-secret', text: 'ticket.transferred', metadata: { owner: 'owner-secret' } }]);
    getTicket.mockResolvedValue({ ...ticket, userid: '700' });
    await handleCallback(ctx('uc:h:7:0', 700, 0, 1, 700));
    const rendered = String(edit.mock.calls.at(-1)?.[2]);
    expect(rendered).not.toContain('engineer-secret'); expect(rendered).not.toContain('owner-secret');
  });
  it('rejects stale close confirmation without lifecycle side effects', async () => {
    const db = jest.requireMock('../src/db'); db.consumePendingTicketAction.mockResolvedValue(null);
    await handleCallback(ctx('tc:close:7:old', -100, 7, 99, 42));
    expect(close).not.toHaveBeenCalled(); expect(answer).toHaveBeenCalledWith('Подтверждение устарело.', true);
  });
  it('reports an ownership race after confirmed close', async () => {
    const db = jest.requireMock('../src/db'); db.consumePendingTicketAction.mockResolvedValue(ticket);
    close.mockResolvedValue({ outcome: 'stale', ticket: { ...ticket, assigned_to: '99' } });
    await handleCallback(ctx('tc:close:7:token', -100, 7, 99, 42));
    expect(answer).toHaveBeenCalledWith('Владелец или состояние изменились.', true);
  });
  it('rejects a transfer target that is not current staff', async () => {
    await handleCallback(ctx('tc:xfer:7:evil:token', -100, 7, 99, 42));
    expect(answer).toHaveBeenCalledWith('Выбор устарел или сотрудник недоступен.', true);
  });
  it('does not claim that a reply prompt exists when Telegram send fails', async () => {
    send.mockResolvedValueOnce(null);
    await handleCallback(ctx('tc:reply:7'));
    expect(answer).toHaveBeenCalledWith('Не удалось создать подсказку ответа.', true);
  });

  it('targets the selected engineer in the selective ForceReply prompt', async () => {
    const db = jest.requireMock('../src/db'); db.setReplyPrompt.mockResolvedValue(ticket);
    await handleCallback(ctx('tc:reply:7'));
    expect(send).toHaveBeenCalledWith('-100', 'telegram', expect.stringContaining('tg://user?id=42'),
      expect.objectContaining({ parse_mode: 'HTML', reply_markup: { force_reply: true, selective: true } }));
    expect(db.setReplyPrompt).toHaveBeenCalledWith(7, '42', 88, expect.any(Date), 'reply', '42');
  });

  it('uses real numeric staff role checks and rejects an unknown actor exactly', async () => {
    await handleCallback(ctx('tc:reply:7', -100, 7, 55, 43));
    expect(answer).toHaveBeenCalledWith('Сначала возьмите активный тикет.', true);
    expect(send).not.toHaveBeenCalled();
  });

  it('edits a persisted card after restart without sending a duplicate', async () => {
    await refreshStaffCard(7);
    expect(edit).toHaveBeenCalledWith('-100', 55, expect.stringContaining('#T000007'), expect.anything());
    expect(send).not.toHaveBeenCalled();
  });

  it('re-reads and retries a card edit when updated_at advances concurrently', async () => {
    const old = { ...ticket, updated_at: new Date('2026-01-01T00:00:00Z') };
    const fresh = { ...old, status: 'waiting_user', updated_at: new Date('2026-01-01T00:00:01Z') };
    getTicket.mockResolvedValueOnce(old).mockResolvedValueOnce(fresh).mockResolvedValueOnce(fresh);
    await refreshStaffCard(7);
    expect(edit).toHaveBeenCalledTimes(2);
    expect(edit.mock.calls[1][2]).toContain('Ждём клиента');
  });

  it('does not emit a second taken event when ownership CAS reports no change', async () => {
    const ownership = jest.requireMock('../src/ticket-ownership');
    ownership.takeTicket.mockResolvedValueOnce(null);
    await handleCallback(ctx('tc:take:7'));
    const db = jest.requireMock('../src/db');
    expect(db.recordAnalyticsEventBestEffort).not.toHaveBeenCalledWith('ticket.taken', 7, '42', expect.anything());
    expect(answer).toHaveBeenCalledWith('Тикет уже взят или неактивен.', true);
  });

  it('edits staff list pages and hides next on the last page', async () => {
    const db = jest.requireMock('../src/db'); db.listStaffTickets.mockResolvedValue([ticket]);
    await handleCallback(ctx('tm:active:0'));
    expect(db.listStaffTickets).toHaveBeenCalledWith('active', '42', 0, 7, 6);
    const markup = edit.mock.calls.at(-1)?.[3]?.reply_markup;
    expect(JSON.stringify(markup)).not.toContain('tm:active:1');
    expect(reply).not.toHaveBeenCalled();
  });

  it('traverses staff pagination forward and back with stable six-item offsets', async () => {
    const db = jest.requireMock('../src/db');
    const seven = Array.from({ length: 7 }, (_, i) => ({ ...ticket, ticketId: i + 1 }));
    db.listStaffTickets.mockResolvedValueOnce(seven).mockResolvedValueOnce([{ ...ticket, ticketId: 7 }]);
    await handleCallback(ctx('tm:active:0', -100, 7, 900));
    expect(JSON.stringify(edit.mock.calls.at(-1)?.[3]?.reply_markup)).toContain('tm:active:1');
    await handleCallback(ctx('tm:active:1', -100, 7, 900));
    expect(db.listStaffTickets).toHaveBeenLastCalledWith('active', '42', 1, 7, 6);
    const second = JSON.stringify(edit.mock.calls.at(-1)?.[3]?.reply_markup);
    expect(second).toContain('tm:active:0'); expect(second).not.toContain('tm:active:2');
  });

  it('traverses chronological history pages and hides next at the end', async () => {
    const events = Array.from({ length: 7 }, (_, i) => ({ at: new Date(2026, 0, i + 1), kind: 'user', text: `m${i + 1}` }));
    timeline.mockResolvedValueOnce(events).mockResolvedValueOnce([events[6]]);
    await handleCallback(ctx('tc:h:7:0', -100, 7, 900));
    expect(JSON.stringify(edit.mock.calls.at(-1)?.[3]?.reply_markup)).toContain('tc:h:7:1');
    await handleCallback(ctx('tc:h:7:1', -100, 7, 900));
    expect(timeline).toHaveBeenLastCalledWith(7, 1, 7, true, 6);
    const second = JSON.stringify(edit.mock.calls.at(-1)?.[3]?.reply_markup);
    expect(second).toContain('tc:h:7:0'); expect(second).not.toContain('tc:h:7:2');
  });

  it('never overwrites a bound canonical card with transient navigation', async () => {
    const db = jest.requireMock('../src/db');
    getTicketByInternalId.mockResolvedValue(ticket);
    db.setPendingTicketAction.mockResolvedValue(ticket);
    await handleCallback(ctx('tc:closeask:7'));
    expect(edit).not.toHaveBeenCalledWith(-100, 55, expect.stringContaining('Закрыть тикет'), expect.anything());
    expect(reply).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('Закрыть тикет'), expect.anything());
  });

  it('neutralizes a sent card candidate when durable binding loses the race', async () => {
    const db = jest.requireMock('../src/db');
    getTicket.mockResolvedValue({ ...ticket, staff_card_chat_id: null, staff_card_message_id: null });
    db.claimStaffCard.mockResolvedValue(ticket); db.bindStaffCard.mockResolvedValue(null);
    await refreshStaffCard(7);
    expect(edit).toHaveBeenCalledWith('-100', 88, expect.stringContaining('устарела'));
    expect(db.releaseStaffCardClaim).toHaveBeenCalled();
  });

  it('does not create an empty ticket when New request is tapped repeatedly', async () => {
    const db = jest.requireMock('../src/db');
    const privateCtx = ctx('um:new:0', 700, 0, 1, 700); privateCtx.session.admin = false;
    await handleCallback(privateCtx); await handleCallback(privateCtx);
    expect(db.addNewTicket).not.toHaveBeenCalled();
    expect(db.requestNewTicket).toHaveBeenCalledTimes(2);
    expect(reply).toHaveBeenCalledWith(privateCtx, expect.stringContaining('будет создано после отправки'), expect.anything());
  });

  it('reclaims and rebinds a card only after Telegram proves the old card is gone', async () => {
    const db = jest.requireMock('../src/db');
    edit.mockRejectedValueOnce({ description: 'Bad Request: message to edit not found' });
    db.clearStaffCardBinding.mockResolvedValueOnce({ ...ticket, staff_card_chat_id: null, staff_card_message_id: null });
    db.claimStaffCard.mockResolvedValueOnce(ticket);
    db.bindStaffCard.mockResolvedValueOnce({ ...ticket, staff_card_message_id: 88 });

    await refreshStaffCard(7);

    expect(db.clearStaffCardBinding).toHaveBeenCalledWith(7, '-100', 55);
    expect(send).toHaveBeenCalledTimes(1);
    expect(db.bindStaffCard).toHaveBeenCalledWith(7, expect.any(String), '-100', 88, 7);
  });
});
