const mockLean = jest.fn();
const query = { limit: jest.fn(), lean: mockLean };
const mockLimit = query.limit;
const mockSort = jest.fn(() => query);
const mockFind = jest.fn(() => ({ sort: mockSort }));

jest.mock('../src/db', () => ({
  AnalyticsEvent: {
    find: mockFind,
  },
}));

import * as audit from '../src/ticket-audit';

describe('ticket audit history', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('reads requested events for one ticket without silently truncating the limit', async () => {
    const events = [{ type: 'ticket.taken', ticketId: 31 }];
    mockLean.mockResolvedValue(events);

    await expect(audit.getTicketAuditHistory(31, 500)).resolves.toEqual(events);

    expect(mockFind).toHaveBeenCalledWith({ ticketId: 31 });
    expect(mockSort).toHaveBeenCalledWith({ timestamp: -1 });
    expect(mockLimit).toHaveBeenCalledWith(500);
  });
});
