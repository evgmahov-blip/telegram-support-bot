const mockPost = jest.fn();
const mockLogError = jest.fn();

jest.mock('axios', () => ({
  __esModule: true,
  default: { post: mockPost },
}));

jest.mock('../src/cache', () => ({
  __esModule: true,
  default: { config: { webhooks: [] } },
}));

jest.mock('../src/logger', () => ({
  info: jest.fn(),
  error: mockLogError,
}));

import cache from '../src/cache';
import { drainWebhooks, sendWebhook, webhooks } from '../src/webhooks';

describe('legacy webhook reliability', () => {
  beforeEach(async () => {
    await drainWebhooks();
    jest.clearAllMocks();
    cache.config.webhooks = [] as any;
  });

  afterEach(async () => {
    await drainWebhooks();
  });

  it('keeps compatibility webhook delivery off the ticket critical path and drains it later', async () => {
    let resolvePost!: () => void;
    mockPost.mockImplementationOnce(() => new Promise((resolve) => {
      resolvePost = () => resolve({ data: {} });
    }));
    cache.config.webhooks = [
      { url: 'https://example.test/hook', events: ['ticket.created'] },
    ] as any;

    const result = webhooks.ticketCreated(12, '42', 'hello');
    expect(result).toBeUndefined();
    expect(mockPost).toHaveBeenCalledTimes(1);

    let drained = false;
    const draining = drainWebhooks().then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);

    resolvePost();
    await draining;
    expect(drained).toBe(true);
  });

  it('delivers subscribers concurrently instead of serializing slow endpoints', async () => {
    let resolveFirst!: () => void;
    let resolveSecond!: () => void;
    mockPost
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveFirst = () => resolve({ data: {} });
      }))
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveSecond = () => resolve({ data: {} });
      }));
    cache.config.webhooks = [
      { url: 'https://one.test/hook', events: ['ticket.closed'] },
      { url: 'https://two.test/hook', events: ['ticket.closed'] },
    ] as any;

    const pending = sendWebhook('ticket.closed', 12, '42');
    expect(mockPost).toHaveBeenCalledTimes(2);

    resolveFirst();
    resolveSecond();
    await pending;
  });

  it('isolates a failed endpoint from the remaining subscribers', async () => {
    mockPost
      .mockRejectedValueOnce(new Error('endpoint down'))
      .mockResolvedValueOnce({ data: {} });
    cache.config.webhooks = [
      { url: 'https://bad.test/hook', events: ['ticket.replied'] },
      { url: 'https://good.test/hook', events: ['ticket.replied'] },
    ] as any;

    await expect(sendWebhook('ticket.replied', 12, null, 'reply')).resolves.toBeUndefined();
    expect(mockPost).toHaveBeenCalledTimes(2);
    expect(mockLogError).toHaveBeenCalledTimes(1);
  });
});
