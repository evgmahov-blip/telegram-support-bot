// Declared client organization: first /start and first request ask before any ticket; edit/cancel; restart.
const reply = jest.fn().mockResolvedValue(undefined);
const addNewTicket = jest.fn().mockResolvedValue(11);
const getTicketByUserId = jest.fn();
const userChat = jest.fn().mockResolvedValue(undefined);
const profiles = new Map<string, any>();
const key = (userid: string, messenger: string) => `${messenger}:${userid}`;

jest.mock('../src/middleware', () => ({ reply: (...a: any[]) => reply(...a), sendMessage: jest.fn() }));
jest.mock('../src/users', () => ({ chat: (...a: any[]) => userChat(...a) }));
jest.mock('../src/staff', () => ({ chat: jest.fn() }));
jest.mock('../src/ticket-resolution-case', () => ({ handleTextInput: jest.fn().mockResolvedValue(false) }));
jest.mock('../src/ticket-state', () => ({ resumeWaitingTicket: jest.fn() }));
jest.mock('../src/cache', () => ({ __esModule: true, default: {
  config: { categories: [], ticket_per_message: false, language: { services: 'Services', banned: 'Banned' } },
  staffMembers: new Map([['42', { telegram_id: '42', name: 'Анна', role: 'agent' }]]),
} }));
jest.mock('../src/db', () => ({
  checkBan: jest.fn().mockResolvedValue(null),
  getTicketByUserId: (...a: any[]) => getTicketByUserId(...a),
  getTicketById: jest.fn(),
  addNewTicket: (...a: any[]) => addNewTicket(...a),
  consumeNewTicketRequest: jest.fn().mockResolvedValue(null),
  recordAnalyticsEvent: jest.fn(),
  // In-memory profile store with the same version fences as the Mongo implementation.
  getClientProfile: jest.fn(async (userid: string, messenger: string) => profiles.get(key(userid, messenger)) ?? null),
  startOrganizationInput: jest.fn(async (userid: string, messenger: string, mode: string, expiresAt: Date | null) => {
    const current = profiles.get(key(userid, messenger)) ?? { userid, messenger, organization: null, org_input_version: 0 };
    const next = { ...current, org_input: mode, org_input_expires_at: expiresAt, org_input_version: current.org_input_version + 1 };
    profiles.set(key(userid, messenger), next); return next;
  }),
  saveOrganization: jest.fn(async (userid: string, messenger: string, version: number, organization: string) => {
    const current = profiles.get(key(userid, messenger));
    if (!current?.org_input || current.org_input_version !== version) return null;
    const next = { ...current, organization, org_input: null, org_input_expires_at: null, org_input_version: version + 1 };
    profiles.set(key(userid, messenger), next); return next;
  }),
  cancelOrganizationInput: jest.fn(async (userid: string, messenger: string, version: number) => {
    const current = profiles.get(key(userid, messenger));
    if (!current?.org_input || current.org_input_version !== version) return null;
    const next = { ...current, org_input: null, org_input_expires_at: null, org_input_version: version + 1 };
    profiles.set(key(userid, messenger), next); return next;
  }),
}));

import * as org from '../src/client-organization';
import * as text from '../src/text';
import { canViewTicket } from '../src/ticket-visibility';
import { Context, Messenger } from '../src/interfaces';

const db: any = jest.requireMock('../src/db');
const cb = jest.fn().mockResolvedValue(undefined);
function client(message?: string, opts: { messenger?: Messenger; chatType?: string; id?: string; admin?: boolean } = {}): Context {
  const id = opts.id ?? '700';
  return {
    messenger: opts.messenger ?? Messenger.TELEGRAM, from: { id, username: 'c' },
    chat: { id, type: opts.chatType ?? 'private' },
    message: message === undefined ? undefined : { text: message, message_id: 1, from: { id, first_name: 'Клиент' }, chat: { id, type: 'private' } },
    session: { admin: opts.admin ?? false, groupCategory: null, group: '' },
    callbackQuery: undefined, answerCbQuery: cb,
  } as unknown as Context;
}
const lastReply = () => String(reply.mock.calls.at(-1)?.[1] ?? '');
const addon: any = { platform: 'telegram' };

describe('organization name validation', () => {
  it.each([
    ['  ООО «Ромашка»  ', 'ООО «Ромашка»'],
    ['ИП\tПетров\nи партнёры', 'ИП Петров и партнёры'],
    ['A1', 'A1'],
  ])('accepts %p as %p', (raw, expected) => expect(org.normalizeOrganization(raw)).toBe(expected));
  it.each([['/start'], ['x'], ['   '], ['!!!'], ['💥💥'], ['я'.repeat(org.ORG_MAX + 1)], [undefined], [{}]])(
    'rejects %p', (raw) => expect(org.normalizeOrganization(raw as unknown)).toBeNull());
});

