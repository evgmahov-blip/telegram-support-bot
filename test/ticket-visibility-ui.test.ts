// Engineers A (42) and B (43) plus supervisor S (50): own/common visibility on every staff read path.
const reply = jest.fn().mockResolvedValue(undefined);
const send = jest.fn().mockResolvedValue('88');
const getTicket = jest.fn();
const answer = jest.fn().mockResolvedValue(undefined);
const edit = jest.fn().mockResolvedValue(undefined);
const timeline = jest.fn().mockResolvedValue([{ at: new Date(), kind: 'user', actor: 'client', text: 'Пароль от роутера 12345' }]);
const latest = jest.fn().mockResolvedValue({ text: 'Пароль от роутера 12345' });

jest.mock('../src/middleware', () => ({ reply, sendMessage: send }));
jest.mock('../src/db', () => ({
  getTicketById: getTicket, getTicketByInternalId: jest.fn().mockResolvedValue(null), listUserTickets: jest.fn(),
  countStaffTickets: jest.fn().mockResolvedValue(null), listStaffTickets: jest.fn().mockResolvedValue([]), getLatestTicketMessage: latest, getTicketTimelinePage: timeline,
  getTicketResolution: jest.fn().mockResolvedValue(null), setTicketCommonVisibility: jest.fn(),
  claimStaffCard: jest.fn(), releaseStaffCardClaim: jest.fn(), bindStaffCard: jest.fn(), clearStaffCardBinding: jest.fn(),
  setPendingTicketAction: jest.fn(), consumePendingTicketAction: jest.fn(), clearPendingTicketAction: jest.fn(),
  recordAnalyticsEventBestEffort: jest.fn(), setReplyPrompt: jest.fn(),
}));
jest.mock('../src/ticket-audit', () => ({ getTicketAuditHistory: jest.fn().mockResolvedValue([]) }));
jest.mock('../src/ticket-state', () => ({ transitionTicketStateFrom: jest.fn(), closeTicketLifecycle: jest.fn() }));
jest.mock('../src/ticket-ownership', () => ({ takeTicket: jest.fn(), transferTicket: jest.fn() }));
jest.mock('../src/ticket-resolution-case', () => ({ startClose: jest.fn(), cancelForHome: jest.fn(), handleCallback: jest.fn().mockResolvedValue(true) }));
jest.mock('../src/addons/telegram', () => ({ __esModule: true, default: { getInstance: () => ({ editMessage: edit }) } }));
jest.mock('../src/cache', () => ({ __esModule: true, default: { config: {
  staffchat_id: '-100', staffchat_type: 'telegram', staffchat_thread_id: 7, language: { helpCommandText: 'help' },
}, staffMembers: new Map([
  ['42', { telegram_id: '42', name: 'Анна', role: 'agent' }],
  ['43', { telegram_id: '43', name: 'Борис', role: 'agent' }],
  ['50', { telegram_id: '50', name: 'Сергей', role: 'supervisor' }],
]) } }));

import { handleCallback, resetRenderStateForTests } from '../src/ticket-ui';
import { canViewTicket, isCommonTicket, listScope } from '../src/ticket-visibility';
import { Context, Messenger } from '../src/interfaces';

const personalA: any = { ticketId: 7, userid: 'client', messenger: 'telegram', status: 'open', assigned_to: '42', name: 'Клиент Иванов',
  category: null, priority: 'normal', staff_card_chat_id: '-100', staff_card_message_id: 55, staff_card_thread_id: 7 };
const closedA: any = { ...personalA, status: 'closed' };
const common: any = { ...personalA, assigned_to: null };
const shared: any = { ...personalA, common_visible: true };

