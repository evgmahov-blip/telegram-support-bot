// Manual external tickets (staff Home → «Создать заявку вручную») and staff display names on staff surfaces.
const reply = jest.fn().mockResolvedValue(undefined);
let nextMessageId = 500;
const send = jest.fn(async () => String(++nextMessageId));
const answer = jest.fn().mockResolvedValue(undefined);
const edit = jest.fn().mockResolvedValue(undefined);
const timeline = jest.fn().mockResolvedValue([]);

// In-memory stand-in with the same CAS semantics as the Mongo queries in src/db.ts.
const drafts = new Map<string, any>();
const tickets = new Map<number, any>();
const OPEN = ['source', 'form', 'preview'];
const live = (d: any) => +new Date(d.expires_at) > Date.now();
const fakeDb: any = {
  MANUAL_SOURCES: ['phone', 'email', 'in_person', 'other'],
  startManualDraft: jest.fn(async (token, actor, chat, thread, expires) => {
    for (const d of drafts.values()) if (d.actor_id === actor && OPEN.includes(d.status)) d.status = 'cancelled';
    const d = { token, actor_id: actor, chat_id: chat, thread_id: thread, status: 'source', expires_at: expires,
      prompt_message_id: null, confirm_nonce: null, ticketId: null };
    drafts.set(token, d); return { ...d };
  }),
  getManualDraft: jest.fn(async (t) => drafts.has(t) ? { ...drafts.get(t) } : null),
  findManualDraftByPrompt: jest.fn(async (chat, id) => {
    const d = [...drafts.values()].find(x => x.chat_id === chat && x.prompt_message_id === id); return d ? { ...d } : null;
  }),
  bindManualDraftPrompt: jest.fn(async (t, actor, source, prompt, expires) => {
    const d = drafts.get(t);
    if (!d || d.actor_id !== actor || !['source', 'form'].includes(d.status) || !live(d)) return null;
    Object.assign(d, { source, prompt_message_id: prompt, status: 'form', confirm_nonce: null, expires_at: expires }); return { ...d };
  }),
  submitManualDraftForm: jest.fn(async (t, actor, prompt, fields, nonce, expires) => {
    const d = drafts.get(t);
    if (!d || d.actor_id !== actor || d.prompt_message_id !== prompt || !['form', 'preview'].includes(d.status) || !live(d)) return null;
    Object.assign(d, fields, { status: 'preview', confirm_nonce: nonce, expires_at: expires }); return { ...d };
  }),
  claimManualDraftConfirm: jest.fn(async (t, actor, nonce) => {
    const d = drafts.get(t);
    if (!d || d.actor_id !== actor || d.confirm_nonce !== nonce) return null;
    if (!((d.status === 'preview' && live(d)) || d.status === 'creating')) return null;
    d.status = 'creating'; return { ...d };
  }),
  completeManualDraft: jest.fn(async (t, ticketId) => { const d = drafts.get(t); if (d?.status === 'creating') Object.assign(d, { status: 'created', ticketId }); }),
  cancelManualDraft: jest.fn(async (t, actor) => {
    const d = drafts.get(t); if (!d || d.actor_id !== actor || !OPEN.includes(d.status)) return null;
    d.status = 'cancelled'; return { ...d };
  }),
  createManualTicket: jest.fn(async (key, input) => {
    const existing = [...tickets.values()].find(t => t.manual_request_key === key);
    if (existing) return { ticket: existing, created: false };
    const ticketId = 100 + tickets.size + 1;
    const t = { ticketId, userid: `MANUAL:${key}-uuid`, messenger: 'manual', status: 'open', assigned_to: null, priority: 'normal',
      category: null, manual_source: input.source, external_client: input.client, external_contact: input.contact,
      created_by: input.createdBy, manual_request_key: key, staff_card_chat_id: null, staff_card_message_id: null, staff_card_thread_id: null,
      created_at: new Date(), updated_at: new Date() };
    tickets.set(ticketId, t); return { ticket: t, created: true };
  }),
  getTicketById: jest.fn(async (id) => tickets.get(Number(id)) ?? null),
  getTicketByInternalId: jest.fn(async () => null),
  getLatestTicketMessage: jest.fn(async () => ({ text: 'описание' })),
  getTicketTimelinePage: timeline,
  claimStaffCard: jest.fn(async (id) => tickets.get(id)),
  bindStaffCard: jest.fn(async (id, _claim, chat, message, thread) => {
    const t = tickets.get(id); Object.assign(t, { staff_card_chat_id: chat, staff_card_message_id: message, staff_card_thread_id: thread }); return t;
  }),
  releaseStaffCardClaim: jest.fn(), clearStaffCardBinding: jest.fn(),
  setPendingTicketAction: jest.fn(async (id) => tickets.get(id)), consumePendingTicketAction: jest.fn(),
  setReplyPrompt: jest.fn(async (id) => tickets.get(id)), clearReplyPrompt: jest.fn(),
  recordAnalyticsEventBestEffort: jest.fn(), listStaffTickets: jest.fn().mockResolvedValue([]),
  listUserTickets: jest.fn().mockResolvedValue([]), addNewTicket: jest.fn(), requestNewTicket: jest.fn(),
};

