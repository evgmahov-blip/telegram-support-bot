// Return to common: engineer A (42) returns a personal ticket from the private card,
// engineer B (43) finds a fresh record in the support chat/topic and opens the same ticket.
const reply = jest.fn().mockResolvedValue(undefined);
const send = jest.fn();
const edit = jest.fn().mockResolvedValue(undefined);
const answer = jest.fn().mockResolvedValue(undefined);
const latest = jest.fn();
const clone = (v: any) => v == null ? v : structuredClone(v);
let row: any;
let nextMessageId = 100;

jest.mock('../src/middleware', () => ({ reply, sendMessage: send }));
jest.mock('../src/db', () => ({
  getTicketById: jest.fn(async (id: number) => row?.ticketId === id ? clone(row) : null),
  getTicketByInternalId: jest.fn(async (id: number) => row?.staff_card_message_id === id ? clone(row) : null),
  getLatestTicketMessage: latest, getTicketResolution: jest.fn().mockResolvedValue(null),
  listStaffTickets: jest.fn().mockResolvedValue([]), countStaffTickets: jest.fn().mockResolvedValue(null),
  recordAnalyticsEventBestEffort: jest.fn(),
  setTicketCommonVisibility: jest.fn(async (id: number, common: boolean, owner: string) => {
    if (row.ticketId !== id || row.assigned_to !== owner || Boolean(row.common_visible) === common) return null;
    const at = new Date(+row.updated_at + 1000);
    Object.assign(row, { common_visible: common, common_visible_since: common ? at : null, updated_at: at,
      ...(common ? { common_return_notice: { key: 's' + at.getTime(), state: 'pending', at, attempts: 0 } } : {}) });
    return clone(row);
  }),
  claimCommonReturnNotice: jest.fn(async (_id: number, key: string, prior: number | null) => {
    const n = row.common_return_notice;
    if (n?.key !== key || n.state !== 'pending') return null;
    Object.assign(n, { state: 'sending', prior_card: prior, claimed_at: new Date() });
    return clone(row);
  }),
  settleCommonReturnNotice: jest.fn(async (_id: number, key: string, state: string, fields: any = {}) => {
    const n = row.common_return_notice;
    if (n?.key !== key || n.state !== 'sending') return null;
    Object.assign(n, { state, claimed_at: null, ...fields });
    return clone(row);
  }),
  expireCommonReturnNoticeClaims: jest.fn(async (olderThan: Date) => {
    const n = row.common_return_notice;
    if (n?.state === 'sending' && +n.claimed_at < +olderThan) Object.assign(n, { state: 'unknown', claimed_at: null });
  }),
  listPendingCommonReturnNotices: jest.fn(async () => row.common_return_notice?.state === 'pending' ? [row.ticketId] : []),
  claimStaffCard: jest.fn(async (_id: number, claim: string) => {
    if (row.staff_card_message_id || row.staff_card_claim) return null;
    row.staff_card_claim = claim; return clone(row);
  }),
  bindStaffCard: jest.fn(async (_id: number, claim: string, chat: string, messageId: number, thread: number | null) => {
    if (row.staff_card_message_id || row.staff_card_claim !== claim) return null;
    Object.assign(row, { staff_card_chat_id: chat, staff_card_message_id: messageId, staff_card_thread_id: thread, staff_card_claim: null });
    return clone(row);
  }),
  releaseStaffCardClaim: jest.fn(async (_id: number, claim: string) => { if (row.staff_card_claim === claim) row.staff_card_claim = null; }),
  clearStaffCardBinding: jest.fn(),
}));
jest.mock('../src/ticket-audit', () => ({ getTicketAuditHistory: jest.fn().mockResolvedValue([]) }));
jest.mock('../src/ticket-state', () => ({ transitionTicketStateFrom: jest.fn(), closeTicketLifecycle: jest.fn() }));
jest.mock('../src/ticket-ownership', () => ({
  takeTicket: jest.fn(async (_id: number, actor: string) => {
    if (row.assigned_to && !row.common_visible) return null;
    Object.assign(row, { assigned_to: actor, common_visible: false, common_visible_since: null, updated_at: new Date(+row.updated_at + 1000) });
    return clone(row);
  }),
  transferTicket: jest.fn(),
}));
jest.mock('../src/ticket-resolution-case', () => ({ startClose: jest.fn(), cancelForHome: jest.fn(), handleCallback: jest.fn() }));
jest.mock('../src/addons/telegram', () => ({ __esModule: true, default: { getInstance: () => ({ editMessage: edit }) } }));
jest.mock('../src/cache', () => ({ __esModule: true, default: { config: {
  staffchat_id: '-100', staffchat_type: 'telegram', staffchat_thread_id: 7, language: { helpCommandText: 'help' },
}, staffMembers: new Map([
  ['42', { telegram_id: '42', name: 'Анна', role: 'agent' }],
  ['43', { telegram_id: '43', name: 'Борис', role: 'agent' }],
]) } }));