function group(data: string, actor = 42, messageId = 55): Context {
  const q: any = { data, from: { id: actor }, id: 'q', message: { message_id: messageId, chat: { id: -100, type: 'supergroup' }, message_thread_id: 7 } };
  return { messenger: Messenger.TELEGRAM, chat: q.message.chat, from: q.from, session: { admin: true, groupCategory: null },
    callbackQuery: q, answerCbQuery: answer } as unknown as Context;
}
function dm(data: string, actor = 42): Context {
  const q: any = { data, from: { id: actor }, id: 'q', message: { message_id: 70, chat: { id: actor, type: 'private' } } };
  return { messenger: Messenger.TELEGRAM, chat: q.message.chat, from: q.from, session: { admin: false, groupCategory: null },
    callbackQuery: q, answerCbQuery: answer } as unknown as Context;
}
const db = () => jest.requireMock('../src/db');
const groupRenders = () => edit.mock.calls.filter(c => String(c[0]) === '-100' && c[1] !== 55);
const sharedSends = () => send.mock.calls.filter(c => String(c[0]) === '-100');

describe('visibility rules', () => {
  it('agents see own and common tickets; supervisors see all; unknown users see nothing', () => {
    expect(canViewTicket('42', personalA)).toBe(true);
    expect(canViewTicket('43', personalA)).toBe(false);
    expect(canViewTicket('43', closedA)).toBe(false);
    expect(canViewTicket('43', common)).toBe(true);
    expect(canViewTicket('43', shared)).toBe(true);
    expect(canViewTicket('50', personalA)).toBe(true);
    expect(canViewTicket('999', common)).toBe(false);
    expect(isCommonTicket(personalA)).toBe(false);
    expect(listScope('42', true)).toBe('common');
    expect(listScope('42', false)).toBe('visible');
    expect(listScope('50', false)).toBe('all');
  });
});

describe('staff read paths enforce visibility', () => {
  beforeEach(() => { jest.clearAllMocks(); resetRenderStateForTests(); getTicket.mockResolvedValue(personalA); send.mockResolvedValue('88'); });

  it.each([['tc:open:7'], ['tc:h:7:0']])('denies engineer B %s on A\'s personal ticket before any render', async (data) => {
    await handleCallback(group(data, 43, 900));
    expect(answer).toHaveBeenCalledWith(expect.stringContaining('недоступна'), true);
    expect(timeline).not.toHaveBeenCalled(); expect(edit).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
  });

  it('denies B on A\'s closed personal ticket too', async () => {
    getTicket.mockResolvedValue(closedA);
    await handleCallback(group('tc:h:7:0', 43, 900));
    expect(timeline).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
  });

  it('opens A\'s personal history only in A\'s DM, never on the shared panel', async () => {
    await handleCallback(group('tc:h:7:0', 42, 900));
    expect(send).toHaveBeenCalledWith('42', 'telegram', expect.stringContaining('Пароль от роутера'), expect.anything());
    expect(groupRenders()).toHaveLength(0); expect(sharedSends()).toHaveLength(0);
    expect(answer).toHaveBeenCalledWith('Открыто в личном чате с ботом.', false);
  });

  it('lets the supervisor read a personal ticket, still only via DM', async () => {
    await handleCallback(group('tc:open:7', 50, 900));
    expect(send).toHaveBeenCalledWith('50', 'telegram', expect.stringContaining('Клиент Иванов'), expect.anything());
    expect(groupRenders()).toHaveLength(0);
  });

  it('does not fall back to the shared chat when the DM is blocked', async () => {
    send.mockRejectedValueOnce({ description: 'Forbidden: bot was blocked by the user' });
    await handleCallback(group('tc:h:7:0', 42, 900));
    expect(answer).toHaveBeenCalledWith(expect.stringContaining('/start'), true);
    expect(groupRenders()).toHaveLength(0); expect(sharedSends()).toHaveLength(0);
  });

  it('renders common tickets in place on the shared panel', async () => {
    getTicket.mockResolvedValue(common);
    await handleCallback(group('tc:h:7:0', 43, 900));
    expect(edit).toHaveBeenCalledWith(-100, 900, expect.stringContaining('История заявки № 7'), expect.anything());
    expect(send).not.toHaveBeenCalled();
  });

  it('renders the DM detail in place on the engineer private surface', async () => {
    await handleCallback(dm('tc:open:7', 42));
    expect(edit).toHaveBeenCalledWith(42, 70, expect.stringContaining('Клиент Иванов'), expect.anything());
    expect(sharedSends()).toHaveLength(0);
  });

  it('keeps the engineer DM read-only and never lets B open A\'s ticket there', async () => {
    await handleCallback(dm('tc:take:7', 42));
    expect(answer).toHaveBeenCalledWith('Это действие выполняется на карточке в рабочей группе.', true);
    await handleCallback(dm('tc:open:7', 43));
    expect(answer).toHaveBeenCalledWith(expect.stringContaining('недоступна'), true);
    expect(edit).not.toHaveBeenCalled();
  });

  it('rejects a DM surface for someone who is not registered staff', async () => {
    await handleCallback(dm('tm:mine:0', 777));
    expect(answer).toHaveBeenCalledWith('Недоступно вне рабочей группы/темы.', true);
    expect(db().listStaffTickets).not.toHaveBeenCalled();
  });
});

