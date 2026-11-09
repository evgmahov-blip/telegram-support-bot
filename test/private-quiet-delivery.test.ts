const send = jest.fn();
const read = jest.fn();
jest.mock('../src/middleware', () => ({ sendMessage: send }));
jest.mock('../src/db', () => ({ getTicketById: read }));
jest.mock('../src/team', () => ({ getStaffRole: (id: string) => ({ '42': 'agent', '43': 'agent', '50': 'supervisor' }[id]) }));
jest.mock('../src/cache', () => ({ __esModule: true, default: { config: { staffchat_id: '-100', staffchat_type: 'telegram' } } }));
jest.mock('../src/logger', () => ({ error: jest.fn() }));

import { canViewTicket, notifyTicketStaff } from '../src/ticket-visibility';

const ticket: any = { ticketId: 7, assigned_to: '42', common_visible: false, status: 'open', pending_reply_version: 3,
  routing: { state: 'accepted', version: 4 } };

beforeEach(() => { jest.clearAllMocks(); read.mockResolvedValue(ticket); send.mockResolvedValue('88'); });

it('keeps two engineers separate and lets the supervisor request a private view', () => {
  expect(canViewTicket('42', ticket)).toBe(true);
  expect(canViewTicket('43', ticket)).toBe(false);
  expect(canViewTicket('50', ticket)).toBe(true);
});

it('delivers routine personal content silently to the owner DM only', async () => {
  expect(await notifyTicketStaff(ticket, 'private content')).toEqual({ route: 'owner', messageId: '88' });
  expect(send).toHaveBeenCalledTimes(1);
  expect(send).toHaveBeenCalledWith('42', 'telegram', 'private content', { disable_notification: true });
});

it('does not send a group notice, including the ticket ID, when the owner DM fails', async () => {
  send.mockRejectedValue(new Error('blocked'));
  expect(await notifyTicketStaff(ticket, 'private content')).toEqual({ route: 'undelivered', messageId: null });
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0][0]).toBe('42');
});

it.each([
  { assigned_to: '43' }, { common_visible: true }, { routing: { state: 'accepted', version: 5 } },
  { status: 'closed' }, { pending_reply_version: 4 },
])('does not deliver from a stale ticket snapshot: %p', async change => {
  read.mockResolvedValue({ ...ticket, ...change });
  expect(await notifyTicketStaff(ticket, 'private content')).toEqual({ route: 'undelivered', messageId: null });
  expect(send).not.toHaveBeenCalled();
});

it('allows sound for the explicit important event', async () => {
  await notifyTicketStaff(ticket, 'reply after waiting', { disable_notification: false });
  expect(send).toHaveBeenCalledWith('42', 'telegram', 'reply after waiting', { disable_notification: false });
});
