const send = jest.fn().mockResolvedValue('1');
const read = jest.fn();
const route = jest.fn();
const deliver = jest.fn().mockResolvedValue(undefined);
const transfer = jest.fn();
jest.mock('../src/middleware', () => ({ sendMessage: send, reply: jest.fn(), strictEscape: (v: string) => v }));
jest.mock('../src/db', () => ({ getTicketById: read, recordAnalyticsEvent: jest.fn() }));
jest.mock('../src/ticket-routing', () => ({ routingCommand: route, deliverOffer: deliver, flushRoutingAudit: jest.fn() }));
jest.mock('../src/ticket-ownership', () => ({ transferTicket: transfer }));
jest.mock('../src/cache', () => ({ __esModule: true, default: {
  config: { staffchat_type: 'telegram' }, staffMembers: new Map([
    ['42', { telegram_id: '42', role: 'agent', name: 'A' }],
    ['43', { telegram_id: '43', role: 'agent', name: 'B' }],
  ]),
} }));
import { transferTicketCommand } from '../src/team';
const ctx: any = { from: { id: 42 } };
beforeEach(() => jest.clearAllMocks());
it('uses the routing offer as the only recipient notification', async () => {
  read.mockResolvedValue({ ticketId: 7, assigned_to: '42', routing: { version: 1 } });
  const moved = { ticketId: 7, assigned_to: null, routing: { version: 2, state: 'offered', offered_to: '43' } };
  route.mockResolvedValue(moved);
  await transferTicketCommand(ctx, '43', 7);
  expect(deliver).toHaveBeenCalledTimes(1);
  expect(deliver).toHaveBeenCalledWith(moved);
  expect(send).not.toHaveBeenCalled();
});
it('retains a single recipient notification for legacy transfers', async () => {
  read.mockResolvedValue({ ticketId: 7, assigned_to: '42' });
  transfer.mockResolvedValue({ ticketId: 7, assigned_to: '43' });
  await transferTicketCommand(ctx, '43', 7);
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0][0]).toBe('43');
  expect(deliver).not.toHaveBeenCalled();
});