import { handleCallback, publishCommonReturn, recoverCommonReturns, resetRenderStateForTests } from '../src/ticket-ui';
import { Context, Messenger } from '../src/interfaces';

const SECRET = 'Пароль от роутера 12345';
function personal(extra: any = {}) {
  return { ticketId: 7, userid: 'client-700', messenger: 'telegram', status: 'open', assigned_to: '42', name: 'Клиент Иванов',
    common_visible: false, common_visible_since: null, updated_at: new Date('2026-11-10T10:00:00Z'), category: null,
    priority: 'normal', staff_card_chat_id: '-100', staff_card_message_id: 55, staff_card_thread_id: 7, ...extra };
}
function dm(data: string, actor = 42): Context {
  const q: any = { data, from: { id: actor }, id: 'q', message: { message_id: 70, chat: { id: actor, type: 'private' } } };
  return { messenger: Messenger.TELEGRAM, chat: q.message.chat, from: q.from, session: { admin: false, groupCategory: null },
    callbackQuery: q, answerCbQuery: answer } as unknown as Context;
}
function group(data: string, actor: number, messageId: number, thread = 7, chat = -100): Context {
  const q: any = { data, from: { id: actor }, id: 'q', message: { message_id: messageId, chat: { id: chat, type: 'supergroup' }, message_thread_id: thread } };
  return { messenger: Messenger.TELEGRAM, chat: q.message.chat, from: q.from, session: { admin: true, groupCategory: null },
    callbackQuery: q, answerCbQuery: answer } as unknown as Context;
}
const shareButton = () => `tc:share:7:v${+new Date(row.updated_at)}`;
const feed = () => send.mock.calls.filter(c => String(c[0]) === '-100');
const notices = () => feed().filter(c => String(c[2]).includes('Заявка возвращена в общие'));
const db = () => jest.requireMock('../src/db');

beforeEach(() => {
  jest.clearAllMocks(); resetRenderStateForTests(); nextMessageId = 100;
  send.mockImplementation(async () => String(nextMessageId++));
  latest.mockResolvedValue({ text: SECRET, timestamp: new Date('2026-11-10T09:00:00Z') });
});

describe('return to common from the private card', () => {
  it('ticket with an old card: the card is edited in place and one fresh record goes to the support topic', async () => {
    row = personal();
    await handleCallback(dm(shareButton()));
    expect(edit).toHaveBeenCalledWith('-100', 55, expect.stringContaining('Заявка #7'), expect.anything());
    expect(notices()).toHaveLength(1);
    const [chat, messenger, text, extra] = notices()[0];
    expect([chat, messenger]).toEqual(['-100', 'telegram']);
    expect(text).toContain('Заявка № 7');
    expect(extra.disable_notification).toBe(false);
    expect(extra.message_thread_id).toBeUndefined(); // the Telegram addon routes the staff chat to its configured topic
    expect(extra.reply_markup.inline_keyboard).toEqual([[{ text: 'Открыть заявку', callback_data: 'tc:open:7:n' }]]);
    expect(row.common_return_notice).toMatchObject({ state: 'sent', via: 'notice', message_id: 100, prior_card: 55 });
    // Canonical card, number, owner and audit stay; no message to the client.
    expect(row).toMatchObject({ ticketId: 7, assigned_to: '42', common_visible: true, staff_card_message_id: 55 });
    expect(db().recordAnalyticsEventBestEffort).toHaveBeenCalledWith('ticket.visibility_changed', 7, '42', { common: true, owner: '42' });
    expect(send.mock.calls.map(c => String(c[0]))).not.toContain('client-700');
    expect(JSON.stringify(notices())).not.toContain(SECRET);
    expect(JSON.stringify(notices())).not.toContain('Иванов');
  });

  it('ticket without a card: the newly created common card is itself the record, no second message', async () => {
    row = personal({ staff_card_chat_id: null, staff_card_message_id: null, staff_card_thread_id: null });
    await handleCallback(dm(shareButton()));
    expect(feed()).toHaveLength(1);
    expect(feed()[0][2]).toContain('Заявка #7');
    expect(db().bindStaffCard).toHaveBeenCalledWith(7, expect.any(String), '-100', 100, 7);
    expect(row.common_return_notice).toMatchObject({ state: 'sent', via: 'card', message_id: 100 });
  });

  it('a replayed update or double tap posts nothing more', async () => {
    row = personal();
    const button = shareButton();
    await handleCallback(dm(button));
    await handleCallback(dm(button));
    await publishCommonReturn(7);
    await recoverCommonReturns();
    expect(notices()).toHaveLength(1);
    expect(db().recordAnalyticsEventBestEffort).toHaveBeenCalledTimes(1);
  });

  it('a stale private button is refused without a record', async () => {
    row = personal();
    await handleCallback(dm('tc:share:7:v1'));
    expect(answer).toHaveBeenCalledWith('Кнопка устарела. Обновите личную карточку.', true);
    expect(feed()).toHaveLength(0);
  });

  it('a second legitimate return after a new take posts a second record', async () => {
    row = personal();
    await handleCallback(dm(shareButton()));
    await handleCallback(group('tc:take:7', 43, 55));
    expect(row).toMatchObject({ assigned_to: '43', common_visible: false });
    await handleCallback(dm(shareButton(), 43));
    expect(notices()).toHaveLength(2);
    expect(row.common_return_notice).toMatchObject({ state: 'sent', via: 'notice' });
  });
});