describe('lists', () => {
  beforeEach(() => { jest.clearAllMocks(); resetRenderStateForTests(); send.mockResolvedValue('88'); });

  it('shared «Общие» lists only common tickets in place', async () => {
    await handleCallback(group('tm:common:0', 43, 900));
    expect(db().listStaffTickets).toHaveBeenCalledWith('common', '43', 0, 7, 6, 'common');
    expect(send).not.toHaveBeenCalled();
  });

  it('«Мои заявки» from the shared chat is delivered to the DM with own+common scope', async () => {
    db().listStaffTickets.mockResolvedValueOnce([personalA]);
    await handleCallback(group('tm:mine:0', 42, 900));
    expect(db().listStaffTickets).toHaveBeenCalledWith('mine', '42', 0, 7, 6, 'visible');
    expect(send).toHaveBeenCalledWith('42', 'telegram', expect.stringContaining('Заявки'), expect.anything());
    expect(groupRenders()).toHaveLength(0);
  });

  it('closed lists keep the same scope: agents visible, supervisors all', async () => {
    await handleCallback(dm('tm:closed:0', 43));
    expect(db().listStaffTickets).toHaveBeenLastCalledWith('closed', '43', 0, 7, 6, 'visible');
    await handleCallback(dm('tm:closed:0', 50));
    expect(db().listStaffTickets).toHaveBeenLastCalledWith('closed', '50', 0, 7, 6, 'all');
  });
});

describe('explicit common visibility', () => {
  beforeEach(() => { jest.clearAllMocks(); resetRenderStateForTests(); getTicket.mockResolvedValue(personalA); });

  it('owner shares a personal ticket with an owner-guarded, audited change', async () => {
    db().setTicketCommonVisibility.mockResolvedValueOnce(shared);
    await handleCallback(group('tc:share:7', 42));
    expect(db().setTicketCommonVisibility).toHaveBeenCalledWith(7, true, '42');
    expect(db().recordAnalyticsEventBestEffort).toHaveBeenCalledWith('ticket.visibility_changed', 7, '42', { common: true, owner: '42' });
  });

  it('another agent cannot change it and a stale card button is refused', async () => {
    await handleCallback(group('tc:share:7', 43));
    expect(answer).toHaveBeenCalledWith(expect.stringContaining('Видимость меняет'), true);
    await handleCallback(group('tc:share:7', 42, 54));
    expect(answer).toHaveBeenCalledWith('Кнопка устарела. Откройте актуальную карточку.', true);
    expect(db().setTicketCommonVisibility).not.toHaveBeenCalled();
  });

  it('a lost CAS (owner changed meanwhile) records nothing', async () => {
    db().setTicketCommonVisibility.mockResolvedValueOnce(null);
    await handleCallback(group('tc:unshare:7', 50));
    expect(db().recordAnalyticsEventBestEffort).not.toHaveBeenCalled();
    expect(answer).toHaveBeenCalledWith('Владелец или видимость заявки изменились.', true);
  });
});

