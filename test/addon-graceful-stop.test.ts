const mockAxiosClient = {
  get: jest.fn(),
  post: jest.fn(),
  put: jest.fn(),
  delete: jest.fn(),
};

jest.mock('axios', () => ({
  __esModule: true,
  default: { create: jest.fn(() => mockAxiosClient) },
}));

jest.mock('../src/cache', () => ({
  __esModule: true,
  default: {
    config: {
      signal_enabled: true,
      signal_number: '+10000000000',
      signal_host: 'signal.test:40153',
      slack_enabled: true,
      slack_bot_token: 'slack-token',
      slack_channel_id: 'C123',
      discord_enabled: true,
      discord_bot_token: 'discord-token',
      discord_channel_id: '12345678901234567',
    },
  },
}));

jest.mock('../src/handlers', () => ({ registerCommonHandlers: jest.fn() }));
jest.mock('../src/db', () => ({}));
jest.mock('../src/logger', () => ({ info: jest.fn(), error: jest.fn() }));

import SignalAddon from '../src/addons/signal';
import SlackAddon from '../src/addons/slack';
import DiscordAddon from '../src/addons/discord';

async function expectStopDrains(addon: any, withHeartbeat = false): Promise<void> {
  addon.stopping = false;
  addon.started = true;

  addon.scheduleReconnect(60_000);
  expect(addon.reconnectTimer).not.toBeNull();

  if (withHeartbeat) {
    addon.startHeartbeat(60_000);
    expect(addon.heartbeatTimer).not.toBeNull();
  }

  const close = jest.fn();
  const terminate = jest.fn();
  addon.ws = { readyState: 1, close, terminate };

  let release!: () => void;
  addon.inFlight.track(new Promise<void>((resolve) => { release = resolve; }), jest.fn());

  let settled = false;
  const stopping = addon.stop().then(() => { settled = true; });
  await Promise.resolve();

  expect(addon.stopping).toBe(true);
  expect(addon.reconnectTimer).toBeNull();
  if (withHeartbeat) expect(addon.heartbeatTimer).toBeNull();
  expect(close).toHaveBeenCalledTimes(1);
  expect(settled).toBe(false);

  // A close/error callback racing after stop must not schedule resurrection.
  addon.scheduleReconnect(60_000);
  expect(addon.reconnectTimer).toBeNull();

  release();
  await stopping;
  expect(settled).toBe(true);
}

describe('non-Telegram addon graceful stop', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('stops Signal reconnects and drains accepted work', async () => {
    await expectStopDrains(SignalAddon.getInstance() as any);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('stops Slack reconnects and drains accepted work', async () => {
    await expectStopDrains(SlackAddon.getInstance() as any);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('stops Discord reconnects, clears heartbeat and drains accepted work', async () => {
    await expectStopDrains(DiscordAddon.getInstance() as any, true);
    expect(jest.getTimerCount()).toBe(0);
  });
});
