const handlers: Record<string, (req: any, res: any) => any> = {};
const close = jest.fn((cb: (err?: Error) => void) => cb());
const listen = jest.fn((_port: number, _host: string, cb: () => void) => {
  cb();
  return { close };
});
const app = {
  disable: jest.fn(),
  get: jest.fn((path: string, handler: (req: any, res: any) => any) => {
    handlers[path] = handler;
  }),
  listen,
};

jest.mock('express', () => jest.fn(() => app));

const getEventsSince = jest.fn();
jest.mock('../src/db', () => ({ getEventsSince }));
jest.mock('../src/logger', () => ({ info: jest.fn(), error: jest.fn() }));
jest.mock('../src/cache', () => ({
  config: {
    api_enabled: true,
    api_token: 'test-secret',
    api_port: 8080,
  },
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

  afterEach(async () => {
    await stopEventsApi();
  });

  it('rejects missing bearer authentication', async () => {
    const res = response();

    await handlers['/events']({ headers: {}, query: {} }, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(getEventsSince).not.toHaveBeenCalled();
  });

  it('returns ordered replay events and next_since', async () => {
    getEventsSince.mockResolvedValue([
      {
        event_id: 'event-11',
        seq: 11,
        type: 'ticket.message.user',
        ticketId: 7,
        agent_id: '123',
        timestamp: new Date('2026-09-17T12:00:00Z'),
        metadata: {},
      },
      {
        event_id: 'event-12',
        seq: 12,
        type: 'ticket.priority_changed',
        ticketId: 7,
        agent_id: 'agent-1',
        timestamp: new Date('2026-09-17T12:01:00Z'),
        metadata: { to: 'high' },
      },
    ]);
    const res = response();

    await handlers['/events']({
      headers: { authorization: 'Bearer test-secret' },
      query: { since: '10', limit: '20' },
    }, res);

    expect(getEventsSince).toHaveBeenCalledWith(10, 20);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      events: [
        expect.objectContaining({ event_id: 'event-11', seq: 11, ticket_id: 7 }),
        expect.objectContaining({ event_id: 'event-12', seq: 12, ticket_id: 7 }),
      ],
      next_since: 12,
    });
  });
});