jest.mock('../src/middleware', () => ({ reply, sendMessage: send, strictEscape: (v: string) => v }));
jest.mock('../src/db', () => fakeDb);
jest.mock('../src/ticket-audit', () => ({ getTicketAuditHistory: jest.fn().mockResolvedValue([]) }));
jest.mock('../src/ticket-state', () => ({ transitionTicketStateFrom: jest.fn(), closeTicketLifecycle: jest.fn() }));
jest.mock('../src/ticket-ownership', () => ({ takeTicket: jest.fn(), transferTicket: jest.fn() }));
jest.mock('../src/addons/telegram', () => ({ __esModule: true, default: { getInstance: () => ({ editMessage: edit }) } }));
jest.mock('../src/cache', () => ({ __esModule: true, default: { config: {
  staffchat_id: '-100', staffchat_type: 'telegram', staffchat_thread_id: 7, language: { helpCommandText: 'help' },
}, staffMembers: new Map<string, any>([
  ['42', { telegram_id: '42', name: 'Анна <b>Петрова</b>', role: 'agent' }],
  ['43', { telegram_id: '43', name: 'Пётр', role: 'supervisor' }],
  ['44', { telegram_id: '44', role: 'agent' }],
]) } }));

import { handleCallback, refreshStaffCard } from '../src/ticket-ui';
import { handleFormReply, parseManualForm } from '../src/manual-intake';
import { Context, Messenger } from '../src/interfaces';

function cb(data: string, { chat = -100, thread = 7, messageId = 900, actor = 42 } = {}): Context {
  const callbackQuery: any = { data, from: { id: actor }, id: 'q',
    message: { message_id: messageId, chat: { id: chat, type: chat > 0 ? 'private' : 'supergroup' }, message_thread_id: thread } };
  return { update_id: 1, messenger: Messenger.TELEGRAM, chat: callbackQuery.message.chat, from: callbackQuery.from,
    session: { admin: chat === -100 }, callbackQuery, answerCbQuery: answer } as unknown as Context;
}
function msg(promptId: number, text: string, { chat = -100, thread = 7, actor = 42 } = {}): Context {
  return { update_id: 2, messenger: Messenger.TELEGRAM, chat: { id: chat, type: chat > 0 ? 'private' : 'supergroup' },
    from: { id: actor }, session: { admin: chat === -100 },
    message: { message_id: 700, text, message_thread_id: thread, reply_to_message: { message_id: promptId, text: 'prompt' } },
  } as unknown as Context;
}
const FORM = 'Клиент: ООО <Ромашка>\nКонтакт: +7 900 000-00-00\nОписание: Не работает выгрузка\nс утра ошибка 500';
const buttons = (markup: any) => (markup?.inline_keyboard || []).flat().map((b: any) => b.callback_data).filter(Boolean);
const lastPanelButtons = () => buttons(edit.mock.calls.at(-1)?.[3]?.reply_markup);

