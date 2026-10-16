const mockFindOneAndUpdate = jest.fn();
const mockAnalytics = jest.fn();
const mockGetTicket = jest.fn();
const mockSend = jest.fn();
const mockWebhook = jest.fn();

jest.mock('../src/db', () => ({
  Supportee: {
    findOneAndUpdate: mockFindOneAndUpdate,
  },
  getTicketById: mockGetTicket,
  recordAnalyticsEventBestEffort: mockAnalytics,
}));
jest.mock('../src/middleware', () => ({ sendMessage: mockSend }));
jest.mock('../src/webhooks', () => ({ webhooks: { ticketClosed: mockWebhook } }));

import * as ticketState from '../src/ticket-state';
import cache from '../src/cache';

describe('ticket state compare-and-set transitions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('resumes only WAITING_USER -> OPEN', async () => {
    const resumed = { ticketId: 77, status: 'open', closed_at: null };
    mockFindOneAndUpdate.mockResolvedValue(resumed);

    const result = await ticketState.resumeWaitingTicket(77);

    expect(result).toBe(resumed);
    expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
      {
        ticketId: 77,
        status: { $in: ['waiting_user'] },
      },
      {
        $set: {
          status: 'open',
          closed_at: null,
        },
      },
      { new: true },
    );
  });

  it('returns null when a concurrent state change wins', async () => {
    mockFindOneAndUpdate.mockResolvedValue(null);

    const result = await ticketState.resumeWaitingTicket(78);

    expect(result).toBeNull();
  });

  it('keeps close side effects after a best-effort analytics failure', async () => {
    const ticket: any = { ticketId: 79, userid: '700', messenger: 'telegram', status: 'open', assigned_to: '42' };
    mockFindOneAndUpdate.mockResolvedValue({ ...ticket, status: 'closed' });
    mockAnalytics.mockRejectedValue(new Error('analytics unavailable'));
    mockWebhook.mockResolvedValue(undefined);
    mockSend.mockResolvedValue('91');
    cache.ticketIDs['700'] = 79; cache.ticketStatus['700'] = true; cache.ticketSent['700'] = true;

    const result = await ticketState.closeTicketLifecycle(ticket, '42', '42');
    await new Promise((resolve) => setImmediate(resolve));

    expect(result.outcome).toBe('closed');
    expect(cache.ticketIDs['700']).toBeUndefined();
    expect(cache.ticketStatus['700']).toBeUndefined();
    expect(cache.ticketSent['700']).toBeUndefined();
    expect(mockWebhook).toHaveBeenCalledWith(79, '700');
    expect(mockSend).toHaveBeenCalledWith('700', 'telegram', expect.stringContaining('#T000079'));
  });
});
