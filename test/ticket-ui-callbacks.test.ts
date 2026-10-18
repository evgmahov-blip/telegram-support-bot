const reply = jest.fn().mockResolvedValue(undefined);
const send = jest.fn().mockResolvedValue('88');
const getTicket = jest.fn();
const getTicketByInternalId = jest.fn();
const answer = jest.fn().mockResolvedValue(undefined);
const close = jest.fn();
const timeline = jest.fn().mockResolvedValue([]);
const latest = jest.fn().mockResolvedValue(null);
const edit = jest.fn().mockResolvedValue(undefined);
const getResolution = jest.fn().mockResolvedValue(null);

jest.mock('../src/middleware', () => ({ reply, sendMessage: send }));
jest.mock('../src/db', () => ({
  getTicketById: getTicket, getTicketByInternalId, listUserTickets: jest.fn(), listStaffTickets: jest.fn(), addNewTicket: jest.fn().mockResolvedValue(9),
  requestNewTicket: jest.fn().mockResolvedValue(null),
  getTicketMessageHistory: jest.fn().mockResolvedValue([]), getLatestTicketMessage: latest,
  getTicketTimelinePage: timeline,
  getTicketResolution: getResolution,
  getInternalNotes: jest.fn().mockResolvedValue([]), setReplyPrompt: jest.fn(), clearReplyPrompt: jest.fn(),
  claimStaffCard: jest.fn(), releaseStaffCardClaim: jest.fn(), bindStaffCard: jest.fn(), clearStaffCardBinding: jest.fn(),
  setPendingTicketAction: jest.fn(), consumePendingTicketAction: jest.fn(), clearPendingTicketAction: jest.fn(), recordAnalyticsEventBestEffort: jest.fn(),
}));
jest.mock('../src/ticket-audit', () => ({ getTicketAuditHistory: jest.fn().mockResolvedValue([]) }));
jest.mock('../src/ticket-state', () => ({ transitionTicketStateFrom: jest.fn(), closeTicketLifecycle: close }));
jest.mock('../src/ticket-ownership', () => ({ takeTicket: jest.fn(), transferTicket: jest.fn() }));
jest.mock('../src/addons/telegram', () => ({ __esModule: true, default: { getInstance: () => ({ editMessage: edit }) } }));
jest.mock('../src/cache', () => ({ __esModule: true, default: { config: {
  staffchat_id: '-100', staffchat_type: 'telegram', staffchat_thread_id: 7, language: { helpCommandText: 'help' },
}, staffMembers: new Map([['42',{ telegram_id:'42', name:'Иван', role:'agent' }],
  ['43',{ telegram_id:'43', name:'Пётр', role:'agent' }]]) } }));

import { cardText, handleCallback, refreshStaffCard, resetRenderStateForTests } from '../src/ticket-ui';
import { Context, Messenger } from '../src/interfaces';

const ticket: any = { ticketId: 7, userid: 'client', messenger: 'telegram', status: 'open', assigned_to: '42',
  category: null, priority: 'normal', staff_card_chat_id: '-100', staff_card_message_id: 55, staff_card_thread_id: 7 };

describe('concise Russian card rendering', () => {
  beforeEach(() => { jest.clearAllMocks(); resetRenderStateForTests(); latest.mockResolvedValue({ text: 'Точный текст клиента' }); });

  it('shows client and useful state while omitting routine clutter', async () => {
    const rendered = await cardText({ ...ticket, name: 'Женя', created_at: new Date(), updated_at: new Date() });
    expect(rendered).toContain('<b>Заявка #7</b>');
    expect(rendered).toContain('Клиент: Женя');
    expect(rendered).toContain('Инженер: Иван');
    expect(rendered).toContain('Точный текст клиента');
    expect(rendered).not.toMatch(/Создан|Обновлён|UTC|Приоритет|Категория/);
  });

  it('keeps nondefault priority and meaningful category', async () => {
    const rendered = await cardText({ ...ticket, name: 'Женя', priority: 'urgent', category: 'Оплата' });
    expect(rendered).toContain('Приоритет: Срочный');
    expect(rendered).toContain('Категория: Оплата');
  });
});
function ctx(data: string, chat=-100, thread=7, messageId=55, actor=42): Context {
  const update: any = { update_id: 900, callback_query: { data, from: { id: actor }, id: 'q',
    message: { message_id: messageId, chat: { id: chat, type: chat > 0 ? 'private' : 'supergroup' }, message_thread_id: thread } } };
  return { update_id: update.update_id, messenger: Messenger.TELEGRAM, chat: update.callback_query.message.chat,
    from: update.callback_query.from, session: { admin: chat === -100, groupCategory: null },
    callbackQuery: update.callback_query, answerCbQuery: answer } as Context;
}

