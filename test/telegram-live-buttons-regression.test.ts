// Real grammY handleUpdate -> permissions -> registered handlers -> inline/UI ->
// Telegram addon. Only persistence and the Bot API transport are synthetic.
jest.unmock('grammy');
const clone = (v: any) => v == null ? v : structuredClone(v);
let row: any;
const drafts = new Map<string, any>();
const tickets = new Map<string, any>();
const OPEN = ['source', 'input', 'form', 'preview'];
const live = (d: any) => +new Date(d.expires_at) > Date.now();
const fakeDb: any = {
  MANUAL_SOURCES: ['phone', 'email', 'in_person', 'other'],
  startManualDraft: jest.fn(async (token, actor, chat, thread, expires_at) => {
    for (const d of drafts.values()) if (d.actor_id === actor && OPEN.includes(d.status)) d.status = 'cancelled';
    const d = { client_after_contact: true, token, actor_id: actor, chat_id: chat, thread_id: thread, expires_at, status: 'source', step: null,
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
      || d.status !== 'input' || d.step !== step || !live(d) || (d.last_consumed_message_id != null && d.last_consumed_message_id >= messageId)) return null;
    d[step] = value; Object.assign(d, { step: next, status: next ? 'input' : 'preview', version: version + 1,
      last_consumed_message_id: messageId, confirm_nonce: next ? null : String(version + 1), edit_return: false, expires_at }); return { ...d };
  }),
  cancelManualDraft: jest.fn(async (t, actor, version) => { const d = drafts.get(t); if (!d || d.actor_id !== actor || (version !== undefined && version !== d.version) || !OPEN.includes(d.status)) return null; d.status = 'cancelled'; return { ...d }; }),
  cancelActiveManualDraft: jest.fn(async (actor, chat, thread) => { for (const d of drafts.values()) if (d.actor_id === actor && d.chat_id === chat && d.thread_id === thread && OPEN.includes(d.status)) d.status = 'cancelled'; }),
  claimManualDraftConfirm: jest.fn(async (t, actor, nonce) => { const d = drafts.get(t); if (!d || d.actor_id !== actor || d.confirm_nonce !== nonce || !((d.status === 'preview' && live(d)) || d.status === 'creating')) return null; d.status = 'creating'; return { ...d }; }),
  completeManualDraft: jest.fn(async (t, ticketId) => { Object.assign(drafts.get(t), { status: 'created', ticketId }); }),
  createManualTicket: jest.fn(async (key, input) => { if (!tickets.has(key)) tickets.set(key, { ticketId: 101, userid: 'MANUAL:synthetic', messenger: 'telegram', status: 'open', assigned_to: null, updated_at: new Date('2026-11-14'), manual_source: input.source, external_client: input.client, linked_client_id: input.linkedClientId, ...input }); return { ticket: tickets.get(key), created: tickets.size === 1 }; }),
  findManualDraftByPrompt: jest.fn().mockResolvedValue(null),
};

Object.assign(fakeDb, {
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
});
jest.mock('../src/db', () => ({ ...jest.requireActual('../src/db'), ...fakeDb }));
jest.mock('../src/cache', () => ({ __esModule: true, default: {
  config: { owner_id: 'synthetic', staffchat_id: '-100', staffchat_type: 'telegram', staffchat_thread_id: 7,
    parse_mode: 'HTML', categories: [], start_keyboard: [], user_commands: [], pass_start: true,
    language: { helpCommandText: 'help', back: 'Back', services: 'Services', faqCommandText: 'FAQ', links: 'Links' } },
  staffMembers: new Map([
    ['42', { telegram_id: '42', name: 'Agent A', role: 'agent' }],
    ['43', { telegram_id: '43', name: 'Agent B', role: 'agent' }],
    ['50', { telegram_id: '50', name: 'Supervisor', role: 'supervisor' }],
    ['60', { telegram_id: '60', name: 'Admin', role: 'admin' }],
  ]), mutedTickets: new Set(),
} }));
jest.mock('@grammyjs/transformer-throttler', () => ({ apiThrottler: () => (prev: any, method: any, payload: any, signal: any) => prev(method, payload, signal) }));
jest.mock('../src/telegram-update-dedup', () => ({
  claimTelegramUpdate: jest.fn(async (id: number) => String(id)), completeTelegramUpdate: jest.fn(), releaseTelegramUpdate: jest.fn(),
}));

import { Bot } from 'grammy';
import cache from '../src/cache';
const db: typeof import('../src/db') = require('../src/db');
import TelegramAddon from '../src/addons/telegram';
import { resetRenderStateForTests } from '../src/ticket-ui';

