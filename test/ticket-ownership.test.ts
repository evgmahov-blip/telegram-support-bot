const mockFindOneAndUpdate = jest.fn();

jest.mock('../src/db', () => ({
  Supportee: {
    findOneAndUpdate: mockFindOneAndUpdate,
  },
}));

import * as ownership from '../src/ticket-ownership';

describe('ticket ownership', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('takes only an active unowned ticket or the same agent ticket', async () => {
    const ticket = { ticketId: 10, assigned_to: 'agent-1', status: 'open' };
    mockFindOneAndUpdate.mockResolvedValue(ticket);

    const result = await ownership.takeTicket(10, 'agent-1');

    expect(result).toBe(ticket);
    expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
      {
        ticketId: 10,
        status: { $in: ['open', 'waiting_user'] },
        $or: [
          { assigned_to: null },
          { assigned_to: 'agent-1' },
        ],
      },
      { $set: { assigned_to: 'agent-1' } },
      { new: true },
    );
  });

  it('uses expected owner as a compare-and-set guard during transfer', async () => {
    const ticket = { ticketId: 11, assigned_to: 'agent-2', status: 'open' };
    mockFindOneAndUpdate.mockResolvedValue(ticket);

    const result = await ownership.transferTicket(11, 'agent-2', 'agent-1');

    expect(result).toBe(ticket);
    expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
      {
        ticketId: 11,
        status: { $in: ['open', 'waiting_user'] },
        assigned_to: 'agent-1',
      },
      { $set: { assigned_to: 'agent-2' } },
      { new: true },
    );
  });

  it('allows supervisor/admin transfer without an expected owner guard', async () => {
    mockFindOneAndUpdate.mockResolvedValue({ ticketId: 12, assigned_to: 'agent-2' });

    await ownership.transferTicket(12, 'agent-2');

    expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
      {
        ticketId: 12,
        status: { $in: ['open', 'waiting_user'] },
      },
      { $set: { assigned_to: 'agent-2' } },
      { new: true },
    );
  });
});
