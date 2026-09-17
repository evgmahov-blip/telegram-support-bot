jest.unmock('../src/ticket-ownership');

const mockFindOne = jest.fn();
const mockFindOneAndUpdate = jest.fn();

jest.mock('../src/db', () => ({
  Supportee: {
    findOne: mockFindOne,
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

  it('uses expected owner as a compare-and-set guard during agent transfer', async () => {
    const ticket = { ticketId: 11, assigned_to: 'agent-2', status: 'open' };
    mockFindOneAndUpdate.mockResolvedValue(ticket);

    const result = await ownership.transferTicket(11, 'agent-2', 'agent-1');

    expect(result).toBe(ticket);
    expect(mockFindOne).not.toHaveBeenCalled();
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

  it('snapshots current owner for supervisor/admin transfer and then uses CAS', async () => {
    mockFindOne.mockResolvedValue({ ticketId: 12, assigned_to: 'agent-1', status: 'open' });
    mockFindOneAndUpdate.mockResolvedValue({ ticketId: 12, assigned_to: 'agent-2', status: 'open' });

    const result = await ownership.transferTicket(12, 'agent-2');

    expect(result).toEqual({ ticketId: 12, assigned_to: 'agent-2', status: 'open' });
    expect(mockFindOne).toHaveBeenCalledWith({
      ticketId: 12,
      status: { $in: ['open', 'waiting_user'] },
    });
    expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
      {
        ticketId: 12,
        status: { $in: ['open', 'waiting_user'] },
        assigned_to: 'agent-1',
      },
      { $set: { assigned_to: 'agent-2' } },
      { new: true },
    );
  });

  it('guards unowned supervisor/admin transfer with assigned_to null', async () => {
    mockFindOne.mockResolvedValue({ ticketId: 13, assigned_to: null, status: 'waiting_user' });
    mockFindOneAndUpdate.mockResolvedValue(null);

    const result = await ownership.transferTicket(13, 'agent-2');

    expect(result).toBeNull();
    expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
      {
        ticketId: 13,
        status: { $in: ['open', 'waiting_user'] },
        assigned_to: null,
      },
      { $set: { assigned_to: 'agent-2' } },
      { new: true },
    );
  });
});