const mockFindOneAndUpdate = jest.fn();

jest.mock('../src/db', () => ({
  Supportee: {
    findOneAndUpdate: mockFindOneAndUpdate,
  },
}));

import * as ticketState from '../src/ticket-state';

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
});