async function startAndChoose(actor = 42) {
  await handleCallback(cb('tm:manual:0', { actor }));
  const token = fakeDb.startManualDraft.mock.calls.at(-1)[0];
  await handleCallback(cb(`mi:s:${token}:phone`, { actor }));
  const promptId = Number(await send.mock.results.at(-1)!.value);
  return { token, promptId };
}
async function toPreview(actor = 42) {
  const { token, promptId } = await startAndChoose(actor);
  await handleFormReply(msg(promptId, FORM, { actor }), promptId);
  const okData = buttons(reply.mock.calls.at(-1)[2].reply_markup).find((d: string) => d.startsWith('mi:ok:'));
  return { token, promptId, okData };
}

beforeEach(() => { jest.clearAllMocks(); drafts.clear(); tickets.clear(); });

describe('manual intake happy path', () => {
  it('offers the Russian Home button and creates no ticket while only buttons are tapped', async () => {
    await handleCallback(cb('tm:home:0'));
    expect(JSON.stringify(edit.mock.calls.at(-1)[3])).toContain('Создать заявку вручную');
    await handleCallback(cb('tm:manual:0'));
    await handleCallback(cb('tm:manual:0'));
    const token = fakeDb.startManualDraft.mock.calls.at(-1)[0];
    expect(token).toMatch(/^[0-9a-f]{16}$/);
    expect(lastPanelButtons()).toEqual([`mi:s:${token}:phone`, `mi:s:${token}:email`, `mi:s:${token}:in_person`,
      `mi:s:${token}:other`, `mi:x:${token}`, 'tm:home:0']);
    expect(fakeDb.createManualTicket).not.toHaveBeenCalled(); expect(tickets.size).toBe(0);
  });

  it('source → one selective ForceReply in the topic → preview → explicit Create → real canonical card', async () => {
    const { token, promptId } = await startAndChoose();
    const [chatId, , promptText, promptOpts] = send.mock.calls.at(-1) as any[];
    expect(chatId).toBe('-100');
    expect(promptText).toContain('tg://user?id=42');
    expect(promptText).toContain('Анна &lt;b&gt;Петрова&lt;/b&gt;');
    expect(promptText).toMatch(/Клиент:.*\nКонтакт:.*\nОписание:/);
    expect(promptOpts).toEqual(expect.objectContaining({ reply_markup: { force_reply: true, selective: true }, message_thread_id: 7 }));
    expect(lastPanelButtons()).toEqual([`mi:x:${token}`, 'tm:home:0']);

    await expect(handleFormReply(msg(promptId, FORM), promptId)).resolves.toBe(true);
    const [, preview, previewOpts] = reply.mock.calls.at(-1);
    expect(preview).toContain('Источник: Телефон');
    expect(preview).toContain('Клиент: ООО &lt;Ромашка&gt;');
    expect(preview).toContain('Не работает выгрузка\nс утра ошибка 500');
    expect(preview).toContain('Клиенту ничего не отправляется');
    const okData = buttons(previewOpts.reply_markup).find((d: string) => d.startsWith('mi:ok:'));
    expect(buttons(previewOpts.reply_markup)).toEqual([okData, `mi:x:${token}`, 'tm:home:0']);
    expect(tickets.size).toBe(0);

    send.mockClear();
    await handleCallback(cb(okData));
    expect(fakeDb.createManualTicket).toHaveBeenCalledTimes(1);
    expect(fakeDb.createManualTicket).toHaveBeenCalledWith(token, { source: 'phone', client: 'ООО <Ромашка>',
      contact: '+7 900 000-00-00', description: 'Не работает выгрузка\nс утра ошибка 500', createdBy: '42' });
    const ticket = [...tickets.values()][0];
    expect(ticket.userid).toMatch(/^MANUAL:/);
    expect(ticket.staff_card_message_id).toBeTruthy();
    const [cardChat, , card, cardOpts] = send.mock.calls[0] as any[];
    expect(cardChat).toBe('-100');
    expect(card).toContain('Ручная заявка · источник: Телефон');
    expect(card).toContain('Клиент: ООО &lt;Ромашка&gt;');
    expect(card).toContain('Контакт: +7 900 000-00-00');
    expect(card).toContain('Создал: Анна &lt;b&gt;Петрова&lt;/b&gt;');
    expect(card).not.toContain('MANUAL:');
    expect(JSON.stringify(cardOpts.reply_markup)).toContain('Записать ответ');
    expect(JSON.stringify(cardOpts.reply_markup)).not.toContain('✍️ Ответить');
    expect(answer).toHaveBeenLastCalledWith('Готово.');
  });

  it('a duplicate Create returns the same ticket and creates nothing new', async () => {
    const { okData } = await toPreview();
    await handleCallback(cb(okData)); await handleCallback(cb(okData));
    expect(fakeDb.createManualTicket).toHaveBeenCalledTimes(1);
    expect(tickets.size).toBe(1);
    expect(answer).toHaveBeenLastCalledWith(expect.stringContaining('уже создана'), true);
  });

  it('a crash after the confirm claim is retried into exactly one ticket', async () => {
    const { token, okData } = await toPreview();
    fakeDb.completeManualDraft.mockRejectedValueOnce(new Error('mongo down'));
    await expect(handleCallback(cb(okData))).rejects.toThrow('mongo down');
    expect(drafts.get(token).status).toBe('creating');
    await handleCallback(cb(okData));
    expect(fakeDb.createManualTicket).toHaveBeenCalledTimes(2);
    expect(tickets.size).toBe(1);
    expect(drafts.get(token).status).toBe('created');
  });

  it('accepts a corrected answer to the same prompt and invalidates the previous preview', async () => {
    const { promptId, okData } = await toPreview();
    await handleFormReply(msg(promptId, 'Клиент: Иван\nОписание: другое'), promptId);
    await handleCallback(cb(okData));
    expect(answer).toHaveBeenLastCalledWith(expect.stringContaining('устарело'), true);
    expect(tickets.size).toBe(0);
  });
});