describe('private dashboard and Rich HTML opt-in', () => {
  const cache = () => jest.requireMock('../src/cache').default;
  beforeEach(() => {
    jest.clearAllMocks(); resetRenderStateForTests(); getTicket.mockResolvedValue(personalA);
    cache().config.telegram_rich_ui = true;
    latest.mockResolvedValue({text:'<script>alert(1)</script>😀'});
    db().listStaffTickets.mockResolvedValue([]);
  });
  afterEach(() => { cache().config.telegram_rich_ui = false; latest.mockResolvedValue({text:'Пароль от роутера 12345'}); });
  it('projects the private card with escaped data and the same authorized navigation', async () => {
    getTicket.mockResolvedValue({...personalA,staff_card_chat_id:'-100123'});
    await handleCallback(dm('tc:open:7'));
    const call = edit.mock.calls.find(c=>c[0]===42);
    expect(call[3].most_rich_html).toContain('<h3>Заявка #7</h3>');
    expect(call[3].most_rich_html).toContain('&lt;script&gt;');
    expect(call[3].most_rich_html).not.toContain('<script>');
    expect(call[3].most_rich_html).toContain('data="tc:h:7:0"');
  });
  it('denies a foreign or revoked actor before fetching the message preview', async () => {
    await handleCallback(dm('tc:open:7',43));
    expect(latest).not.toHaveBeenCalled(); expect(edit).not.toHaveBeenCalled();
    const staff=cache().staffMembers.get('42'); staff.active=false;
    try { await handleCallback(dm('tm:home:0')); expect(db().listStaffTickets).not.toHaveBeenCalled(); }
    finally { delete staff.active; }
  });
  it('shows a six-row home and a separate offered queue with matching count scope', async () => {
    db().countStaffTickets.mockResolvedValue(8);
    db().listStaffTickets.mockResolvedValue(Array.from({length:7},(_,i)=>({...personalA,ticketId:i+1})));
    await handleCallback(dm('tm:home:0'));
    expect(db().listStaffTickets).toHaveBeenCalledWith('mine','42',0,7,6,'visible');
    expect(db().countStaffTickets).toHaveBeenCalledWith('offered','42','visible');
    const call=edit.mock.calls.find(c=>c[0]===42);
    expect(call[3].most_rich_html).toContain('Ожидают принятия (8)');
    expect(call[3].reply_markup.inline_keyboard.flat().filter((b:any)=>b.callback_data?.startsWith('tc:open:'))).toHaveLength(6);
    await handleCallback(dm('tm:offered:1'));
    expect(db().listStaffTickets).toHaveBeenLastCalledWith('offered','42',1,7,6,'visible');
    db().countStaffTickets.mockResolvedValue(null);
  });
  it('does not add personal dashboard counters or rich payload to the group', async () => {
    await handleCallback(group('tm:home:0',42,900));
    expect(edit.mock.calls[0][3]).not.toHaveProperty('most_rich_html');
    expect(db().listStaffTickets).not.toHaveBeenCalled();
  });
  it('renders the saved offer deadline but no acceptance timer after taken or restart', async () => {
    const {cardText}=require('../src/ticket-ui');
    const offered={...personalA,assigned_to:null,routing:{state:'offered',offered_to:'42',version:2,
      deadline_at:new Date('2026-11-08T10:00:00Z'),policy:{acceptance_minutes:10,schedule:{timezone:'Europe/Moscow'}}}};
    const text=await cardText(offered,'42');
    expect(text).toContain('Ожидает принятия'); expect(text).toContain('Europe/Moscow'); expect(text).toContain('10 рабочих минут');
    resetRenderStateForTests();
    const accepted=await cardText({...offered,assigned_to:'42',routing:{...offered.routing,state:'accepted'}},'42');
    expect(accepted).not.toContain('принять до'); expect(accepted).not.toContain('10 рабочих минут');
  });
  it('rejects malformed pagination without touching records', async () => {
    await handleCallback(dm('tm:mine:-1')); await handleCallback(dm('tm:mine:NaN'));
    expect(db().listStaffTickets).not.toHaveBeenCalled();
  });
});

it('rechecks a concurrent common-to-personal change before projecting into a group', async () => {
  jest.clearAllMocks(); resetRenderStateForTests();
  getTicket.mockResolvedValueOnce(common).mockResolvedValue(personalA);
  await handleCallback(group('tc:open:7',43,900));
  expect(answer).toHaveBeenCalledWith('Заявка больше недоступна.',true);
  expect(latest).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
});
