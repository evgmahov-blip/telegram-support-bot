const handlers: Record<string, (req: any, res: any) => any> = {};
const close = jest.fn((cb: (err?: Error) => void) => cb());
const listen = jest.fn((_port: number, _host: string, cb: () => void) => {
  cb();
  return { close };
});
const app = {
  disable: jest.fn(),
  use: jest.fn(),
  get: jest.fn((path: string, handler: (req: any, res: any) => any) => { handlers[path] = handler; }),
  listen,
};

jest.mock('express', () => jest.fn(() => app));
const limiter = jest.fn((_req: any, _res: any, next: () => void) => next());
jest.mock('express-rate-limit', () => ({ rateLimit: jest.fn(() => limiter) }));
const getEventsSince = jest.fn();
jest.mock('../src/db', () => ({ getEventsSince }));
jest.mock('../src/logger', () => ({ info: jest.fn(), error: jest.fn() }));
jest.mock('../src/cache', () => ({
  config: { api_enabled: true, api_token: 'test-secret', api_port: 8081, api_host: '127.0.0.1' },
}));

import { startEventsApi, stopEventsApi } from '../src/events-api';

function response() {
  const res: any = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

describe('event replay API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Object.keys(handlers).forEach((key) => delete handlers[key]);
    startEventsApi();
  });
  afterEach(async () => { await stopEventsApi(); });

  it('binds configured host and dedicated port', () => {
    expect(listen).toHaveBeenCalledWith(8081, '127.0.0.1', expect.any(Function));
  });

  it('rejects missing bearer auth', async () => {
    const res = response();
    await handlers['/events']({ headers: {}, query: {} }, res);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(getEventsSince).not.toHaveBeenCalled();
  });

  it('returns exact has_more using one look-ahead row', async () => {
    getEventsSince.mockResolvedValue([
      { event_id: 'event-11', seq: 11, type: 'ticket.message.user', ticketId: 7, agent_id: '123', timestamp: new Date('2026-09-17T12:00:00Z'), metadata: {} },
      { event_id: 'event-12', seq: 12, type: 'ticket.priority_changed', ticketId: 7, agent_id: 'agent-1', timestamp: new Date('2026-09-17T12:01:00Z'), metadata: { to: 'high' } },
      { event_id: 'event-13', seq: 13, type: 'ticket.closed', ticketId: 7, agent_id: 'agent-1', timestamp: new Date('2026-09-17T12:02:00Z'), metadata: {} },
    ]);
    const res = response();
    await handlers['/events']({ headers: { authorization: 'Bearer test-secret' }, query: { since: '10', limit: '2' } }, res);
    expect(getEventsSince).toHaveBeenCalledWith(10, 3);
    expect(res.json).toHaveBeenCalledWith({
      events: [
        expect.objectContaining({ event_id: 'event-11', seq: 11, ticket_id: 7 }),
        expect.objectContaining({ event_id: 'event-12', seq: 12, ticket_id: 7 }),
      ],
      next_since: 12,
      has_more: true,
    });
  });
});