const profileId = '0123456789abcdef01234567';
const profile = { _id: profileId, messenger: 'telegram', userid: '99', organization: 'Synthetic Client' };
const info: any = { id: 123, is_bot: true, first_name: 'Synthetic', username: 'synthetic_bot' };
const calls: Array<{ method: string; payload: any }> = [];
let addon: TelegramAddon;
let updateId = 1;
let messageId = 100;
let rows: any[] = [];
let changeOnRead: any = null;

// Evaluate the production list/count filters over synthetic stored documents.
function matches(doc: any, filter: any): boolean {
  return Object.entries(filter).every(([key, value]: any) => {
    if (key === '$and') return value.every((f: any) => matches(doc, f));
    if (key === '$or') return value.some((f: any) => matches(doc, f));
    const actual = key.split('.').reduce((obj: any, k: string) => obj?.[k], doc);
    if (value && typeof value === 'object' && !(value instanceof Date)) {
      if ('$ne' in value) return actual !== value.$ne;
      if ('$in' in value) return value.$in.includes(actual);
    }
    return value === null ? actual == null : +new Date(actual) === +new Date(value) || actual === value;
  });
}
function query(result: any[]) {
  let offset = 0, limit = result.length;
  const q: any = { sort: () => q, skip: (n: number) => { offset = n; return q; },
    limit: (n: number) => { limit = n; return q; },
    lean: async () => clone(result.slice(offset, offset + limit)),
    then: (resolve: any, reject: any) => Promise.resolve(result.map(x => db.Supportee.hydrate(x))).then(resolve, reject) };
  return q;
}
const personal = () => ({ ticketId: 7, userid: '99', messenger: 'telegram', status: 'open', assigned_to: '42',
  name: 'Synthetic Client', updated_at: new Date('2026-11-14'),
  staff_card_chat_id: '-100', staff_card_message_id: 55, staff_card_thread_id: 7 });

beforeAll(() => {
  jest.spyOn(Bot.prototype, 'init').mockImplementation(async function(this: any) { this.botInfo = info; });
  jest.spyOn(Bot.prototype, 'start').mockResolvedValue(undefined);
  addon = TelegramAddon.getInstance('123:synthetic-no-network');
  addon.bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload: clone(payload) });
    return { ok: true, result: method === 'answerCallbackQuery' ? true :
      { message_id: messageId++, date: 1, chat: { id: Number((payload as any).chat_id), type: 'private' }, ...payload } } as any;
  });
  addon.start();
  jest.spyOn(db, 'checkBan').mockResolvedValue(null);
  jest.spyOn(db, 'getTicketById').mockImplementation(async (id: number) => {
    const stored = rows.find(t => t.ticketId === id) || [...tickets.values()].find(t => t.ticketId === id);
    return stored ? db.Supportee.hydrate({ ...stored, ...(changeOnRead || {}) }) : null;
  });
  jest.spyOn(db, 'getTicketByInternalId').mockImplementation(async (id: number) => row?.staff_card_message_id === id ? db.Supportee.hydrate(row) : null);
  jest.spyOn(db.Supportee, 'find').mockImplementation((filter: any) => query(rows.filter(t => matches(t, filter))) as any);
  jest.spyOn(db.Supportee, 'countDocuments').mockImplementation((filter: any) => Promise.resolve(rows.filter(t => matches(t, filter)).length) as any);
  jest.spyOn(db.ClientProfile, 'findById').mockImplementation((id: any) => Promise.resolve(String(id) === profileId ? profile : null) as any);
  jest.spyOn(db.ClientProfile, 'find').mockImplementation(() => query([profile]) as any);
  jest.spyOn(db.Supportee, 'findOneAndUpdate').mockImplementation((filter: any, update: any) => {
    const t = rows.find(t => matches(t, filter));
    if (!t) return Promise.resolve(null) as any;
    Object.assign(t, update.$set); return Promise.resolve(db.Supportee.hydrate(t)) as any;
  });
  jest.spyOn(db, 'getLatestTicketMessage').mockResolvedValue(null);
  jest.spyOn(db, 'getTicketResolution').mockResolvedValue(null);
  jest.spyOn(db, 'recordAnalyticsEventBestEffort').mockResolvedValue(undefined);
  // Empty unrelated input workflows: the real staff text handler still dispatches the wizard.
  for (const name of ['findResolutionIntent', 'findStaffNameEdit', 'findActiveReplyCompose', 'findReplyComposeByPrompt', 'clearExpiredReplyComposes', 'cancelActiveReplyCompose', 'cancelStaffNameEdit', 'cancelResolutionIntent', 'findAnyActiveManualDraft', 'findEngineerInput'] as const) {
    if (typeof (db as any)[name] === 'function') jest.spyOn(db as any, name).mockResolvedValue(null);
  }
});
beforeEach(() => {
  calls.length = 0; drafts.clear(); tickets.clear(); resetRenderStateForTests();
  row = personal(); rows = [row]; changeOnRead = null;
});

