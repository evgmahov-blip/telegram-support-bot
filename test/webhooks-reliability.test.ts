const mockPost = jest.fn();
const mockLogError = jest.fn();
const mockGetLatestEventSequence = jest.fn();
const mockInitializeWebhookCursor = jest.fn();
const mockGetEventsSince = jest.fn();
const mockAdvanceWebhookCursor = jest.fn();

jest.mock('axios', () => ({
  __esModule: true,
  default: { post: mockPost },
}));

jest.mock('../src/cache', () => ({
  __esModule: true,
  default: { config: { webhooks: [] } },
}));

jest.mock('../src/db', () => ({
  getLatestEventSequence: mockGetLatestEventSequence,
  initializeWebhookCursor: mockInitializeWebhookCursor,
  getEventsSince: mockGetEventsSince,
  advanceWebhookCursor: mockAdvanceWebhookCursor,
}));

jest.mock('../src/logger', () => ({
  info: jest.fn(),
  error: mockLogError,
}));

import cache from '../src/cache';
import {
  drainWebhooks,
  getDurableWebhookSubscriberId,
  sendWebhook,
  startDurableWebhookWorker,
  stopDurableWebhookWorker,
  webhooks,
} from '../src/webhooks';

describe('webhook reliability', () => {
  beforeEach(async () => {
    await stopDurableWebhookWorker();
    await drainWebhooks();
    jest.clearAllMocks();
    cache.config.webhooks = [] as any;
    mockGetLatestEventSequence.mockResolvedValue(0);
    mockInitializeWebhookCursor.mockImplementation(async (_id: string, seq: number) => seq);
    mockGetEventsSince.mockResolvedValue([]);
    mockAdvanceWebhookCursor.mockResolvedValue(undefined);
    mockPost.mockResolvedValue({ data: {} });
  });

  afterEach(async () => {
    await stopDurableWebhookWorker();
    await drainWebhooks();
    jest.useRealTimers();
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

  it('delivers legacy subscribers concurrently instead of serializing slow endpoints', async () => {
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

  it('isolates a failed legacy endpoint from the remaining subscribers', async () => {
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

  it('excludes durable subscribers from compatibility push delivery', async () => {
    cache.config.webhooks = [
      { url: 'https://legacy.test/hook', events: ['ticket.closed'] },
      {
        id: 'crm',
        url: 'https://durable.test/hook',
        events: ['ticket.closed'],
        durable: true,
      },
    ] as any;

    await sendWebhook('ticket.closed', 12, '42');

    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(mockPost.mock.calls[0][0]).toBe('https://legacy.test/hook');
  });

  it('starts a new durable subscriber at the current event tail', async () => {
    jest.useFakeTimers();
    cache.config.webhooks = [{
      id: 'crm',
      url: 'https://durable.test/hook',
      events: ['ticket.closed'],
      durable: true,
    }] as any;
    mockGetLatestEventSequence.mockResolvedValue(9);

    await startDurableWebhookWorker();
    await jest.advanceTimersByTimeAsync(0);

    expect(mockInitializeWebhookCursor).toHaveBeenCalledWith('crm', 9);
    expect(mockGetEventsSince).toHaveBeenCalledWith(9, 100);
  });

  it('replays from an existing cursor, advances unrelated events, and sends event identity', async () => {
    jest.useFakeTimers();
    cache.config.webhooks = [{
      id: 'crm',
      url: 'https://durable.test/hook',
      events: ['ticket.closed'],
      secret: 'secret',
      durable: true,
    }] as any;
    mockGetLatestEventSequence.mockResolvedValue(20);
    mockInitializeWebhookCursor.mockResolvedValue(2);
    mockGetEventsSince.mockResolvedValueOnce([
      {
        event_id: 'evt-3',
        seq: 3,
        type: 'ticket.created',
        ticketId: 42,
        timestamp: new Date('2026-09-18T08:00:00Z'),
        agent_id: null,
        metadata: { user_id: '42' },
      },
      {
        event_id: 'evt-4',
        seq: 4,
        type: 'ticket.closed',
        ticketId: 42,
        timestamp: new Date('2026-09-18T08:01:00Z'),
        agent_id: 'agent1',
        metadata: { user_id: '42' },
      },
    ]);

    await startDurableWebhookWorker();
    await jest.advanceTimersByTimeAsync(0);

    expect(mockGetEventsSince).toHaveBeenCalledWith(2, 100);
    expect(mockAdvanceWebhookCursor).toHaveBeenNthCalledWith(1, 'crm', 3);
    expect(mockAdvanceWebhookCursor).toHaveBeenNthCalledWith(2, 'crm', 4);
    expect(mockPost).toHaveBeenCalledTimes(1);

    const [url, rawBody, options] = mockPost.mock.calls[0];
    expect(url).toBe('https://durable.test/hook');
    expect(JSON.parse(rawBody)).toMatchObject({
      event: 'ticket.closed',
      event_id: 'evt-4',
      seq: 4,
      ticket_id: 42,
      user_id: '42',
      agent_id: 'agent1',
    });
    expect(options.headers['X-TSB-Event-ID']).toBe('evt-4');
    expect(options.headers['X-TSB-Event-Seq']).toBe('4');
    expect(options.headers['X-TSB-Delivery']).toBe('durable');
    expect(options.headers['X-TSB-Signature']).toEqual(expect.any(String));
  });

  it('does not advance a durable cursor when selected delivery fails', async () => {
    jest.useFakeTimers();
    cache.config.webhooks = [{
      id: 'crm',
      url: 'https://durable.test/hook',
      events: ['ticket.closed'],
      durable: true,
    }] as any;
    mockInitializeWebhookCursor.mockResolvedValue(0);
    mockGetEventsSince.mockResolvedValueOnce([{
      event_id: 'evt-1',
      seq: 1,
      type: 'ticket.closed',
      ticketId: 42,
      timestamp: new Date('2026-09-18T08:00:00Z'),
      agent_id: null,
      metadata: {},
    }]);
    mockPost.mockRejectedValueOnce(new Error('endpoint down'));

    await startDurableWebhookWorker();
    await jest.advanceTimersByTimeAsync(0);

    expect(mockAdvanceWebhookCursor).not.toHaveBeenCalled();
    expect(mockLogError).toHaveBeenCalledWith(
      'Durable webhook failed for crm:',
      expect.any(Error),
    );
  });

  it('derives a stable fallback subscriber id from the URL', () => {
    const webhook = {
      url: 'https://durable.test/hook',
      events: ['ticket.closed'],
      durable: true,
    } as any;

    expect(getDurableWebhookSubscriberId(webhook)).toBe(
      getDurableWebhookSubscriberId({ ...webhook }),
    );
    expect(getDurableWebhookSubscriberId({ ...webhook, id: ' explicit ' } as any))
      .toBe('explicit');
  });
});
