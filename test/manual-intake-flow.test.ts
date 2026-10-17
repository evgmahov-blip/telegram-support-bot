const answer = jest.fn().mockResolvedValue(undefined);
const reply = jest.fn().mockResolvedValue(undefined);
const refresh = jest.fn().mockResolvedValue(undefined);
const drafts = new Map<string, any>();
const tickets = new Map<string, any>();
const OPEN = ['source', 'input', 'form', 'preview'];
const live = (d: any) => +new Date(d.expires_at) > Date.now();
const fakeDb: any = {
  MANUAL_SOURCES: ['phone', 'email', 'in_person', 'other'],
  startManualDraft: jest.fn(async (token, actor, chat, thread, expires_at) => {
    for (const d of drafts.values()) if (d.actor_id === actor && OPEN.includes(d.status)) d.status = 'cancelled';
    const d = { token, actor_id: actor, chat_id: chat, thread_id: thread, expires_at, status: 'source', step: null,
      version: 0, client: null, description: null, contact: null, confirm_nonce: null, ticketId: null };
    drafts.set(token, d); return { ...d };
  }),
  getManualDraft: jest.fn(async t => drafts.get(t) ? { ...drafts.get(t) } : null),
  findActiveManualDraft: jest.fn(async (actor, chat, thread) => {
    const d = [...drafts.values()].find(x => x.actor_id === actor && x.chat_id === chat && x.thread_id === thread && x.status === 'input' && live(x));
    return d ? { ...d } : null;
  }),
  transitionManualDraft: jest.fn(async (t, actor, version, expected, set, expires_at) => {
    const d = drafts.get(t);
    if (!d || d.actor_id !== actor || d.version !== version || !live(d)
      || Object.entries(expected).some(([k,v]) => d[k] !== v)) return null;
    Object.assign(d, set, { expires_at, version: version + 1 }); return { ...d };
  }),
  consumeManualDraftInput: jest.fn(async (t, actor, chat, thread, version, step, messageId, value, next, expires_at) => {
    const d = drafts.get(t);
    if (!d || d.actor_id !== actor || d.chat_id !== chat || d.thread_id !== thread || d.version !== version
      || d.status !== 'input' || d.step !== step || !live(d) || d.last_consumed_message_id === messageId) return null;
    d[step] = value; Object.assign(d, { step: next, status: next ? 'input' : 'preview', version: version + 1,
      last_consumed_message_id: messageId, confirm_nonce: null, expires_at }); return { ...d };
  }),
  cancelManualDraft: jest.fn(async (t, actor) => { const d = drafts.get(t); if (!d || d.actor_id !== actor || !OPEN.includes(d.status)) return null; d.status = 'cancelled'; return { ...d }; }),
  cancelActiveManualDraft: jest.fn(async (actor, chat, thread) => { for (const d of drafts.values()) if (d.actor_id === actor && d.chat_id === chat && d.thread_id === thread && OPEN.includes(d.status)) d.status = 'cancelled'; }),
  claimManualDraftConfirm: jest.fn(async (t, actor, nonce) => { const d = drafts.get(t); if (!d || d.actor_id !== actor || d.confirm_nonce !== nonce || !((d.status === 'preview' && live(d)) || d.status === 'creating')) return null; d.status = 'creating'; return { ...d }; }),
  completeManualDraft: jest.fn(async (t, ticketId) => { Object.assign(drafts.get(t), { status: 'created', ticketId }); }),
  createManualTicket: jest.fn(async (key, input) => { if (!tickets.has(key)) tickets.set(key, { ticketId: 101, ...input }); return { ticket: tickets.get(key), created: tickets.size === 1 }; }),
  findManualDraftByPrompt: jest.fn().mockResolvedValue(null),
};

