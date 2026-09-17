const mockFindOne = jest.fn();
const mockUpdateOne = jest.fn();

jest.mock('../src/db', () => ({
  Supportee: {
    collection: {
      findOne: mockFindOne,
      updateOne: mockUpdateOne,
    },
  },
}));

jest.mock('../src/cache', () => ({
  __esModule: true,
  default: {
    config: {
      queues: ['general', 'billing', 'infra'],
      default_queue: 'general',
    },
  },
}));

import * as queues from '../src/ticket-queue';

describe('ticket queues', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('resolves configured queue names case-insensitively', () => {
    expect(queues.listQueues()).toEqual(['general', 'billing', 'infra']);
    expect(queues.resolveQueueName('BILLING')).toBe('billing');
    expect(queues.resolveQueueName('missing')).toBeNull();
  });

  it('treats old tickets without queue metadata as default queue', async () => {
    mockFindOne.mockResolvedValue({ ticketId: 10 });
    await expect(queues.getTicketQueue(10)).resolves.toBe('general');
  });

  it('returns stored queue when present', async () => {
    mockFindOne.mockResolvedValue({ ticketId: 10, queue: 'infra' });
    await expect(queues.getTicketQueue(10)).resolves.toBe('infra');
  });

  it('moves an owned active ticket atomically for an agent', async () => {
    mockUpdateOne.mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });

    await expect(queues.moveTicketToQueue(10, 'billing', 'agent-1')).resolves.toBe(true);

    expect(mockUpdateOne).toHaveBeenCalledWith(
      {
        ticketId: 10,
        status: { $in: ['open', 'waiting_user'] },
        assigned_to: 'agent-1',
      },
      { $set: { queue: 'billing' } },
    );
  });

  it('does not write unknown queues', async () => {
    await expect(queues.moveTicketToQueue(10, 'unknown', 'agent-1')).resolves.toBe(false);
    expect(mockUpdateOne).not.toHaveBeenCalled();
  });

  it('reports a lost state/owner race as false', async () => {
    mockUpdateOne.mockResolvedValue({ matchedCount: 0, modifiedCount: 0 });
    await expect(queues.moveTicketToQueue(10, 'infra', 'agent-1')).resolves.toBe(false);
  });
});
