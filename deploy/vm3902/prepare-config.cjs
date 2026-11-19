// Offline, non-root installation only. Never called by container startup.
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
function validate(raw) {
  const doc = YAML.parseDocument(raw, { uniqueKeys: true });
  if (doc.errors.length || !doc.toJS() || !Array.isArray(doc.toJS().staff_roles)) {
    throw new Error('Invalid configuration: expected YAML mapping with staff_roles');
  }
}
function check(directory, uid = 1000, gid = 1000) {
  for (const [file, mode, directoryExpected] of [[directory, 0o700, true], [path.join(directory, 'config.yaml'), 0o600, false]]) {
    const s = fs.lstatSync(file);
    if (s.isSymbolicLink() || s.isDirectory() !== directoryExpected || (!directoryExpected && !s.isFile()) ||
        s.uid !== uid || s.gid !== gid || (s.mode & 0o777) !== mode) throw new Error('Unsafe config ownership, type or permissions');
  }
  const entries = fs.readdirSync(directory);
  if (entries.some(n => n !== 'config.yaml' && n !== 'debug.log')) throw new Error('Unexpected file or active/stale writer lock; stop and investigate');
  if (entries.includes('debug.log')) {
    const log = fs.lstatSync(path.join(directory, 'debug.log'));
    if (!log.isFile() || log.isSymbolicLink() || log.uid !== uid || log.gid !== gid || (log.mode & 0o077)) throw new Error('Unsafe debug log');
  }
  validate(fs.readFileSync(path.join(directory, 'config.yaml'), 'utf8'));
}
function prepare(source, directory, dryRun = false, uid = 1000, gid = 1000) {
  if (process.getuid() === 0 || process.getuid() !== uid || process.getgid() !== gid) throw new Error('Run as the unprivileged container UID/GID (1000:1000)');
  const s = fs.lstatSync(source);
  if (!s.isFile() || s.isSymbolicLink() || (s.mode & 0o077)) throw new Error('Source must be a private regular file');
  const raw = fs.readFileSync(source);
  validate(raw.toString('utf8'));
  if (fs.existsSync(directory)) throw new Error('Destination exists; never overwrite persisted settings');
  if (dryRun) return;
  fs.mkdirSync(directory, { mode: 0o700 }); // exclusive: a second installer must fail
  try {
    const fd = fs.openSync(path.join(directory, 'config.yaml'), 'wx', 0o600);
    try { fs.writeFileSync(fd, raw); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    for (const dir of [directory, path.dirname(path.resolve(directory))]) {
      const fd = fs.openSync(dir, 'r');
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    }
    check(directory, uid, gid);
  } catch (e) {
    // Preserve failed installation for inspection; never overwrite it on retry.
    throw e;
  }
}
module.exports = {prepare, check};
if (require.main === module) {
  try {
    const [action, source, destination, ...extra] = process.argv.slice(2);
    if (extra.length) throw new Error('Too many arguments');
    if (action === 'check' && source && !destination) check(source);
    else if (['install', 'dry-run'].includes(action) && source && destination) prepare(source, destination, action === 'dry-run');
    else throw new Error('Usage: node prepare-config.cjs install|dry-run SOURCE DESTINATION; or check DIRECTORY');
    console.log('Configuration check completed (values omitted)');
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