async function click(data: string, actor = 42, chat = actor, thread?: number, id = 70) {
  const n = updateId++;
  await addon.bot.handleUpdate({ update_id: n, callback_query: { id: String(n), from: { id: actor, is_bot: false, first_name: 'Synthetic' },
    chat_instance: 'synthetic', data, message: { message_id: id, date: 1,
      chat: { id: chat, type: chat < 0 ? 'supergroup' : 'private', first_name: 'Synthetic', title: 'Synthetic' },
      ...(thread ? { message_thread_id: thread, is_topic_message: true } : {}) } } } as any);
}
async function text(value: string) {
  const n = updateId++;
  await addon.bot.handleUpdate({ update_id: n, message: { message_id: n, date: 1,
    from: { id: 42, is_bot: false, first_name: 'Synthetic' }, chat: { id: 42, type: 'private', first_name: 'Synthetic' }, text: value } });
}
const renders = () => calls.filter(c => ['sendMessage', 'sendRichMessage', 'editMessageText'].includes(c.method));
const rendered = () => JSON.stringify(renders());
function button(prefix: string): string {
  const payload: any = renders().at(-1)?.payload;
  const classic = payload?.reply_markup?.inline_keyboard.flat().find((b: any) => b.callback_data?.startsWith(prefix));
  if (classic) return classic.callback_data;
  const html = payload?.rich_message?.html || '';
  const data = [...html.matchAll(/data="([^"]+)"/g)].map(m => m[1]).find(v => v.startsWith(prefix));
  expect(data).toBeDefined(); return data!;
}