jest.mock('../src/db', () => fakeDb);
jest.mock('../src/middleware', () => ({ reply }));
jest.mock('../src/ticket-ui', () => ({ answer, refreshStaffCard: refresh, STAFF_HOME: { text: '🏠 Главная', callback_data: 'tm:home:0' }, e: (x: any) => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;') }));
jest.mock('../src/cache', () => ({ __esModule: true, default: { config: { staffchat_id: '-100', staffchat_thread_id: 7 } } }));
jest.mock('../src/team', () => ({ getStaffRole: (id: string) => ['42','43'].includes(id) ? 'agent' : null, canPerformAction: (id: string) => ['42','43'].includes(id) }));

import { startDraft, handleDraftCallback, handleTextInput, cancelActiveForHome, handleFormReply } from '../src/manual-intake';

const cb = (data = '', actor = 42, chat = -100, thread = 7): any => ({ from: { id: actor }, chat: { id: chat }, session: { admin: chat === -100 },
  callbackQuery: { data, message: { chat: { id: chat }, message_thread_id: thread } }, answerCbQuery: jest.fn() });
const msg = (text: string, id: number, actor = 42, chat = -100, thread = 7, replyTo?: number): any => ({ from: { id: actor }, chat: { id: chat }, session: { admin: chat === -100 },
  message: { text, message_id: id, message_thread_id: thread, ...(replyTo ? { reply_to_message: { message_id: replyTo } } : {}) } });
const callbacks = () => (answer.mock.calls.at(-1)?.[2] || []).flat().map((b: any) => b.callback_data).filter(Boolean);
const current = (t: string) => drafts.get(t);

async function start(actor = 42) {
  const c = cb('', actor); await startDraft(c); const t = fakeDb.startManualDraft.mock.calls.at(-1)[0];
  await handleDraftCallback(cb('', actor), ['mi','s',t,'0','phone']); return t;
}
async function preview(skip = false) {
  const t = await start(); await handleTextInput(msg('Вася <АО>', 10));
  await handleTextInput(msg('Ошибка 500\nс утра', 11));
  if (skip) await handleDraftCallback(cb(), ['mi','skip',t,String(current(t).version)]);
  else await handleTextInput(msg('+7 900', 12));
  return t;
}

beforeEach(() => { jest.clearAllMocks(); drafts.clear(); tickets.clear(); });

it('walks through ordinary text without Reply, escapes preview, and creates only on explicit confirm', async () => {
  const t = await preview();
  expect(current(t)).toMatchObject({ client: 'Вася <АО>', description: 'Ошибка 500\nс утра', contact: '+7 900', status: 'preview' });
  expect(answer.mock.calls.at(-1)[1]).toContain('Вася &lt;АО>');
  expect(callbacks()).toEqual(expect.arrayContaining([`mi:ok:${t}:${current(t).version}`, `mi:edit:${t}:${current(t).version}`]));
  expect(fakeDb.createManualTicket).not.toHaveBeenCalled();
  await handleDraftCallback(cb(), ['mi','ok',t,String(current(t).version)]);
  expect(fakeDb.createManualTicket).toHaveBeenCalledTimes(1);
});

it('supports optional contact, back preserving values, and field edit returning to preview', async () => {
  const t = await preview(true); expect(current(t).contact).toBeNull();
  await handleDraftCallback(cb(), ['mi','b',t,String(current(t).version)]);
  expect(current(t)).toMatchObject({ step: 'contact', client: 'Вася <АО>', description: 'Ошибка 500\nс утра' });
  await handleTextInput(msg('mail@example.test', 20));
  await handleDraftCallback(cb(), ['mi','edit',t,String(current(t).version)]);
  await handleDraftCallback(cb(), ['mi','f',t,String(current(t).version),'client']);
  await handleTextInput(msg('АРСО', 21));
  expect(current(t)).toMatchObject({ client: 'АРСО', status: 'preview' });
});

it('deduplicates text and rejects stale callbacks without skipping two steps', async () => {
  const t = await start(); const d = { ...current(t) };
  await Promise.all([handleTextInput(msg('Вася', 30)), handleTextInput(msg('Вася', 30))]);
  expect(current(t).step).toBe('description'); expect(current(t).version).toBe(d.version + 1);
  await handleDraftCallback(cb(), ['mi','b',t,String(d.version)]);
  expect(current(t).step).toBe('description');
});

it('isolates actor/chat/topic and never captures commands or replies', async () => {
  const t = await start();
  await expect(handleTextInput(msg('чужой', 40, 43))).resolves.toBe(false);
  await expect(handleTextInput(msg('другая тема', 41, 42, -100, 8))).resolves.toBe(false);
  await expect(handleTextInput(msg('/take', 42))).resolves.toBe(false);
  await expect(handleTextInput(msg('ответ тикету', 43, 42, -100, 7, 900))).resolves.toBe(false);
  expect(current(t).client).toBeNull();
});

it('keeps invalid input, survives restart state, and stops capture after cancel/home/expiry', async () => {
  const t = await start(); await handleTextInput(msg('x'.repeat(201), 50));
  expect(current(t).step).toBe('client'); expect(reply.mock.calls.at(-1)[1]).toContain('200');
  await handleTextInput(msg('Вася', 51)); expect((await fakeDb.findActiveManualDraft('42','-100',7)).step).toBe('description');
  await cancelActiveForHome(cb()); expect(await handleTextInput(msg('не захватить', 52))).toBe(false);
  const t2 = await start(); current(t2).expires_at = new Date(Date.now() - 1);
  expect(await handleTextInput(msg('не захватить', 53))).toBe(false);
});

it('keeps two engineers independent and a repeated confirm idempotent', async () => {
  const a = await preview(); const b = await start(43);
  await handleTextInput(msg('Пётр', 60, 43)); expect(current(a).client).toBe('Вася <АО>'); expect(current(b).client).toBe('Пётр');
  const v = current(a).version; await handleDraftCallback(cb(), ['mi','ok',a,String(v)]); await handleDraftCallback(cb(), ['mi','ok',a,String(v)]);
  expect(tickets.size).toBe(1);
});

it.each(['phone', 'email', 'in_person', 'other'])('accepts source %s and opens the client step', async source => {
  const c = cb(); await startDraft(c); const t = fakeDb.startManualDraft.mock.calls.at(-1)[0];
  await handleDraftCallback(c, ['mi','s',t,'0',source]);
  expect(current(t)).toMatchObject({ source, status: 'input', step: 'client', version: 1 });
});

it.each([
  ['single-line control cleanup', '  А\u0007РСО   отдел  ', 'АРСО отдел'],
  ['multiline description cleanup', ' строка 1\u0000\nстрока 2 ', 'строка 1\nстрока 2'],
])('%s', async (_name, input, expected) => {
  const t = await start();
  if (_name.startsWith('multiline')) await handleTextInput(msg('Клиент', 70));
  await handleTextInput(msg(input, 71));
  expect(current(t)[_name.startsWith('multiline') ? 'description' : 'client']).toBe(expected);
});

it.each([
  ['source', ['mi','s','TOKEN','9','phone']],
  ['skip', ['mi','skip','TOKEN','9']],
  ['edit', ['mi','edit','TOKEN','9']],
])('rejects stale %s callback', async (_name, parts) => {
  const t = await start(); const before = { ...current(t) }; parts[2] = t;
  await handleDraftCallback(cb(), parts);
  expect(current(t)).toMatchObject(before);
});

it.each([
  ['private chat', 42, 700, 0],
  ['other group', 42, -999, 7],
  ['unknown actor', 99, -100, 7],
])('does not capture text on %s', async (_name, actor, chat, thread) => {
  await start(); expect(await handleTextInput(msg('текст', 80, actor, chat, thread))).toBe(false);
});

it('rejects a historical ForceReply prompt with a migration hint', async () => {
  fakeDb.findManualDraftByPrompt.mockResolvedValueOnce({ token: 'old' });
  const c = msg('старая форма', 90, 42, -100, 7, 500);
  expect(await handleFormReply(c, 500)).toBe(true);
  expect(reply.mock.calls.at(-1)[1]).toContain('пошаговый ввод');
});

it('cancel prevents subsequent plain text capture', async () => {
  const t = await start(); await handleDraftCallback(cb(), ['mi','x',t,String(current(t).version)]);
  expect(current(t).status).toBe('cancelled'); expect(await handleTextInput(msg('нет', 91))).toBe(false);
});

it('a new start invalidates only the same engineer previous draft', async () => {
  const old = await start(); const other = await start(43); await startDraft(cb('', 42));
  expect(current(old).status).toBe('cancelled'); expect(current(other).status).toBe('input');
});