describe('raw ticket card callbacks', () => {
  beforeEach(() => { jest.clearAllMocks(); resetRenderStateForTests(); getTicket.mockResolvedValue(ticket); getTicketByInternalId.mockResolvedValue(null); });
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
  it('cancels only the matching actor-bound intent and invalidates the confirmation render cache', async () => {
    const db = jest.requireMock('../src/db');
    db.setPendingTicketAction.mockResolvedValue(ticket); db.clearPendingTicketAction.mockResolvedValue(ticket);
    await handleCallback(ctx('tc:closeask:7', -100, 7, 55, 42));
    const buttons = edit.mock.calls.at(-1)?.[3].reply_markup.inline_keyboard.flat();
    const cancelData = buttons.find((button: any) => button.text === 'Отмена').callback_data;
    const token = cancelData.split(':')[3];
    await handleCallback(ctx(cancelData, -100, 7, 55, 42));
    expect(db.clearPendingTicketAction).toHaveBeenCalledWith(7, 'close', token, '42');
    expect(edit).toHaveBeenCalledTimes(2);
    expect(edit.mock.calls[1][0]).toBe(-100); expect(edit.mock.calls[1][1]).toBe(55);
    expect(edit.mock.calls[1][2]).toContain('Заявка #7'); expect(edit.mock.calls[1][2]).not.toContain('Закрыть заявку №');
    expect(send).not.toHaveBeenCalled();
  });
  it.each([
    ['replayed', '42'], ['cross-actor', '43'],
  ])('rejects a %s close cancellation without redrawing or clearing another intent', async (_label, actorId) => {
    const db = jest.requireMock('../src/db'); db.clearPendingTicketAction.mockResolvedValue(null);
    await handleCallback(ctx('tc:closecancel:7:old', -100, 7, 55, Number(actorId)));
    expect(answer).toHaveBeenCalledWith('Подтверждение устарело.', true);
    expect(edit).not.toHaveBeenCalled();
  });
  it('restores the exact clicked card when closing fails', async () => {
    const db = jest.requireMock('../src/db'); db.consumePendingTicketAction.mockResolvedValue(ticket);
    close.mockRejectedValueOnce(new Error('temporary'));
    await handleCallback(ctx('tc:close:7:token', -100, 7, 55, 42));
    expect(edit).toHaveBeenCalledWith(-100, 55, expect.stringContaining('Не удалось закрыть заявку'), expect.anything());
    expect(send).not.toHaveBeenCalled();
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

  it('targets the selected engineer while accepting the next ordinary text', async () => {
    const db = jest.requireMock('../src/db'); db.setReplyPrompt.mockResolvedValue(ticket);
    await handleCallback(ctx('tc:reply:7'));
    expect(send).toHaveBeenCalledWith('-100', 'telegram', expect.stringContaining('tg://user?id=42'),
      expect.objectContaining({ parse_mode: 'HTML' }));
    expect(send.mock.calls.at(-1)[3].reply_markup).toBeUndefined();
    expect(db.setReplyPrompt).toHaveBeenCalledWith(7, '42', 88, expect.any(Date), 'reply', '42');
  });

  it('uses real numeric staff role checks and rejects an unknown actor exactly', async () => {
    await handleCallback(ctx('tc:reply:7', -100, 7, 55, 43));
    expect(answer).toHaveBeenCalledWith('Сначала возьмите активную заявку.', true);
    expect(send).not.toHaveBeenCalled();
  });

  it('edits a persisted card after restart without sending a duplicate', async () => {
    await refreshStaffCard(7);
    expect(edit).toHaveBeenCalledWith('-100', 55, expect.stringContaining('Заявка #7'), expect.anything());
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
    expect(answer).toHaveBeenCalledWith('Заявка уже взята или неактивна.', true);
  });

  it('edits staff list pages and hides next on the last page', async () => {
    const db = jest.requireMock('../src/db'); db.listStaffTickets.mockResolvedValue([ticket]);
    await handleCallback(ctx('tm:active:0'));
    expect(db.listStaffTickets).toHaveBeenCalledWith('active', '42', 0, 7, 6);
    const markup = edit.mock.calls.at(-1)?.[3]?.reply_markup;
    expect(JSON.stringify(markup)).not.toContain('tm:active:1');
    expect(JSON.stringify(markup)).not.toContain('callback_data":"noop');
    expect(reply).not.toHaveBeenCalled();
  });

  it('acknowledges list navigation before waiting for its database query', async () => {
    const db = jest.requireMock('../src/db');
    let release!: (tickets: any[]) => void;
    db.listStaffTickets.mockReturnValueOnce(new Promise(resolve => { release = resolve; }));
    const pending = handleCallback(ctx('tm:active:0'));
    await Promise.resolve();
    expect(answer).toHaveBeenCalledWith();
    expect(edit).not.toHaveBeenCalled();
    release([]); await pending;
  });

  it('explains historical page-number callbacks instead of silently acknowledging them', async () => {
    await handleCallback(ctx('noop'));
    expect(answer).toHaveBeenCalledWith(expect.stringContaining('номер страницы'), true);
  });

  it('deduplicates only unchanged successful renders', async () => {
    const c = ctx('tm:active:0', -100, 7, 900);
    const render = require('../src/ticket-ui').answer;
    await render(c, 'same', [[{ text: 'A', callback_data: 'a' }]]);
    await render(c, 'same', [[{ text: 'A', callback_data: 'a' }]]);
    expect(edit).toHaveBeenCalledTimes(1);
    await render(c, 'changed', [[{ text: 'A', callback_data: 'a' }]]);
    await render(c, 'changed', [[{ text: 'B', callback_data: 'b' }]]);
    expect(edit).toHaveBeenCalledTimes(3);
  });

  it('does not cache a failed edit', async () => {
    const c = ctx('tm:active:0', -100, 7, 900);
    edit.mockRejectedValueOnce(new Error('temporary')).mockResolvedValue(undefined);
    const render = require('../src/ticket-ui').answer;
    await render(c, 'screen', []);
    resetRenderStateForTests();
    await render(c, 'screen', []);
    expect(edit).toHaveBeenCalledTimes(2);
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

  it('renders close confirmation in place on the exact canonical card', async () => {
    const db = jest.requireMock('../src/db');
    getTicketByInternalId.mockResolvedValue(ticket);
    db.setPendingTicketAction.mockResolvedValue(ticket);
    await handleCallback(ctx('tc:closeask:7'));
    expect(edit).toHaveBeenCalledWith(-100, 55, expect.stringContaining('Закрыть заявку № 7?'), expect.anything());
    expect(edit.mock.calls.at(-1)?.[2]).toContain('Точный текст клиента');
    expect(send).not.toHaveBeenCalled();
  });

  it('neutralizes a sent card candidate when durable binding loses the race', async () => {
    const db = jest.requireMock('../src/db');
    getTicket.mockResolvedValue({ ...ticket, staff_card_chat_id: null, staff_card_message_id: null });
    db.claimStaffCard.mockResolvedValue(ticket); db.bindStaffCard.mockResolvedValue(null);
    await refreshStaffCard(7);
    expect(edit).toHaveBeenCalledWith('-100', 88, expect.stringContaining('устарела'),
      { reply_markup: { inline_keyboard: [[{ text: '🏠 Главная', callback_data: 'tm:home:0' }]] } });
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

describe('Home navigation on every ticket screen', () => {
  const db = jest.requireMock('../src/db');
  const userCtx = (data: string) => { const c = ctx(data, 700, 0, 1, 700); c.session.admin = false; return c; };
  // Rows of the last rendered screen, whether it edited a panel or sent a new one.
  const rowsOf = (text: string) => {
    const hit = [...edit.mock.calls.map(c => [c[2], c[3]]), ...reply.mock.calls.map(c => [c[1], c[2]])]
      .filter(([t]) => String(t).includes(text)).at(-1);
    expect(hit).toBeDefined();
    return hit[1].reply_markup.inline_keyboard as { text: string; callback_data?: string }[][];
  };
  const data = (rows: { callback_data?: string }[][]) => rows.flat().map(b => b.callback_data);
  beforeEach(() => { jest.clearAllMocks(); resetRenderStateForTests(); getTicket.mockResolvedValue(ticket); getTicketByInternalId.mockResolvedValue(null); });

  it('puts private Home on new-request instructions, help and an empty list without empty rows', async () => {
    await handleCallback(userCtx('um:new:0'));
    expect(data(rowsOf('будет создано'))).toContain('um:home:0');
    await handleCallback(userCtx('um:help:0'));
    expect(data(rowsOf('help'))).toEqual(['um:home:0']);
    db.listUserTickets.mockResolvedValueOnce([]);
    await handleCallback(userCtx('um:list:0'));
    const rows = rowsOf('Обращений пока нет');
    expect(rows.every(r => r.length > 0)).toBe(true);
    expect(data(rows)).toEqual(['um:new:0', 'um:home:0']);
  });

  it('offers a client a new request, not a reopen, on their own closed ticket', async () => {
    getTicket.mockResolvedValue({ ...ticket, userid: '700', status: 'closed' });
    await handleCallback(userCtx('uc:open:7'));
    const ids = data(rowsOf('Обращение № 7'));
    expect(ids).toEqual(expect.arrayContaining(['um:new:0', 'um:home:0']));
    expect(ids.join()).not.toContain('reopen');
  });

  it('puts staff Home on close confirmation, transfer picker and the reply/note waiting panel', async () => {
    db.setPendingTicketAction.mockResolvedValue(ticket); db.setReplyPrompt.mockResolvedValue(ticket);
    await handleCallback(ctx('tc:closeask:7'));
    expect(data(rowsOf('Закрыть заявку'))).toEqual(expect.arrayContaining([
      expect.stringMatching(/^tc:close:7:/), expect.stringMatching(/^tc:closecancel:7:/), expect.stringMatching(/^tc:closehome:7:/),
    ]));
    await handleCallback(ctx('tc:transfer:7'));
    expect(data(rowsOf('Кому передать'))).toEqual(expect.arrayContaining(['tc:open:7', 'tm:home:0']));
    await handleCallback(ctx('tc:note:7'));
    // The ordinary-text prompt stays keyboard-free; the inline panel carries cancel + Home.
    expect(send.mock.calls.at(-1)[3].reply_markup).toBeUndefined();
    expect(data(rowsOf('Ожидаю заметку'))).toEqual(['tc:cancel:7:88', 'tc:open:7', 'tm:home:0']);
  });

  it('replaces spent buttons with Home after confirmed close, transfer and cancel', async () => {
    db.consumePendingTicketAction.mockResolvedValue(ticket);
    close.mockResolvedValue({ outcome: 'closed', ticket: { ...ticket, status: 'closed' } });
    await handleCallback(ctx('tc:close:7:token', -100, 7, 900));
    expect(data(rowsOf('Заявка закрыта.'))).toEqual(expect.arrayContaining(['tc:reopen:7', 'tm:home:0']));
    jest.requireMock('../src/ticket-ownership').transferTicket.mockResolvedValueOnce(ticket);
    await handleCallback(ctx('tc:xfer:7:43:token', -100, 7, 901));
    expect(data(rowsOf('Заявка передана: № 7'))).toEqual(['tc:open:7', 'tm:home:0']);
    getTicket.mockResolvedValue({ ...ticket, pending_reply_prompt_id: 88, pending_reply_staff_id: '42' });
    await handleCallback(ctx('tc:cancel:7:88', -100, 7, 902));
    expect(db.clearReplyPrompt).toHaveBeenCalledWith(7, '42');
    expect(edit).toHaveBeenCalledWith(-100, 902, expect.stringContaining('Ожидание ответа отменено'), expect.anything());
  });

  it('shows Home on an empty staff list and Back/Home on the ticket detail panel', async () => {
    db.listStaffTickets.mockResolvedValueOnce([]);
    await handleCallback(ctx('tm:closed:0', -100, 7, 900));
    expect(data(rowsOf('Заявок нет'))).toContain('tm:home:0');
    getTicket.mockResolvedValue({ ...ticket, status: 'closed' });
    await handleCallback(ctx('tc:open:7', -100, 7, 900));
    const rows = rowsOf('Чтобы вернуть заявку в работу');
    expect(rows[0][0]).toEqual({ text: 'Перейти к карточке → «Вернуть в работу»', url: expect.stringContaining('/55?thread=7') });
    expect(data(rows)).toEqual(expect.arrayContaining(['tm:closed:0', 'tm:home:0']));
  });

  it('opens Home from the canonical card as a new panel without overwriting the card', async () => {
    getTicketByInternalId.mockResolvedValue(ticket);
    await handleCallback(ctx('tm:home:0'));
    expect(edit).not.toHaveBeenCalledWith(-100, 55, expect.anything(), expect.anything());
    expect(send).toHaveBeenCalledWith(-100, 'telegram', expect.stringContaining('Панель поддержки'), expect.anything());
  });

  it('keeps role/chat/topic checks on Home', async () => {
    await handleCallback(ctx('tm:home:0', -100, 8));
    await handleCallback(ctx('tm:home:0', 700, 0, 1, 700));
    const groupUser = ctx('um:home:0'); await handleCallback(groupUser);
    expect(answer).toHaveBeenNthCalledWith(1, 'Недоступно вне рабочей группы/темы.', true);
    expect(answer).toHaveBeenNthCalledWith(2, 'Недоступно вне рабочей группы/темы.', true);
    expect(answer).toHaveBeenNthCalledWith(3, 'Доступно только в личном чате.', true);
    expect(edit).not.toHaveBeenCalled(); expect(reply).not.toHaveBeenCalled();
  });
});

describe('staff «Вернуть в работу» on a closed canonical card', () => {
  const db = jest.requireMock('../src/db');
  const state = jest.requireMock('../src/ticket-state');
  const closed = { ...ticket, status: 'closed', closed_at: new Date('2026-10-01T00:00:00Z') };
  beforeEach(() => { jest.clearAllMocks(); resetRenderStateForTests(); getTicket.mockResolvedValue(closed); getTicketByInternalId.mockResolvedValue(null); getResolution.mockResolvedValue(null); });

  it('renders the reopen button and a Back to closed list on the canonical card', async () => {
    await refreshStaffCard(7);
    const rows = edit.mock.calls.at(-1)[3].reply_markup.inline_keyboard.flat();
    expect(rows).toEqual(expect.arrayContaining([{ text: '🔓 Вернуть в работу', callback_data: 'tc:reopen:7' },
      { text: '💾 Сохранить решение', callback_data: 'rs:start:7' },
      { text: '⬅️ Назад', callback_data: 'tm:closed:0' }, { text: '🏠 Главная', callback_data: 'tm:home:0' }]));
  });

  it('changes the closed-card action to view after a case is saved', async () => {
    getResolution.mockResolvedValue({ current_version: 1, versions: [{}] });
    await refreshStaffCard(7);
    const rows = edit.mock.calls.at(-1)[3].reply_markup.inline_keyboard.flat();
    expect(rows).toContainEqual({ text: '📘 Решение', callback_data: 'rs:view:7' });
  });

  it('reopens the same ticket via owner-guarded CAS, audits once and refreshes the canonical card', async () => {
    state.transitionTicketStateFrom.mockResolvedValueOnce({ ...closed, status: 'open', closed_at: null });
    await handleCallback(ctx('tc:reopen:7'));
    expect(state.transitionTicketStateFrom).toHaveBeenCalledWith(7, 'closed', 'open', '42');
    expect(db.recordAnalyticsEventBestEffort).toHaveBeenCalledTimes(1);
    expect(db.recordAnalyticsEventBestEffort).toHaveBeenCalledWith('ticket.reopened', 7, '42');
    expect(edit).toHaveBeenCalledWith('-100', 55, expect.stringContaining('Заявка #7'), expect.anything());
    expect(send).not.toHaveBeenCalled(); expect(db.addNewTicket).not.toHaveBeenCalled();
    expect(answer).toHaveBeenCalledWith('Готово.');
  });

  it('does not emit a second reopened event when a duplicate tap loses the CAS', async () => {
    state.transitionTicketStateFrom.mockResolvedValueOnce(null);
    await handleCallback(ctx('tc:reopen:7'));
    expect(db.recordAnalyticsEventBestEffort).not.toHaveBeenCalled();
    expect(answer).toHaveBeenCalledWith('Владелец или состояние изменились.', true);
  });

  it.each([
    ['a non-owner agent', ctx('tc:reopen:7', -100, 7, 55, 43)],
    ['a stale card', ctx('tc:reopen:7', -100, 7, 54)],
    ['the wrong topic', ctx('tc:reopen:7', -100, 8)],
    ['the wrong chat', ctx('tc:reopen:7', -999)],
    ['a client in private chat', ctx('tc:reopen:7', 700, 0, 1, 700)],
  ])('denies reopen from %s', async (_name, c) => {
    await handleCallback(c);
    expect(state.transitionTicketStateFrom).not.toHaveBeenCalled();
    expect(db.recordAnalyticsEventBestEffort).not.toHaveBeenCalled();
    expect(answer).toHaveBeenCalledWith(expect.any(String), true);
  });

  it('gives clients no reopen path even on their own ticket', async () => {
    getTicket.mockResolvedValue({ ...closed, userid: '700' });
    const c = ctx('uc:reopen:7', 700, 0, 1, 700); c.session.admin = false;
    await handleCallback(c);
    expect(state.transitionTicketStateFrom).not.toHaveBeenCalled();
  });
});


it('sends a plain-message navigation answer to the actual topic when none is configured', async () => {
  const cache = require('../src/cache').default;
  const previous = cache.config.staffchat_thread_id;
  try {
    cache.config.staffchat_thread_id = null;
    const c: any = ctx('tm:home:0', -100, 9);
    delete c.callbackQuery;
    c.message = { chat: c.chat, message_id: 100, message_thread_id: 9, text: 'Клиент' };
    const render = require('../src/ticket-ui').answer;
    await render(c, 'Следующий вопрос', []);
    expect(reply).toHaveBeenLastCalledWith(c, 'Следующий вопрос',
      expect.objectContaining({ message_thread_id: 9 }));
  } finally { cache.config.staffchat_thread_id = previous; }
});
it('keeps a canonical-card fallback answer in its originating topic', async () => {
  const cache = require('../src/cache').default;
  const previous = cache.config.staffchat_thread_id;
  try {
    cache.config.staffchat_thread_id = null;
    getTicketByInternalId.mockResolvedValueOnce({ staff_card_message_id: 55, staff_card_chat_id: '-100', staff_card_thread_id: 9 });
    const c = ctx('tm:home:0', -100, 9);
    await require('../src/ticket-ui').answer(c, 'Меню', []);
    expect(send).toHaveBeenLastCalledWith(-100, 'telegram', 'Меню',
      expect.objectContaining({ message_thread_id: 9 }));
  } finally { cache.config.staffchat_thread_id = previous; }
});
