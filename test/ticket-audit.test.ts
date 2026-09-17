const mockLean = jest.fn();
const mockLimit = jest.fn(() => ({ lean: mockLean }));
const mockSort = jest.fn(() => ({ limit: mockLimit }));
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

  it('reads newest events for one ticket with a bounded limit', async () => {
    const events = [{ type: 'ticket.taken', ticketId: 31 }];
    mockLean.mockResolvedValue(events);

    await expect(audit.getTicketAuditHistory(31, 500)).resolves.toEqual(events);

    expect(mockFind).toHaveBeenCalledWith({ ticketId: 31 });
    expect(mockSort).toHaveBeenCalledWith({ timestamp: -1 });
    expect(mockLimit).toHaveBeenCalledWith(100);
  });
});