describe('first start and first request', () => {
  beforeEach(() => { jest.clearAllMocks(); profiles.clear(); getTicketByUserId.mockResolvedValue(null); });

  it('asks on the first private /start and does not ask again once saved', async () => {
    await expect(org.promptIfMissing(client())).resolves.toBe(true);
    expect(lastReply()).toContain('укажите вашу организацию');
    await org.handleTextInput(client('ООО Ромашка'));
    expect(profiles.get('telegram:700').organization).toBe('ООО Ромашка');
    await expect(org.promptIfMissing(client())).resolves.toBe(false);
  });

  it('a first request without organization creates no ticket and asks first', async () => {
    const result = await text.ticketHandler(addon, client('Не работает интернет'));
    expect(result).toBeNull();
    expect(addNewTicket).not.toHaveBeenCalled(); expect(userChat).not.toHaveBeenCalled();
    expect(lastReply()).toContain('Ваше сообщение пока не отправлено');
  });

  it('the next plain text is the organization, never a ticket; then the request snapshots it', async () => {
    await text.ticketHandler(addon, client('Не работает интернет'));
    await text.handleText(addon, client('ООО <Ромашка> & Co'));
    expect(addNewTicket).not.toHaveBeenCalled();
    // Escaped in the HTML confirmation.
    expect(lastReply()).toContain('ООО &lt;Ромашка&gt; &amp; Co');
    getTicketByUserId.mockResolvedValueOnce(null).mockResolvedValueOnce({ ticketId: 11, status: 'open' });
    await text.handleText(addon, client('Не работает интернет'));
    expect(addNewTicket).toHaveBeenCalledWith('700', null, 'telegram', 'ООО <Ромашка> & Co');
  });

  it('a follow-up to an existing active ticket is never blocked by a missing organization', async () => {
    getTicketByUserId.mockResolvedValue({ ticketId: 5, status: 'open', userid: '700' });
    await text.ticketHandler(addon, client('Ещё деталь'));
    expect(userChat).toHaveBeenCalled();
    expect(db.startOrganizationInput).not.toHaveBeenCalled();
  });

  it('commands are never consumed as an organization value', async () => {
    await org.promptIfMissing(client());
    await expect(org.handleTextInput(client('/help'))).resolves.toBe(false);
    expect(profiles.get('telegram:700').organization).toBeNull();
  });

  it('rejects an invalid value and keeps the input armed', async () => {
    await org.promptIfMissing(client());
    await expect(org.handleTextInput(client('!'))).resolves.toBe(true);
    expect(lastReply()).toContain('не сохранено');
    expect(profiles.get('telegram:700').org_input).toBe('first');
  });
});

describe('edit, cancel, restart and scoping', () => {
  beforeEach(() => { jest.clearAllMocks(); profiles.clear(); });

  it('edits, cancels with a fenced button, and rejects a stale cancel', async () => {
    profiles.set('telegram:700', { userid: '700', messenger: 'telegram', organization: 'Старая', org_input: null, org_input_version: 4 });
    await org.handleCallback(client(), ['um', 'orgedit', '0']);
    expect(profiles.get('telegram:700').org_input).toBe('edit');
    const cancelData = JSON.stringify(reply.mock.calls.at(-1)?.[2]);
    expect(cancelData).toContain('um:orgcancel:5');
    await org.handleCallback(client(), ['um', 'orgcancel', '4']);
    expect(cb).toHaveBeenLastCalledWith('Кнопка устарела.', true);
    await org.handleCallback(client(), ['um', 'orgcancel', '5']);
    expect(cb).toHaveBeenLastCalledWith('Изменение отменено.', false);
    expect(profiles.get('telegram:700')).toEqual(expect.objectContaining({ organization: 'Старая', org_input: null }));
    // After cancel, ordinary text is no longer an organization value.
    await expect(org.handleTextInput(client('Новая'))).resolves.toBe(false);
  });

  it('an armed edit survives a process restart and changing it never relabels past tickets', async () => {
    profiles.set('telegram:700', { userid: '700', messenger: 'telegram', organization: 'Старая', org_input: null, org_input_version: 1 });
    await org.handleCallback(client(), ['um', 'orgedit', '0']);
    await jest.isolateModulesAsync(async () => {
      const restarted = jest.requireActual<typeof import('../src/client-organization')>('../src/client-organization');
      await expect(restarted.handleTextInput(client('Новая'))).resolves.toBe(true);
    });
    expect(profiles.get('telegram:700').organization).toBe('Новая');
    expect(lastReply()).toContain('прежние обращения не меняются');
    // Only the profile is written; no ticket is created or relabelled by an edit.
    expect(addNewTicket).not.toHaveBeenCalled();
    expect(Object.keys(db).filter(k => /Ticket|Supportee/.test(k) && db[k].mock?.calls?.length)).toEqual([]);
  });

  it('is scoped by actual platform + user and skipped outside Telegram private chats', async () => {
    profiles.set('telegram:700', { userid: '700', messenger: 'telegram', organization: 'ТГ', org_input: null, org_input_version: 1 });
    await expect(org.currentOrganization(client())).resolves.toBe('ТГ');
    await expect(org.currentOrganization(client(undefined, { messenger: Messenger.SIGNAL }))).resolves.toBeUndefined();
    await expect(org.currentOrganization(client(undefined, { id: '701' }))).resolves.toBeNull();
    await expect(org.requireForNewTicket(client(undefined, { chatType: 'supergroup' }))).resolves.toEqual({ ok: true, organization: undefined });
    expect(db.getClientProfile).toHaveBeenCalledWith('700', 'telegram');
    expect(db.getClientProfile).toHaveBeenCalledWith('701', 'telegram');
  });

  it('a declared organization grants no staff visibility or membership', async () => {
    profiles.set('telegram:700', { userid: '700', messenger: 'telegram', organization: 'MOST', org_input: null, org_input_version: 1 });
    expect(canViewTicket('700', { assigned_to: null } as any)).toBe(false);
    expect(canViewTicket('700', { assigned_to: '42' } as any)).toBe(false);
  });
});