// The same callback data is exercised through both classic and Rich rendering.
describe.each([false, true])('Telegram registered update routes, rich=%s', rich => {
  beforeEach(() => { cache.config.telegram_rich_ui = rich; });

  it.each([42, 43, 50, 60])('keeps legacy rows and dashboard counters consistent for actor %s', async actor => {
    rows = [personal(), { ...personal(), ticketId: 8, assigned_to: '43' },
      { ...personal(), ticketId: 9, assigned_to: null },
      { ...personal(), ticketId: 10, assigned_to: '43', status: 'closed' }];
    for (const view of ['mine', 'common', 'active', 'closed']) {
      calls.length = 0;
      await click(`tm:${view}:0`, actor);
      const scope = actor >= 50 ? 'all' : 'visible';
      const expected = await db.countStaffTickets(view as any, String(actor), scope);
      const payload: any = renders().at(-1)?.payload;
      const body = JSON.stringify(payload);
      const ids = rich ? [...(payload?.rich_message?.html || '').matchAll(/data="tc:open:(\d+)"/g)]
        : payload?.reply_markup?.inline_keyboard.flat().filter((b: any) => b.callback_data?.startsWith('tc:open:'));
      expect(ids).toHaveLength(expected);
      expect(body).toContain(`Мои в работе (${actor === 43 ? 1 : actor === 42 ? 1 : 0})`);
      expect(body).toContain('Общие (1)');
      expect(body.includes('Заявок нет')).toBe(expected === 0);
    }
  });

  it('keeps refreshed counts and rows aligned after ownership, version, visibility and status changes', async () => {
    const changes = [
      { assigned_to: '43' }, { pending_reply_version: 1 },
      { common_visible: true, common_visible_since: new Date('2026-11-14T10:00:00Z') },
      { common_visible: false, common_visible_since: null }, { status: 'closed' },
    ];
    for (const changed of changes) {
      Object.assign(row, changed);
      for (const actor of [42, 43, 50, 60]) {
        const scope = actor >= 50 ? 'all' : 'visible';
        for (const view of ['mine', 'common', 'active', 'closed'] as const) {
          calls.length = 0;
          await click(`tm:${view}:0`, actor);
          const payload: any = renders().at(-1)?.payload;
          const body = JSON.stringify(payload);
          expect(body.includes('tc:open:7')).toBe(await db.countStaffTickets(view, String(actor), scope) === 1);
          expect(body).toContain(`Мои в работе (${await db.countStaffTickets('mine', String(actor), scope)})`);
          expect(body).toContain(`Общие (${await db.countStaffTickets('common', String(actor), scope)})`);
        }
      }
    }
  });

  it.each([
    { assigned_to: '43' }, { pending_reply_version: 1 }, { common_visible: true },
    { common_visible_since: new Date('2026-11-14T10:00:00Z') },
    { routing: { state: 'offered', version: 1, offered_to: '43' } },
  ])('does not render a row changed after the list read: %j', async changed => {
    changeOnRead = changed;
    await click('tm:mine:0');
    expect(rendered()).not.toContain('tc:open:7');
  });

  it('runs home, refresh, common, active and closed navigation using actual rendered buttons', async () => {
    await click('tm:home:0');
    expect(rendered()).toContain('tc:open:7');
    expect(rendered()).not.toContain('cfg:home');
    await click(button('tm:mine:0')); // refresh
    await click(button('tm:common:0'));
    expect(rendered()).toContain('Общие');
    await click(button('tm:active:0'));
    await click(button('tm:closed:0'));
    await click(button('tm:home:0'));
    expect(renders().at(-1)?.payload).toBeDefined();
    expect(JSON.stringify(renders().at(-1))).toContain('tc:open:7');
  });

  it.each(['phone', 'email', 'in_person', 'other'])('creates %s intake with and without a linked client only after confirmation', async source => {
    for (const linked of [false, true]) {
      await click('tm:home:0');
      await click(button('tm:manual:0'));
      const d: any = [...drafts.values()].at(-1);
      await click(button(`mi:s:${d.token}:0:${source}`));
      await text('Synthetic description');
      await click(button('mi:skip:'));
      if (linked) {
        await click(button('mi:clients:'));
        await click(button('mi:pick:'));
        expect(d.linked_client_id).toBeUndefined();
        await click(button('mi:selected:'));
      } else await click(button('mi:none:'));
      const confirm = button('mi:ok:');
      expect(d.status).toBe('preview');
      expect(d.ticketId).toBeNull();
      await click(confirm);
      expect(d.status).toBe('created');
      expect(d.linked_client_id || null).toBe(linked ? profileId : null);
      const count = tickets.size;
      await click(confirm);
      expect(tickets.size).toBe(count);
    }
    expect(calls.filter(c => String(c.payload.chat_id) === '99')).toHaveLength(0);
  });

  it('cancels the wizard and home stops further text capture', async () => {
    await click('tm:manual:0');
    const d: any = [...drafts.values()].at(-1);
    await click(button('mi:x:'));
    expect(d.status).toBe('cancelled');
    await click('tm:manual:0');
    const next: any = [...drafts.values()].at(-1);
    await click(button('tm:home:0'));
    expect(next.status).toBe('cancelled');
    expect(tickets.size).toBe(0);
  });

  it('binds from the personal card with explicit confirmation and refuses another engineer', async () => {
    Object.assign(row, { userid: 'MANUAL:synthetic', manual_source: 'phone', linked_client_id: null });
    // A separate visible ticket makes the real client profile discoverable.
    rows.push({ ...personal(), ticketId: 8 });
    await click('tc:open:7');
    await click(button('cl:list:7:'));
    await click(button('cl:pick:7:'));
    expect(row.linked_client_id).toBeNull();
    const confirm = button('cl:ok:7:');
    await click(confirm, 43);
    expect(row.linked_client_id).toBeNull();
    await click(confirm);
    expect(row.linked_client_id).toBe(profileId);
    expect(calls.filter(c => String(c.payload.chat_id) === '99')).toHaveLength(0);
  });

  it('returns to common exactly once through the actual Telegram transport into the configured topic', async () => {
    await click('tc:open:7');
    const share = button('tc:share:7:');
    await click(share);
    await click(share);
    const notices = calls.filter(c => c.method === 'sendMessage' && String(c.payload.chat_id) === '-100'
      && String(c.payload.text).includes('Заявка возвращена в общие'));
    expect(notices).toHaveLength(1);
    expect(notices[0].payload.message_thread_id).toBe(7);
    expect(row.common_return_notice.state).toBe('sent');
    expect(calls.filter(c => String(c.payload.chat_id) === '99')).toHaveLength(0);
  });

  it('denies an unknown actor, foreign personal ticket and a callback from a different topic', async () => {
    await click('tm:manual:0', 777);
    await click('tc:open:7', 43);
    await click('tm:common:0', 42, -100, 8);
    expect(renders()).toHaveLength(0);
    expect(calls.filter(c => c.method === 'answerCallbackQuery' && c.payload.show_alert)).toHaveLength(3);
    expect(drafts.size).toBe(0);
  });
});