describe('manual intake fails safely', () => {
  it.each([
    ['the wrong chat', { chat: -999 }],
    ['the wrong topic', { thread: 8 }],
    ['a private chat', { chat: 700, thread: 0, actor: 700 }],
    ['an unregistered member of the staff group', { actor: 99 }],
  ])('rejects Home → create from %s', async (_name, where) => {
    await handleCallback(cb('tm:manual:0', where));
    expect(fakeDb.startManualDraft).not.toHaveBeenCalled();
    expect(answer).toHaveBeenCalledWith(expect.any(String), true);
  });

  it('rejects draft buttons from another engineer, chat or topic without side effects', async () => {
    await handleCallback(cb('tm:manual:0'));
    const token = fakeDb.startManualDraft.mock.calls[0][0];
    send.mockClear();
    await handleCallback(cb(`mi:s:${token}:phone`, { actor: 43 }));
    await handleCallback(cb(`mi:s:${token}:phone`, { thread: 8 }));
    await handleCallback(cb(`mi:s:${token}:phone`, { chat: 700, thread: 0, actor: 42 }));
    await handleCallback(cb(`mi:x:${token}`, { actor: 43 }));
    expect(send).not.toHaveBeenCalled(); expect(drafts.get(token).status).toBe('source');
  });

  it('never captures ordinary group chat, another engineer, another topic or a private message', async () => {
    const { token, promptId } = await startAndChoose();
    await expect(handleFormReply(msg(promptId + 50, FORM), promptId + 50)).resolves.toBe(false);
    await expect(handleFormReply(msg(promptId, FORM, { chat: 700, thread: 0 }), promptId)).resolves.toBe(false);
    await expect(handleFormReply(msg(promptId, FORM, { actor: 43 }), promptId)).resolves.toBe(true);
    expect(reply).toHaveBeenLastCalledWith(expect.anything(), expect.stringContaining('другому сотруднику'));
    await expect(handleFormReply(msg(promptId, FORM, { thread: 8 }), promptId)).resolves.toBe(true);
    expect(fakeDb.submitManualDraftForm).not.toHaveBeenCalled();
    expect(drafts.get(token).status).toBe('form');
  });

  it('rejects empty required fields and oversized input, keeping the prompt usable', async () => {
    const { token, promptId } = await startAndChoose();
    await handleFormReply(msg(promptId, 'Клиент: \nКонтакт: x\nОписание:   '), promptId);
    expect(reply).toHaveBeenLastCalledWith(expect.anything(), expect.stringContaining('«Клиент» и «Описание»'));
    await handleFormReply(msg(promptId, `Клиент: A\nОписание: ${'x'.repeat(3001)}`), promptId);
    expect(reply).toHaveBeenLastCalledWith(expect.anything(), expect.stringContaining('3000'));
    expect(drafts.get(token).status).toBe('form');
    await handleFormReply(msg(promptId, FORM), promptId);
    expect(drafts.get(token).status).toBe('preview');
  });

  it('expires a draft: neither the form nor Create works after 15 minutes', async () => {
    const { token, promptId, okData } = await toPreview();
    drafts.get(token).expires_at = new Date(Date.now() - 1);
    await handleFormReply(msg(promptId, FORM), promptId);
    expect(reply).toHaveBeenLastCalledWith(expect.anything(), expect.stringContaining('устарел'));
    await handleCallback(cb(okData));
    expect(fakeDb.createManualTicket).not.toHaveBeenCalled();
  });

  it('Cancel ends the draft and its stale Create button creates nothing', async () => {
    const { token, okData } = await toPreview();
    await handleCallback(cb(`mi:x:${token}`));
    expect(drafts.get(token).status).toBe('cancelled');
    expect(edit).toHaveBeenCalledWith('-100', expect.any(Number), 'Создание ручной заявки отменено.');
    expect(lastPanelButtons()).toEqual(['tm:home:0']);
    await handleCallback(cb(okData)); await handleCallback(cb(`mi:x:${token}`));
    expect(fakeDb.createManualTicket).not.toHaveBeenCalled();
  });

  it('restarting from Home invalidates the previous draft, prompt and preview', async () => {
    const first = await toPreview();
    await handleCallback(cb('tm:manual:0'));
    await handleCallback(cb(first.okData));
    await handleCallback(cb(`mi:s:${first.token}:email`));
    await handleFormReply(msg(first.promptId, FORM), first.promptId);
    expect(fakeDb.createManualTicket).not.toHaveBeenCalled();
    expect(drafts.get(first.token).status).toBe('cancelled');
  });

  it('a Create forged by another engineer is refused', async () => {
    const { okData } = await toPreview();
    await handleCallback(cb(okData, { actor: 43 }));
    expect(fakeDb.createManualTicket).not.toHaveBeenCalled();
  });
});

