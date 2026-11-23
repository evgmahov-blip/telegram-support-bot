// Run only against a committed candidate. Never starts the bot or Compose stack.
const {spawnSync} = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const [sha, output] = process.argv.slice(2);
if (!/^[a-f0-9]{40}$/.test(sha || '') || !output) {
  console.error('Usage: node scripts/docker-validation.cjs <full-commit-sha> <output-directory>');
  process.exit(2);
}
const destination = path.resolve(output);
fs.mkdirSync(destination, {recursive: true});
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'support-bot-validation-'));
const context = path.join(temporary, 'source');
fs.mkdirSync(context);
const result = {schema: 'support-bot.docker-validation.v1', sha, status: 'failed',
  started_at: new Date().toISOString(), steps: [], images: {}};
const images = [];
function run(name, command, args, options = {}) {
  const log = path.join(destination, `${name}.log`);
  const fd = fs.openSync(log, 'w');
  let execution;
  try {
    execution = spawnSync(command, args, {cwd: context, stdio: ['ignore', fd, fd],
      timeout: 30 * 60 * 1000, ...options});
  } finally { fs.closeSync(fd); }
  result.steps.push({name, exit_code: execution.status, error: execution.error?.message || null});
  if (execution.error || execution.status !== 0) throw new Error(`${name} failed; see ${log}`);
  return fs.readFileSync(log, 'utf8').trim();
}
try {
  // Archive exactly the reviewed commit: no node_modules, generated config, or dirty files.
  const archive = path.join(temporary, 'source.tar');
  run('archive', 'git', ['archive', '--format=tar', `--output=${archive}`, sha], {cwd: process.cwd()});
  run('extract', 'tar', ['-xf', archive, '-C', context]);
  run('docker-version', 'docker', ['version']);
  const suffix = `${sha.slice(0, 12)}-${process.pid}`;
  const tests = `support-bot-validation-tests:${suffix}`;
  images.push(tests);
  run('test-build', 'docker', ['build', '--pull', '--no-cache', '-f', 'docker/Dockerfile.ci', '-t', tests, '.']);
  run('regressions', 'docker', ['run', '--rm', '--network=none', tests]);
  const production = `support-bot-validation-runtime:${suffix}`;
  images.push(production);
  run('production-build', 'docker', ['build', '--pull', '--no-cache', '-t', production, '.']);
  for (const [kind, tag] of [['tests', tests], ['production', production]]) {
    result.images[kind] = run(`inspect-${kind}`, 'docker', ['image', 'inspect', '--format={{.Id}}', tag]);
  }
  const smoke = "const assert = require('node:assert/strict'); assert.equal(process.versions.node.split('.')[0], '24'); require('yaml'); require('mongoose'); require('grammy'); require('better-sqlite3'); require('./build/logger').error('readonly-smoke');";
  const smokeOutput = run('runtime-smoke', 'docker', ['run', '--rm', '--network=none', '--read-only',
    '--cap-drop=ALL', '--security-opt=no-new-privileges', '--user=65534:65534',
    '--mount', `type=bind,src=${path.join(context, 'deploy/vm3902/config-sample.yaml')},dst=/bot/config/config.yaml,readonly`,
    '--entrypoint=node', production, '-e', smoke]);
  if (!smokeOutput.includes('readonly-smoke')) throw new Error('Runtime ERROR log missing');
  result.status = 'passed';
} catch (error) {
  result.error = error.message;
  process.exitCode = 1;
} finally {
  for (let i = 0; i < images.length; i++) {
    try { run(`cleanup-image-${i}`, 'docker', ['image', 'rm', images[i]]); }
    catch (error) { result.cleanup_error = error.message; result.status = 'failed'; process.exitCode = 1; }
  }
  fs.rmSync(temporary, {recursive: true, force: true});
  result.finished_at = new Date().toISOString();
  fs.writeFileSync(path.join(destination, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(`${result.status}: ${path.join(destination, 'result.json')}`);
}
