const mockDisconnect = jest.fn().mockResolvedValue(undefined);
const mockStopEventsApi = jest.fn().mockResolvedValue(undefined);
const mockDrainWebhooks = jest.fn().mockResolvedValue(undefined);

jest.mock('mongoose', () => ({
  __esModule: true,
  default: {
    connection: { readyState: 1 },
    disconnect: mockDisconnect,
  },
}));

jest.mock('../src/events-api', () => ({
  stopEventsApi: mockStopEventsApi,
}));

jest.mock('../src/webhooks', () => ({
  drainWebhooks: mockDrainWebhooks,
}));

jest.mock('../src/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
}));

import { createGracefulShutdown } from '../src/lifecycle';

describe('graceful shutdown', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('stops ingress, clears timers, drains webhooks, closes HTTP and disconnects Mongo once', async () => {
    const order: string[] = [];
    const stop = jest.fn().mockImplementation(async () => { order.push('stop'); });
    mockDrainWebhooks.mockImplementationOnce(async () => { order.push('webhooks'); });
    mockStopEventsApi.mockImplementationOnce(async () => { order.push('events-api'); });
    mockDisconnect.mockImplementationOnce(async () => { order.push('mongo'); });

    const timer = setTimeout(() => {}, 60_000);
    const interval = setInterval(() => {}, 60_000);
    const timers = new Set<any>([timer, interval]);
    const shutdown = createGracefulShutdown([{ stop } as any], timers);

    await Promise.all([shutdown('SIGTERM'), shutdown('SIGINT')]);

    expect(stop).toHaveBeenCalledTimes(1);
    expect(mockDrainWebhooks).toHaveBeenCalledTimes(1);
    expect(mockStopEventsApi).toHaveBeenCalledTimes(1);
    expect(mockDisconnect).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['stop', 'webhooks', 'events-api', 'mongo']);
    expect(timers.size).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('continues closing shared resources when an addon stop fails', async () => {
    const stopError = new Error('stop failed');
    const stop = jest.fn().mockRejectedValue(stopError);
    const shutdown = createGracefulShutdown([{ stop } as any]);

    await expect(shutdown('SIGTERM')).rejects.toThrow('1 error');
    expect(mockDrainWebhooks).toHaveBeenCalledTimes(1);
    expect(mockStopEventsApi).toHaveBeenCalledTimes(1);
    expect(mockDisconnect).toHaveBeenCalledTimes(1);
  });
});