describe('delivery failure and recovery', () => {
  it('retries a Telegram rejection through the workflow recovery exactly once', async () => {
    row = personal();
    send.mockRejectedValueOnce({ error_code: 429, description: 'Too Many Requests' });
    await handleCallback(dm(shareButton()));
    expect(row.common_return_notice).toMatchObject({ state: 'pending', attempts: 1 });
    await recoverCommonReturns();
    await recoverCommonReturns();
    expect(notices()).toHaveLength(2); // one rejected attempt, one delivered
    expect(row.common_return_notice).toMatchObject({ state: 'sent', via: 'notice' });
  });

  it('never marks or repeats an ambiguous network failure', async () => {
    row = personal();
    send.mockRejectedValueOnce(new Error('socket hang up'));
    await handleCallback(dm(shareButton()));
    await recoverCommonReturns();
    expect(notices()).toHaveLength(1);
    expect(row.common_return_notice.state).toBe('unknown');
  });

  it('settles an abandoned claim as unknown instead of resending', async () => {
    row = personal();
    await db().setTicketCommonVisibility(7, true, '42');
    Object.assign(row.common_return_notice, { state: 'sending', claimed_at: new Date(Date.now() - 120_000) });
    await recoverCommonReturns();
    expect(feed()).toHaveLength(0);
    expect(row.common_return_notice.state).toBe('unknown');
  });

  it('stops after bounded Telegram rejections', async () => {
    row = personal();
    send.mockRejectedValue({ error_code: 400, description: 'Bad Request: message thread not found' });
    await handleCallback(dm(shareButton()));
    for (let i = 0; i < 6; i += 1) await recoverCommonReturns();
    expect(notices()).toHaveLength(5);
    expect(row.common_return_notice).toMatchObject({ state: 'failed', attempts: 5 });
  });

  it('a recovered card creation is the record when the first card send failed', async () => {
    row = personal({ staff_card_chat_id: null, staff_card_message_id: null, staff_card_thread_id: null });
    send.mockRejectedValueOnce({ error_code: 502, description: 'Bad Gateway' })
      .mockRejectedValueOnce({ error_code: 502, description: 'Bad Gateway' });
    await handleCallback(dm(shareButton()));
    expect(row.common_return_notice).toMatchObject({ state: 'pending', attempts: 1 });
    await recoverCommonReturns();
    expect(row.staff_card_message_id).toBe(100);
    expect(row.common_return_notice).toMatchObject({ state: 'sent', via: 'card', message_id: 100 });
  });

  it('does not publish a return that was taken back before delivery', async () => {
    row = personal();
    await db().setTicketCommonVisibility(7, true, '42');
    Object.assign(row, { assigned_to: '43', common_visible: false });
    await recoverCommonReturns();
    expect(notices()).toHaveLength(0);
    expect(row.common_return_notice.state).toBe('superseded');
  });
});

describe('the second engineer opens the record', () => {
  it('opens the same ticket from the support topic without overwriting the record or revealing pre-return content', async () => {
    row = personal();
    await handleCallback(dm(shareButton()));
    send.mockClear(); edit.mockClear();
    await handleCallback(group('tc:open:7:n', 43, 100));
    expect(edit).not.toHaveBeenCalledWith(-100, 100, expect.anything(), expect.anything());
    const panel = feed().at(-1)!;
    expect(panel[2]).toContain('Заявка #7');
    expect(panel[2]).not.toContain(SECRET);
    expect(panel[3].message_thread_id).toBe(7);
    expect(JSON.stringify(panel[3].reply_markup)).toContain('/55?thread=7');
  });

  it('a stale record for a ticket that became personal again opens nothing for another engineer', async () => {
    row = personal();
    await handleCallback(dm(shareButton()));
    Object.assign(row, { assigned_to: '42', common_visible: false });
    send.mockClear(); edit.mockClear();
    await handleCallback(group('tc:open:7:n', 43, 100));
    expect(answer).toHaveBeenCalledWith(expect.stringContaining('недоступна'), true);
    expect(send).not.toHaveBeenCalled(); expect(edit).not.toHaveBeenCalled();
  });

  it('refuses the record button from another chat or topic', async () => {
    row = personal();
    await handleCallback(dm(shareButton()));
    send.mockClear();
    await handleCallback(group('tc:open:7:n', 43, 100, 8));
    await handleCallback(group('tc:open:7:n', 43, 100, 7, -999));
    expect(answer).toHaveBeenCalledWith('Недоступно вне рабочей группы/темы.', true);
    expect(send).not.toHaveBeenCalled();
  });
});