describe('parseManualForm', () => {
  it('accepts organization label aliases, optional contact and strips control characters', () => {
    expect(parseManualForm('Клиент / организация: ACME\u0007\nописание: one\ntwo')).toEqual({
      fields: { client: 'ACME', contact: null, description: 'one\ntwo' } });
    expect(parseManualForm('просто текст').error).toContain('«Клиент» и «Описание»');
  });
});

describe('staff display names', () => {
  const base = { ticketId: 7, userid: '700', messenger: 'telegram', status: 'open', priority: 'normal', category: null,
    staff_card_chat_id: '-100', staff_card_message_id: 55, staff_card_thread_id: 7,
    created_at: new Date('2026-01-01T10:00:00Z'), updated_at: new Date('2026-01-01T10:00:00Z') };
  // Fixed timestamps keep rendered dates free of digits that could look like staff IDs.
  const at = new Date('2026-01-01T10:00:00Z');

  it('renders configured names (escaped) instead of Telegram IDs on the card, with a safe departed fallback', async () => {
    tickets.set(7, { ...base, assigned_to: '42' });
    await refreshStaffCard(7);
    expect(edit.mock.calls.at(-1)[2]).toContain('Инженер: Анна &lt;b&gt;Петрова&lt;/b&gt;');
    tickets.set(7, { ...base, assigned_to: '31337' });
    await refreshStaffCard(7);
    expect(edit.mock.calls.at(-1)[2]).toContain('Инженер: Сотрудник вне списка');
    expect(edit.mock.calls.at(-1)[2]).not.toContain('31337');
  });

  it('lists transfer targets by name, using the role when no name is configured', async () => {
    tickets.set(7, { ...base, assigned_to: '42' });
    await handleCallback(cb('tc:transfer:7', { messageId: 55 }));
    const call = [...edit.mock.calls, ...reply.mock.calls.map(c => [null, null, c[1], c[2]])]
      .find(c => String(c[2]).includes('Кому передать'));
    const labels = call[3].reply_markup.inline_keyboard.flat().map((b: any) => b.text);
    expect(labels).toEqual(expect.arrayContaining(['Анна <b>Петрова</b>', 'Пётр', 'Инженер']));
    expect(labels).not.toContain('44');
  });

  it('names staff authors in staff history but keeps the client history anonymous', async () => {
    tickets.set(7, { ...base, assigned_to: '42' });
    const rows = [
      { at, kind: 'staff', actor: '42', text: 'ответ' },
      { at, kind: 'note', actor: '43', text: 'заметка' },
      { at, kind: 'event', actor: '43', text: 'ticket.transferred', metadata: { owner: '42' } },
      { at, kind: 'event', actor: '31337', text: 'ticket.taken', metadata: { owner: '31337' } },
    ];
    timeline.mockResolvedValueOnce(rows);
    await handleCallback(cb('tc:h:7:0'));
    const staffView = String(edit.mock.calls.at(-1)[2]);
    expect(staffView).toContain('Поддержка · Анна &lt;b&gt;Петрова&lt;/b&gt;: ответ');
    expect(staffView).toContain('🔒 Заметка (Пётр)');
    expect(staffView).toContain('Событие · Пётр: Тикет передан · владелец Анна');
    expect(staffView).toContain('Сотрудник вне списка');
    expect(staffView).not.toMatch(/\b(42|43|31337)\b/);

    timeline.mockResolvedValueOnce([rows[0], rows[2]]);
    const client = cb('uc:h:7:0', { chat: 700, thread: 0, actor: 700 });
    await handleCallback(client);
    const clientView = String(edit.mock.calls.at(-1)[2]);
    expect(clientView).toContain('Поддержка: ответ');
    expect(clientView).not.toContain('Анна'); expect(clientView).not.toContain('Пётр');
    expect(clientView).not.toMatch(/\b(42|43)\b/);
  });

  it('labels manual history as recorded work and shows the manual creation audit', async () => {
    tickets.set(9, { ...base, ticketId: 9, userid: 'MANUAL:x', messenger: 'manual', assigned_to: '42' });
    timeline.mockResolvedValueOnce([
      { at, kind: 'event', actor: '42', text: 'ticket.created', metadata: { source: 'manual' } },
      { at, kind: 'user', actor: 'MANUAL:x', text: 'исходное описание' },
      { at, kind: 'staff', actor: '42', text: 'перезвонил клиенту' },
    ]);
    await handleCallback(cb('tc:h:9:0'));
    const view = String(edit.mock.calls.at(-1)[2]);
    expect(view).toContain('Заявка создана вручную');
    expect(view).toContain('Обращение (записано вручную): исходное описание');
    expect(view).toContain('Записанный ответ · Анна');
    expect(view).not.toContain('MANUAL:');
  });

  it('never lets a client open a manual ticket', async () => {
    tickets.set(9, { ...base, ticketId: 9, userid: 'MANUAL:x', messenger: 'manual' });
    await handleCallback(cb('uc:open:9', { chat: 700, thread: 0, actor: 700 }));
    expect(answer).toHaveBeenCalledWith('Обращение недоступно.', true);
  });

  it('labels the manual reply prompt as recording, never as sending to the client', async () => {
    tickets.set(9, { ...base, ticketId: 9, userid: 'MANUAL:x', messenger: 'manual', assigned_to: '42', staff_card_message_id: 56 });
    await handleCallback(cb('tc:reply:9', { messageId: 56 }));
    const prompt = String(send.mock.calls.at(-1)[2]);
    expect(prompt).toContain('запишите ответ/результат');
    expect(prompt).toContain('клиенту ничего не отправляется');
    expect(String(reply.mock.calls.at(-1)?.[1] ?? edit.mock.calls.at(-1)?.[2])).toContain('Ожидаю запись ответа');
  });
});
