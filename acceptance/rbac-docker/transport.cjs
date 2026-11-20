// Synthetic transport only. Business routes, permissions, YAML writer and Mongo are real.
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const YAML = require('yaml');
const { Bot } = require('grammy');
const info = { id: 999001, is_bot: true, first_name: 'Synthetic', username: 'synthetic_lab_bot', can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false };
Bot.prototype.init = async function () { this.botInfo = info; };
const boot = crypto.randomUUID();
let calls = [];
async function main() {
  const db = require('/bot/build/db');
  await db.connect();
  await require('/bot/build/team').initStaffCache();
  const addon = require('/bot/build/addons/telegram').default.getInstance('999001:SYNTHETIC_ONLY');
  addon.bot.api.config.use(async (_previous, method, payload) => {
    calls.push({ method, payload });
    return { ok: true, result: method === 'getMe' ? info : method === 'answerCallbackQuery' ? true : {
      message_id: 100, date: 1, chat: { id: Number(payload.chat_id || 101), type: 'private' }, text: payload.text || '',
    } };
  });
  // Register the actual addon middleware and handlers, without long polling Telegram.
  addon.bot.start = async () => {};
  addon.start();
  http.createServer(async (req, res) => {
    try {
      if (req.method === 'POST' && req.url === '/update') {
        let body = ''; for await (const part of req) body += part;
        calls = [];
        await addon.bot.handleUpdate(JSON.parse(body));
        res.end(JSON.stringify({ calls }));
      } else if (req.url === '/state') {
        const raw = fs.readFileSync('/bot/config/config.yaml', 'utf8');
        const value = YAML.parse(raw);
        const cache = require('/bot/build/cache').default;
        res.end(JSON.stringify({ boot, node: process.version,
          etag: crypto.createHash('sha256').update(raw).digest('hex').slice(0, 24),
          value, runtime: [...cache.staffMembers.values()] }));
      } else { res.statusCode = 404; res.end(); }
    } catch (_) { res.statusCode = 500; res.end(JSON.stringify({ error: 'synthetic_update_failed' })); }
  }).listen(8099, '0.0.0.0');
}
main().catch(() => { console.error('Synthetic harness boot failed'); process.exit(1); });

