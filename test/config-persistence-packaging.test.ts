import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as YAML from 'yaml';
const {prepare, check} = require('../deploy/vm3902/prepare-config.cjs');
const {validate} = require('../deploy/vm3902/check-runtime.cjs');

describe('private persistent configuration installation', () => {
  let directory: string;
  beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'config-package-')); });
  afterEach(() => { fs.rmSync(directory, {recursive: true, force: true}); });
  test('dry run, exact byte preservation, atomic rename and refusal to overwrite edited YAML', () => {
    const source = path.join(directory, 'source.yaml');
    const target = path.join(directory, 'persistent-config');
    const raw = '# synthetic only\nowner_id: 101\nstaff_roles: [{telegram_id: "101", role: admin}]\nteam_settings_history: []\n';
    fs.writeFileSync(source, raw, {mode: 0o600});
    const uid = process.getuid!(), gid = process.getgid!();
    prepare(source, target, true, uid, gid);
    expect(fs.existsSync(target)).toBe(false);
    prepare(source, target, false, uid, gid);
    expect(fs.readFileSync(path.join(target, 'config.yaml'), 'utf8')).toBe(raw);
    check(target, uid, gid);
    // Real FS rename: demonstrates package compatibility, not PR #51 callback evidence.
    fs.writeFileSync(path.join(target, '.synthetic.tmp'), raw + 'synthetic_version: 2\n', {mode: 0o600});
    fs.renameSync(path.join(target, '.synthetic.tmp'), path.join(target, 'config.yaml'));
    expect(() => prepare(source, target, false, uid, gid)).toThrow('Destination exists');
    expect(YAML.parse(fs.readFileSync(path.join(target, 'config.yaml'), 'utf8')).synthetic_version).toBe(2);
    fs.chmodSync(target, 0o755);
    expect(() => check(target, uid, gid)).toThrow('permissions');
  });
  test('rejects invalid YAML, public sources and symlinks', () => {
    const source = path.join(directory, 'source.yaml');
    const target = path.join(directory, 'persistent-config');
    const uid = process.getuid!(), gid = process.getgid!();
    fs.writeFileSync(source, 'staff_roles: []\nstaff_roles: []\n', {mode: 0o600});
    expect(() => prepare(source, target, true, uid, gid)).toThrow('Invalid configuration');
    fs.writeFileSync(source, 'staff_roles: []\n');
    fs.chmodSync(source, 0o644);
    expect(() => prepare(source, target, true, uid, gid)).toThrow('private regular');
    fs.chmodSync(source, 0o600);
    fs.symlinkSync(source, source + '.link');
    expect(() => prepare(source + '.link', target, true, uid, gid)).toThrow('private regular');
    expect(fs.existsSync(target)).toBe(false);
  });
  test('rejects generated override regressions including nested file binds', () => {
    const model = YAML.parse(fs.readFileSync(path.resolve(__dirname, '../deploy/vm3902/compose.yaml'), 'utf8'));
    const bot = model.services.supportbot;
    bot.volumes[0].source = path.join(directory, 'persistent-config');
    expect(() => validate(model, bot.volumes[0].source)).not.toThrow();
    for (const mutation of [
      (b: any) => { b.volumes.push({type: 'bind', source: '/tmp/file', target: '/bot/config/config.yaml'}); },
      (b: any) => { b.volumes[0].read_only = true; },
      (b: any) => { b.volumes[0].bind.create_host_path = true; },
      (b: any) => { b.read_only = false; },
      (b: any) => { b.user = '0:0'; },
      (b: any) => { b.scale = 2; },
    ]) {
      const copy = structuredClone(model);
      mutation(copy.services.supportbot);
      expect(() => validate(copy, bot.volumes[0].source)).toThrow('Unsafe');
    }
  });
});
