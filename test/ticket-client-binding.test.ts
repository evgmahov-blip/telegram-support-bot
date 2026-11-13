const profileId = '0123456789abcdef01234567';
const profile = { _id: profileId, messenger: 'telegram', userid: '99', organization: 'Клиент' };
const ticket: any = { ticketId: 7, updated_at: new Date('2026-11-01'), assigned_to: '42', common_visible: false, linked_client_id: null };
let role: string | null = 'agent';
let visible = true;
const findById = jest.fn();
const listProfiles = jest.fn();
const find = jest.fn();
const getTicketById = jest.fn();
const update = jest.fn();
const answer = jest.fn();
const refreshStaffCard = jest.fn();
jest.mock('../src/db', () => ({
  ClientProfile: { findById, find: listProfiles },
  Supportee: { find, findOneAndUpdate: update },
  getTicketById,
}));
jest.mock('../src/team', () => ({
  getStaffRole: () => role,
  canPerformAction: (_actor: string, action: string) => role && (action !== 'manage_team' || role === 'admin'),
  canManageTicket: (actor: string, owner: string) => role === 'admin' || actor === owner,
}));
jest.mock('../src/ticket-visibility', () => ({ canViewTicket: () => !!role && visible, sendToStaffPrivate: jest.fn().mockResolvedValue('88') }));
jest.mock('../src/ticket-ui', () => ({
  staffSurface: (ctx: any) => !!role && ctx.chat.id === -100,
  isStaffPrivate: (ctx: any) => !!role && ctx.chat.type === 'private' && ctx.chat.id === ctx.from.id,
  answer, refreshStaffCard, e: String, STAFF_HOME: { text: 'Главная', callback_data: 'tm:home:0' },
}));
import { accessibleClient, handleCallback, showClients } from '../src/ticket-client-binding';
const ctx = (privateChat = true): any => ({
  from: { id: 42 }, chat: { id: privateChat ? 42 : -100, type: privateChat ? 'private' : 'supergroup' },
  answerCbQuery: jest.fn(),
});
const confirm = () => ['cl', 'ok', '7', String(+ticket.updated_at), profileId];
beforeEach(() => {
  jest.clearAllMocks(); role = 'agent'; visible = true;
  const query: any = { sort: () => query, skip: () => query, limit: () => Promise.resolve([profile]) };
  listProfiles.mockReturnValue(query);
  findById.mockResolvedValue(profile); find.mockResolvedValue([ticket]);
  getTicketById.mockResolvedValue({ ...ticket }); update.mockResolvedValue({ ...ticket, linked_client_id: profileId });
});
it('denies outsiders, inaccessible profiles and shared-chat buttons before disclosure or write', async () => {
  role = null;
  expect(await accessibleClient('42', profileId)).toBeNull();
  expect(findById).not.toHaveBeenCalled();
  role = 'agent'; visible = false;
  expect(await accessibleClient('42', profileId)).toBeNull();
  await handleCallback(ctx(), confirm());
  visible = true; await handleCallback(ctx(false), confirm());
  expect(answer).not.toHaveBeenCalled(); expect(update).not.toHaveBeenCalled();
});
it('requires stable profile id and current ticket version', async () => {
  expect(await accessibleClient('42', 'Клиент')).toBeNull();
  await handleCallback(ctx(), ['cl', 'ok', '7', '0', profileId]);
  expect(update).not.toHaveBeenCalled();
});
it('asks for confirmation before changing a link', async () => {
  await handleCallback(ctx(), ['cl', 'pick', '7', String(+ticket.updated_at), profileId]);
  expect(update).not.toHaveBeenCalled();
  expect(answer.mock.calls[0][2][0][0].callback_data).toBe(confirm().join(':'));
});
it('atomically stores link and author audit without changing transport or ticket number', async () => {
  await handleCallback(ctx(), confirm());
  const [filter, mutation] = update.mock.calls[0];
  expect(filter).toMatchObject({ ticketId: 7, updated_at: ticket.updated_at, linked_client_id: null, assigned_to: '42' });
  expect(mutation.$set).toEqual({ linked_client_id: profileId });
  expect(mutation.$push.client_link_audit).toMatchObject({ actor: '42', from: null, to: profileId });
  expect(refreshStaffCard).toHaveBeenCalledWith(7);
});
it('rejects repeated confirmations and lost ownership', async () => {
  getTicketById.mockResolvedValueOnce({ ...ticket, linked_client_id: profileId });
  await handleCallback(ctx(), confirm());
  getTicketById.mockResolvedValue({ ...ticket, assigned_to: '43' });
  await handleCallback(ctx(), confirm());
  expect(update).not.toHaveBeenCalled();
});
it('rechecks ticket ACL and profile scope immediately before the atomic write', async () => {
  getTicketById.mockResolvedValueOnce(ticket).mockResolvedValueOnce({ ...ticket, assigned_to: '43' });
  await handleCallback(ctx(), confirm());
  expect(update).not.toHaveBeenCalled();
});
it('does not turn ticket binding into organization verification for agents', async () => {
  await handleCallback(ctx(), ['cl', 'org', '7']);
  expect(JSON.stringify(answer.mock.calls)).not.toContain('cfg:bindings');
  expect(update).not.toHaveBeenCalled();
});

it('renders only scoped client choices and never puts the directory in a shared chat', async () => {
  const select = (id: string) => 'selected:' + id, nav = (page: number) => 'page:' + page;
  await showClients(ctx(false), '42', 0, select, nav);
  expect(listProfiles).not.toHaveBeenCalled();
  visible = false;
  await showClients(ctx(), '42', 0, select, nav);
  expect(JSON.stringify(answer.mock.calls)).not.toContain('telegram:99');
  visible = true;
  await showClients(ctx(), '42', 0, select, nav);
  expect(JSON.stringify(answer.mock.calls.at(-1))).toContain('selected:' + profileId);
});

it.each([false, undefined, null, true])('matches stored legacy visibility (%s) without weakening the visibility fence', async commonVisible => {
  getTicketById.mockResolvedValue({ ...ticket, common_visible: commonVisible });
  await handleCallback(ctx(), confirm());
  expect(update.mock.calls[0][0].common_visible).toEqual(commonVisible === true ? true : { $ne: true });
});

it.each([undefined, null])('matches an unassigned manual ticket with assigned_to=%s using Mongo null equality', async assignedTo => {
  getTicketById.mockResolvedValue({ ...ticket, assigned_to: assignedTo, messenger: 'manual', created_by: '42' });
  await handleCallback(ctx(), confirm());
  expect(update).toHaveBeenCalledTimes(1);
  expect(update.mock.calls[0][0].assigned_to).toBeNull();
});

it.each(['visibility', 'assignment'])('rejects a concurrent %s change at the atomic write', async change => {
  // Simulate a write after both ACL reads; updated_at deliberately stays unchanged.
  const stored: any = { ...ticket, common_visible: false };
  update.mockImplementationOnce(async (filter: any) => {
    if (change === 'visibility') stored.common_visible = true;
    else stored.assigned_to = '43';
    const visibilityMatches = filter.common_visible === true
      ? stored.common_visible === true : stored.common_visible !== true;
    return visibilityMatches && filter.assigned_to === stored.assigned_to ? stored : null;
  });
  const context = ctx();
  await handleCallback(context, confirm());
  expect(context.answerCbQuery).toHaveBeenCalledWith('Заявка изменилась. Обновите карточку.', true);
  expect(refreshStaffCard).not.toHaveBeenCalled();
  expect(answer).not.toHaveBeenCalled();
});
