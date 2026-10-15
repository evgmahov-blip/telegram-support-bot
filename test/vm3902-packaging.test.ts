import * as fs from 'fs';
import * as path from 'path';
import * as YAML from 'yaml';

const root = path.resolve(__dirname, '..');
const read = (relative: string): string => fs.readFileSync(path.join(root, relative), 'utf8');

describe('VM3902 deployment packaging', () => {
  test('ships a non-secret runtime template with fixed identity and safety controls', () => {
    const samplePath = path.join(root, 'deploy/vm3902/config-sample.yaml');
    expect(fs.existsSync(samplePath)).toBe(true);
    const raw = fs.readFileSync(samplePath, 'utf8');
    const config = YAML.parse(raw);

    expect(config.bot_token).toBe('YOUR_BOT_TOKEN');
    expect(raw).not.toMatch(/\b\d{6,12}:[A-Za-z0-9_-]{20,}\b/);
    expect(String(config.owner_id)).toBe('79813552');
    expect(String(config.staffchat_id)).toBe('-1003918239593');
    expect(config.staff_roles).toEqual([{telegram_id: '79813552', role: 'admin'}]);
    expect(raw).not.toContain('468422');
    expect(raw).not.toContain('234031728');
    expect(config).toMatchObject({
      allow_private: false,
      direct_reply: false,
      anonymous_tickets: true,
      anonymous_replies: true,
      show_user_ticket: false,
      spam_cant_msg: 5,
      spam_time: 300000,
      auto_close_tickets: false,
      allow_broadcast: false,
      enable_csat: false,
      use_llm: false,
      auto_triage: false,
      staff_assist: false,
      translate_enabled: false,
      signal_enabled: false,
      slack_enabled: false,
      discord_enabled: false,
      autoreply_confirmation: false,
      show_auto_replied: false,
      web_server: false,
      api_enabled: false,
      api_port: 8081,
      log_level: 'ERROR',
      dev_mode: false,
    });
    expect(config.autoreply).toEqual([]);
    expect(config.webhooks).toEqual([]);
  });

  test('mounts ignored runtime config and preserves fail-closed network boundaries', () => {
    const compose = read('deploy/vm3902/compose.yaml');
    const ignore = read('.gitignore');

    expect(ignore).toMatch(/(^|\n)config\.yaml\r?($|\n)/);
    expect(compose).toContain('./config.yaml:/bot/config/config.yaml:ro');
    expect(compose).not.toContain('config-sample.yaml:/bot/config/config.yaml');
    expect(compose).toContain('ipv4_address: 172.31.109.3');
    expect(compose).toContain('- 172.31.109.1');
    expect(compose).toContain('most_mongo:\n    internal: true');
    expect(compose).not.toMatch(/mongodb:[\s\S]*?ports:/);
    expect(compose).toContain('127.0.0.1:8080:8080');
    expect(compose).toContain('127.0.0.1:8081:8081');
    expect(compose).not.toMatch(/HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|SOCKS/i);
    expect((compose.match(/restart: "no"/g) || [])).toHaveLength(2);
  });

  test('keeps Mongo healthcheck credentials out of argv and requires authenticated ping', () => {
    const compose = YAML.parse(read('deploy/vm3902/compose.yaml'));
    const healthcheck = compose.services.mongodb.healthcheck.test;

    expect(healthcheck.slice(0, 4)).toEqual(['CMD', 'mongosh', '--quiet', '--eval']);
    expect(healthcheck).toHaveLength(5);

    const javascript = healthcheck[4];
    expect(javascript).toContain('process.env.MONGO_INITDB_ROOT_USERNAME');
    expect(javascript).toContain('process.env.MONGO_INITDB_ROOT_PASSWORD');
    expect(javascript).toContain("db.getSiblingDB('admin')");
    expect(javascript).toContain('admin.auth(');
    expect(javascript).toContain('admin.runCommand({ ping: 1 })');
    expect(javascript).not.toMatch(/\$(?:\$)?\{?MONGO_INITDB_ROOT_(?:USERNAME|PASSWORD)\}?/);
    expect(healthcheck.slice(0, 4).join(' ')).not.toMatch(/--username|--password|mongodb:\/\//);

    const credentials = {
      MONGO_INITDB_ROOT_USERNAME: 'health user $HOME',
      MONGO_INITDB_ROOT_PASSWORD: 'dummy "quoted" $(not-a-command) ; &',
    };
    const execute = new Function('db', 'process', 'quit', javascript);
    const runProbe = (authResult: boolean, pingResult: number) => {
      const auth = jest.fn(() => authResult);
      const runCommand = jest.fn(() => ({ok: pingResult}));
      let exitCode: number | undefined;
      const quit = jest.fn((code: number) => {
        exitCode = code;
        throw new Error(`mongosh quit ${code}`);
      });

      expect(() => execute(
        {getSiblingDB: jest.fn(() => ({auth, runCommand}))},
        {env: credentials},
        quit,
      )).toThrow(`mongosh quit ${authResult && pingResult === 1 ? 0 : 1}`);

      return {auth, runCommand, exitCode};
    };

    const healthy = runProbe(true, 1);

    expect(healthy.auth).toHaveBeenCalledWith({
      user: credentials.MONGO_INITDB_ROOT_USERNAME,
      pwd: credentials.MONGO_INITDB_ROOT_PASSWORD,
    });
    expect(healthy.runCommand).toHaveBeenCalledWith({ping: 1});
    expect(healthy.exitCode).toBe(0);

    const rejectedAuth = runProbe(false, 1);
    expect(rejectedAuth.runCommand).not.toHaveBeenCalled();
    expect(rejectedAuth.exitCode).toBe(1);

    const failedPing = runProbe(true, 0);
    expect(failedPing.runCommand).toHaveBeenCalledWith({ping: 1});
    expect(failedPing.exitCode).toBe(1);
  });

  test('pins Node 24 and leaves restart supervision behind systemd prerequisites', () => {
    const dockerfile = read('Dockerfile');
    const unit = read('deploy/vm3902/most-support-bot.service');
    const expectedBase = 'node:24.15.0-alpine3.22@sha256:b689d4005875ae167178471a7a622ec2909459a3bbb32277260be1971af7a99f';

    expect((dockerfile.match(new RegExp(expectedBase, 'g')) || [])).toHaveLength(2);
    expect(unit).toContain('Requires=docker.service tg-support-firewall.service tg-support-dns.service');
    expect(unit).toContain('After=network-online.target docker.service tg-support-firewall.service tg-support-dns.service');
    expect(unit).toContain('up --abort-on-container-failure');
    expect(unit).toContain('Restart=on-failure');
  });
});
