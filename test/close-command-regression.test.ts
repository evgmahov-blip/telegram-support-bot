const reply = jest.fn().mockResolvedValue(undefined);
const getTicketByInternalId = jest.fn();
const getTicketById = jest.fn();
const closeLifecycle = jest.fn();
const refresh = jest.fn().mockResolvedValue(undefined);
const role = jest.fn().mockReturnValue('agent');
const canReply = jest.fn().mockReturnValue(true);
const canManage = jest.fn().mockReturnValue(true);

jest.mock('../src/middleware', () => ({ reply, sendMessage: jest.fn(), strictEscape: (x: string) => x }));
jest.mock('../src/db', () => ({
  getTicketByInternalId, getTicketById, getTicketByUserId: jest.fn(), transitionTicketStatus: jest.fn(),
  closeAll: jest.fn(), open: jest.fn(), banUser: jest.fn(), unbanUser: jest.fn(), getInternalNotes: jest.fn(),
  getConversationHistory: jest.fn(),
}));
jest.mock('../src/ticket-state', () => ({ closeTicketLifecycle: closeLifecycle }));
jest.mock('../src/ticket-ui', () => ({ refreshStaffCard: refresh }));
jest.mock('../src/team', () => ({ getStaffRole: role, canPerformAction: canReply, canManageTicket: canManage }));
jest.mock('../src/cache', () => ({ __esModule: true, default: { config: { language: {
  from: 'От', ticket: 'Тикет', closed: 'закрыт', ticketClosed: 'Закрыт', ticketClosedError: 'Закрыт',
}, allow_user_close: false }, ticketIDs: {}, ticketStatus: {}, ticketSent: {}, staffMembers: new Map() } }));
jest.mock('../src/analytics', () => ({ sendCSATSurvey: jest.fn(), showStatsCommand: jest.fn() }));
jest.mock('../src/webhooks', () => ({ webhooks: { ticketClosed: jest.fn() } }));
jest.mock('../src/workflows', () => ({ listCannedResponses: jest.fn(), getCannedResponse: jest.fn() }));

import { closeCommand } from '../src/commands';
import { Context, Messenger } from '../src/interfaces';

const ticket = { ticketId: 7, userid: 'client', messenger: Messenger.TELEGRAM, status: 'open', assigned_to: '42', category: null };
function context(replyMessage = true): Context {
  const message: any = { message_id: 10, text: '/close', from: { id: '42' }, chat: { id: '-100', type: 'supergroup' } };
  if (replyMessage) message.reply_to_message = { message_id: 6, from: { is_bot: false }, text: 'staff reply' };
  return { update_id: 500, message, chat: message.chat, from: { id: '42' }, messenger: Messenger.TELEGRAM,
    session: { admin: true, groupCategory: null }, callbackQuery: { data: '', from: { id: '42' }, id: '' } } as Context;
}

describe('production /close regression', () => {
  beforeEach(() => { jest.clearAllMocks(); role.mockReturnValue('agent'); canReply.mockReturnValue(true); canManage.mockReturnValue(true);
    getTicketByInternalId.mockResolvedValue(ticket); closeLifecycle.mockResolvedValue({ outcome: 'closed', ticket: { ...ticket, status: 'closed' } }); });

  it('uses one numeric Telegram update and the persisted message correlation', async () => {
    const ctx = context(); await closeCommand(ctx);
    expect(getTicketByInternalId).toHaveBeenCalledWith(6);
    expect(closeLifecycle).toHaveBeenCalledWith(ticket, '42', '42');
    expect(refresh).toHaveBeenCalledWith(7);
  });

  it.each([
    ['nonstaff', null, true, true, 'У вас нет прав закрывать тикеты.'],
    ['unassigned agent', 'agent', true, false, 'Сначала возьмите тикет командой /take.'],
    ['owner changed', 'agent', true, true, 'Состояние или владелец тикета изменились; тикет не закрыт.'],
  ])('%s boundary', async (_n, staffRole, allowed, manageable, expected) => {
    role.mockReturnValue(staffRole); canReply.mockReturnValue(allowed); canManage.mockReturnValue(manageable);
    if (_n === 'unassigned agent') getTicketByInternalId.mockResolvedValue({ ...ticket, assigned_to: null });
    if (_n === 'owner changed') closeLifecycle.mockResolvedValue({ outcome: 'stale', ticket: { ...ticket, assigned_to: '99' } });
    await closeCommand(context()); expect(reply).toHaveBeenCalledWith(expect.anything(), expected);
  });

  it('checks role before revealing a closed ticket state', async () => {
    getTicketByInternalId.mockResolvedValue({ ...ticket, status: 'closed' }); role.mockReturnValue(null);
    await closeCommand(context());
    expect(reply).toHaveBeenCalledWith(expect.anything(), 'У вас нет прав закрывать тикеты.');
  });
});
