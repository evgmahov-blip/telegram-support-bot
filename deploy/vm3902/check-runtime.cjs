// Checks the rendered model, including every explicitly supplied override.
const {execFileSync} = require('node:child_process');
const path = require('node:path');
const {check} = require('./prepare-config.cjs');
function validate(model, directory) {
  const bot = model.services.supportbot;
  const mounts = bot.volumes || [];
  const config = mounts.filter(v => v.target === '/bot/config');
  if (!bot.read_only || bot.user !== '1000:1000' || Number(bot.scale ?? 1) !== 1 ||
      !bot.cap_drop?.includes('ALL') || !bot.security_opt?.includes('no-new-privileges:true') ||
      mounts.length !== 1 || Number(bot.deploy?.replicas ?? 1) !== 1 || bot.privileged === true ||
      config.length !== 1 || config[0].type !== 'bind' || config[0].read_only === true ||
      path.resolve(config[0].source) !== path.resolve(directory) || config[0].bind?.create_host_path !== false ||
      mounts.some(v => v.target.startsWith('/bot/config/')) || mounts.some(v => v.target.includes('docker.sock'))) {
    throw new Error('Unsafe rendered supportbot configuration');
  }
}
module.exports = {validate};
if (require.main === module) {
  try {
    const [directory, ...args] = process.argv.slice(2);
    if (!directory || !args.length) throw new Error('Usage: node check-runtime.cjs DIRECTORY COMPOSE_GLOBAL_ARGS...');
    check(directory);
    const model = JSON.parse(execFileSync('docker', ['compose', ...args, 'config', '--format', 'json'], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']}));
    validate(model, directory);
    console.log('Rendered model and private config validated (values omitted)');
  } catch (_) { console.error('Runtime validation failed; no config values emitted'); process.exitCode = 1; }
}
