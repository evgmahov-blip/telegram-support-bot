const mockFindOneAndUpdate = jest.fn();
const mockFindOne = jest.fn();

jest.mock('../src/db', () => ({
  Supportee: {
    findOneAndUpdate: mockFindOneAndUpdate,
    findOne: mockFindOne,
  },
}));

import * as metadata from '../src/ticket-metadata';
import { TicketPriority } from '../src/interfaces';

describe('ticket metadata guards', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('changes priority atomically for the current agent owner', async () => {
    const ticket = { ticketId: 21, priority: 'high' };
    mockFindOneAndUpdate.mockResolvedValue(ticket);

    await expect(metadata.setPriority(21, TicketPriority.HIGH, 'agent-1')).resolves.toBe(ticket);

    expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
      {
        ticketId: 21,
        status: { $in: ['open', 'waiting_user'] },
        assigned_to: 'agent-1',
      },
      { $set: { priority: TicketPriority.HIGH } },
      { new: true },
    );
  });

  it('lets supervisor/admin omit the owner CAS while still requiring active state', async () => {
    mockFindOneAndUpdate.mockResolvedValue({ ticketId: 22 });

    await metadata.setPriority(22, TicketPriority.URGENT);

    expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
      {
        ticketId: 22,
        status: { $in: ['open', 'waiting_user'] },
      },
      { $set: { priority: TicketPriority.URGENT } },
      { new: true },
    );
  });

  it('guards note writes against close and ownership races', async () => {
    mockFindOne.mockResolvedValue({ ticketId: 23, assigned_to: 'agent-1' });

    await metadata.getActiveManageableTicket(23, 'agent-1');

    expect(mockFindOne).toHaveBeenCalledWith({
      ticketId: 23,
      status: { $in: ['open', 'waiting_user'] },
      assigned_to: 'agent-1',
    });
  });
});
