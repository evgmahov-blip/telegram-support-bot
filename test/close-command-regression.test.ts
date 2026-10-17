const reply = jest.fn().mockResolvedValue(undefined);
const getTicketByInternalId = jest.fn();
const getTicketById = jest.fn();
const closeLifecycle = jest.fn();
const refresh = jest.fn().mockResolvedValue(undefined);
const getTicketByUserId = jest.fn();
const sendMessage = jest.fn().mockResolvedValue('90');

jest.mock('../src/middleware', () => ({ reply, sendMessage, strictEscape: (x: string) => x }));
jest.mock('../src/db', () => ({
  getTicketByInternalId, getTicketById, getTicketByUserId, transitionTicketStatus: jest.fn(),
  closeAll: jest.fn(), open: jest.fn(), banUser: jest.fn(), unbanUser: jest.fn(), getInternalNotes: jest.fn(),
  getConversationHistory: jest.fn(),
}));
jest.mock('../src/ticket-state', () => ({ closeTicketLifecycle: closeLifecycle }));
jest.mock('../src/ticket-ui', () => ({ refreshStaffCard: refresh }));
jest.mock('../src/cache', () => ({ __esModule: true, default: { config: { language: {
  from: 'От', ticket: 'Тикет', closed: 'закрыт', ticketClosed: 'Закрыт', ticketClosedError: 'Закрыт',
}, allow_user_close: false, staffchat_type: 'telegram', staffchat_id: -100700 }, ticketIDs: {}, ticketStatus: {}, ticketSent: {}, staffMembers: new Map() } }));
jest.mock('../src/analytics', () => ({ sendCSATSurvey: jest.fn().mockResolvedValue(undefined), showStatsCommand: jest.fn() }));
jest.mock('../src/webhooks', () => ({ webhooks: { ticketClosed: jest.fn() } }));
jest.mock('../src/workflows', () => ({ listCannedResponses: jest.fn(), getCannedResponse: jest.fn() }));

import { closeCommand } from '../src/commands';
import cache from '../src/cache';
import { Context, Messenger } from '../src/interfaces';

const ticket = { ticketId: 7, userid: 'client', messenger: Messenger.TELEGRAM, status: 'open', assigned_to: '42', category: null };
function context(replyMessage = true, actor = 42, chatId = -100700): Context {
  const update: any = { update_id: 500, message: { message_id: 10, text: '/close', from: { id: actor }, chat: {
    id: chatId, type: chatId > 0 ? 'private' : 'supergroup',
  } } };
  const message = update.message;
  if (replyMessage) message.reply_to_message = { message_id: 6, from: { is_bot: false }, text: 'staff reply' };
  return { ...update, chat: update.message.chat, from: update.message.from, messenger: Messenger.TELEGRAM,
    session: { admin: chatId < 0, groupCategory: null } } as Context;
}

describe('production /close regression', () => {
  beforeEach(() => { jest.clearAllMocks(); cache.staffMembers.clear();
    cache.staffMembers.set('42', { telegram_id: '42', name: 'Agent', role: 'agent' } as any);
    cache.staffMembers.set('99', { telegram_id: '99', name: 'Other', role: 'agent' } as any);
    cache.config.allow_user_close = false;
    getTicketByInternalId.mockResolvedValue(ticket); closeLifecycle.mockResolvedValue({ outcome: 'closed', ticket: { ...ticket, status: 'closed' } }); });

  it('uses one numeric Telegram update and the persisted message correlation', async () => {
    const ctx = context(); await closeCommand(ctx);
    expect(getTicketByInternalId).toHaveBeenCalledWith(6);
    expect(closeLifecycle).toHaveBeenCalledWith(ticket, '42', '42');
    expect(refresh).toHaveBeenCalledWith(7);
  });

  it.each([
    ['nonstaff', 77, ticket, 'У вас нет прав закрывать заявки.'],
    ['unassigned agent', 42, { ...ticket, assigned_to: null }, 'Сначала возьмите заявку командой /take.'],
    ['another agent', 99, ticket, 'Эта заявка назначена другому сотруднику.'],
  ])('%s boundary', async (_n, actor, current, expected) => {
    getTicketByInternalId.mockResolvedValue(current);
    await closeCommand(context(true, actor)); expect(reply).toHaveBeenCalledWith(expect.anything(), expected);
  });

  it('reports an owner change won by a concurrent write', async () => {
    closeLifecycle.mockResolvedValue({ outcome: 'stale', ticket: { ...ticket, assigned_to: '99' } });
    await closeCommand(context());
    expect(reply).toHaveBeenCalledWith(expect.anything(), 'Состояние или владелец заявки изменились; заявка не закрыта.');
  });

  it('checks role before revealing a closed ticket state', async () => {
    getTicketByInternalId.mockResolvedValue({ ...ticket, status: 'closed' });
    await closeCommand(context(true, 77));
    expect(reply).toHaveBeenCalledWith(expect.anything(), 'У вас нет прав закрывать заявки.');
  });

  it('allows only the configured private user-close compatibility path', async () => {
    cache.config.allow_user_close = true;
    getTicketByUserId.mockResolvedValue({ ...ticket, userid: '700' });
    await closeCommand(context(false, 700, 700));
    expect(closeLifecycle).toHaveBeenCalledWith(expect.objectContaining({ userid: '700' }), '700', undefined,
      expect.objectContaining({ notifyUser: false }));
  });
});
