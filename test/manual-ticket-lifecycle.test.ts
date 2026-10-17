// Close/reopen/surveys/auto-close/broadcast paths never reach a client transport for a manual ticket.
const tgSend = jest.fn().mockResolvedValue('1');
const sigSend = jest.fn().mockResolvedValue('1');
const emit = jest.fn();
const findOneAndUpdate = jest.fn();
const transitionTicketStatus = jest.fn();
const recordAnalyticsEvent = jest.fn().mockResolvedValue(undefined);
const add = jest.fn();
const openTickets: any[] = [];

jest.mock('../src/addons/telegram', () => ({ __esModule: true, default: { getInstance: () => ({ sendMessage: tgSend }) } }));
jest.mock('../src/addons/signal', () => ({ __esModule: true, default: { getInstance: () => ({ sendMessage: sigSend }) } }));
jest.mock('../src/webhooks', () => ({ webhooks: { ticketClosed: jest.fn().mockResolvedValue(undefined) } }));
jest.mock('../src/logger', () => ({ info: jest.fn(), error: jest.fn() }));
jest.mock('../src/db', () => ({
  Supportee: { findOneAndUpdate, find: jest.fn(async () => openTickets) },
  TicketMessage: { find: () => ({ sort: () => ({ limit: async () => [] }) }) },
  getTicketById: jest.fn(), recordAnalyticsEventBestEffort: jest.fn(), recordAnalyticsEvent,
  transitionTicketStatus, add, setClosedAt: jest.fn(),
}));
jest.mock('../src/cache', () => ({ __esModule: true, default: {
  config: { parse_mode: 'HTML', enable_csat: true, auto_close_after_days: 1,
    language: { ticket: 'Тикет', closed: 'закрыт', ticketClosed: 'Закрыт.', csatRatingRequest: 'Оцените' } },
  io: { to: jest.fn(() => ({ emit })) }, ticketIDs: {}, ticketStatus: {}, ticketSent: {},
} }));

import * as middleware from '../src/middleware';
import { closeTicketLifecycle } from '../src/ticket-state';
import { sendCSATSurvey } from '../src/analytics';
import { checkAutoClose } from '../src/workflows';
import { ManualTicketDeliveryError } from '../src/manual-ticket-guard';

const manual: any = { ticketId: 9, userid: 'MANUAL:3f1c', messenger: 'manual', status: 'open', assigned_to: '42' };
const noClientNetwork = () => { expect(tgSend).not.toHaveBeenCalled(); expect(sigSend).not.toHaveBeenCalled(); expect(emit).not.toHaveBeenCalled(); };

describe('manual ticket delivery guard', () => {
  beforeEach(() => { jest.clearAllMocks(); openTickets.length = 0; });

  it('central sendMessage fails closed for the manual namespace on every messenger', async () => {
    for (const messenger of ['telegram', 'signal', 'web', 'manual']) {
      await expect(middleware.sendMessage('MANUAL:3f1c', messenger, 'x')).rejects.toBeInstanceOf(ManualTicketDeliveryError);
    }
    await expect(middleware.sendMessage('12345', 'manual', 'x')).rejects.toBeInstanceOf(ManualTicketDeliveryError);
    noClientNetwork();
  });

  it('leaves ordinary Telegram delivery unchanged', async () => {
    await middleware.sendMessage('12345', 'telegram', 'x');
    expect(tgSend).toHaveBeenCalledWith('12345', 'x', expect.anything());
  });

  it('closes a manual ticket without notifying or reporting a failed notification', async () => {
    findOneAndUpdate.mockResolvedValueOnce({ ...manual, status: 'closed' });
    const result = await closeTicketLifecycle(manual, '42', '42');
    expect(result).toEqual(expect.objectContaining({ outcome: 'closed', notificationFailed: false }));
    noClientNetwork();
  });

  it('still notifies an ordinary Telegram client on close', async () => {
    findOneAndUpdate.mockResolvedValueOnce({ ...manual, userid: '700', messenger: 'telegram', status: 'closed' });
    await closeTicketLifecycle({ ...manual, userid: '700', messenger: 'telegram' }, '42');
    expect(tgSend).toHaveBeenCalledWith('700', expect.stringContaining('закрыт'), expect.anything());
  });

  it('never sends a CSAT survey to a manual ticket', async () => {
    await sendCSATSurvey('MANUAL:3f1c', 'manual', 9);
    noClientNetwork();
  });

  it('auto-closes an inactive manual ticket by id without a client message', async () => {
    openTickets.push({ ...manual }, { ...manual, ticketId: 10, userid: '700', messenger: 'telegram' });
    transitionTicketStatus.mockResolvedValue({ ...manual, status: 'closed' });
    await checkAutoClose();
    expect(transitionTicketStatus).toHaveBeenCalledWith(9, 'closed');
    expect(add).not.toHaveBeenCalledWith('MANUAL:3f1c', expect.anything(), expect.anything(), expect.anything());
    expect(recordAnalyticsEvent).toHaveBeenCalledWith('ticket.closed', 9, null, { reason: 'auto_close_inactivity' });
    // The Telegram ticket after it is still processed (the manual one did not abort the loop).
    expect(tgSend).toHaveBeenCalledTimes(1);
    expect(tgSend).toHaveBeenCalledWith('700', expect.any(String), expect.anything());
  });
});
