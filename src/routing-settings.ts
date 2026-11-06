import * as fs from 'fs/promises';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import * as YAML from 'yaml';
import * as team from './team';
import cache from './cache';
import * as db from './db';
import * as log from './logger';
import { validateSchedule, validateRoutingPolicy } from './routing-policy';
import type { BusinessHoursConfig } from './interfaces';

export type SettingField = 'acceptance_minutes' | 'reminder_before_minutes' | 'schedule' | 'timezone';
interface SettingChange { id: string; actor: string; at: string; field: SettingField; before: unknown; after: unknown; }
export interface SettingsSnapshot {
  etag: string; acceptance_minutes: number; reminder_before_minutes: number | null;
  schedule: BusinessHoursConfig | null; history: SettingChange[];
}
const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 24);
const requireAdmin = (actor: string) => { if (!team.canPerformAction(actor, 'manage_team')) throw new Error('settings_forbidden'); };
/** The existing YAML file stays the only configuration source. No settings database or environment-secret editor. */
export async function readRoutingSettings(actor: string, file = './config/config.yaml'): Promise<SettingsSnapshot> {
  requireAdmin(actor);
  const raw = await fs.readFile(file, 'utf8'), value = YAML.parse(raw) ?? {};
  return { etag: hash(raw), acceptance_minutes: value.routing?.acceptance_minutes ?? 10,
    reminder_before_minutes: value.routing?.reminder_before_minutes ?? null,
    schedule: value.web_chat?.business_hours ?? null, history: Array.isArray(value.routing_settings_history) ? value.routing_settings_history : [] };
}
function checkedValue(field: SettingField, input: unknown, current: SettingsSnapshot): unknown {
  if (field === 'schedule') return validateSchedule(input as BusinessHoursConfig);
  if (field === 'timezone') {
    if (typeof input !== 'string' || input.length > 48) throw new Error('invalid_timezone');
    new Intl.DateTimeFormat('en', { timeZone: input }).format(0); return input;
  }
  const minutes = field === 'acceptance_minutes' ? input : current.acceptance_minutes;
  const reminder = field === 'reminder_before_minutes' ? input : current.reminder_before_minutes;
  // A missing real schedule cannot be invented merely to validate the independent minute inputs.
  validateRoutingPolicy({ acceptance_minutes: minutes as number, reminder_before_minutes: reminder as number | null,
    schedule: { enabled: false, start: '', end: '', timezone: 'UTC' } });
  return input;
}
export async function saveRoutingSetting(actor: string, etag: string, field: SettingField, input: unknown,
  file = './config/config.yaml'): Promise<SettingsSnapshot> {
  requireAdmin(actor);
  if (!['acceptance_minutes','reminder_before_minutes','schedule','timezone'].includes(field)) throw new Error('settings_field_denied');
  if (!/^[0-9a-f]{24}$/.test(etag)) throw new Error('settings_stale');
  const operationId = hash(JSON.stringify([actor, etag, field, input]));
  const beforeLock = await readRoutingSettings(actor, file);
  if (beforeLock.history.some(h => h.id === operationId && h.actor === actor)) return beforeLock;
  const lockPath = file + '.routing-lock';
  let lock;
  try { lock = await fs.open(lockPath, 'wx', 0o600); } catch { throw new Error('settings_busy'); }
  let temp: string | null = null;
  try {
    const current = await readRoutingSettings(actor, file);
    if (current.etag !== etag) throw new Error('settings_stale');
    const next = checkedValue(field, input, current);
    const raw = await fs.readFile(file, 'utf8');
    if (hash(raw) !== etag) throw new Error('settings_stale');
    const doc = YAML.parseDocument(raw);
    if (doc.errors.length) throw new Error('settings_yaml_invalid');
    const settingPath = field === 'schedule' ? ['web_chat','business_hours'] : field === 'timezone'
      ? ['web_chat','business_hours','timezone'] : ['routing',field];
    const oldValue = doc.getIn(settingPath, true);
    const storedBefore = oldValue && typeof (oldValue as any).toJSON === 'function' ? (oldValue as any).toJSON() : oldValue ?? null;
    const before = field === 'acceptance_minutes' ? current.acceptance_minutes
      : field === 'reminder_before_minutes' ? current.reminder_before_minutes : storedBefore;
    doc.setIn(settingPath, next);
    const history = [...current.history, { id: operationId, actor, at: new Date().toISOString(), field, before, after: next }];
    doc.set('routing_settings_history', history);
    // Sibling temp + atomic rename; file mode is preserved and the parent directory is fsynced.
    const stat = await fs.stat(file);
    temp = path.join(path.dirname(file), '.routing-' + randomUUID() + '.tmp');
    const out = await fs.open(temp, 'wx', stat.mode & 0o777);
    try { await out.writeFile(String(doc)); await out.sync(); } finally { await out.close(); }
    requireAdmin(actor); // Revalidate at the actual write boundary.
    if (hash(await fs.readFile(file, 'utf8')) !== etag) throw new Error('settings_stale');
    await fs.rename(temp, file); temp = null;
    const dir = await fs.open(path.dirname(file), 'r');
    try { await dir.sync(); } finally { await dir.close(); }
    const result = await readRoutingSettings(actor, file);
    // Runtime projection updates only after durable persistence; existing offers keep their own snapshot.
    cache.config.routing = { acceptance_minutes: result.acceptance_minutes, reminder_before_minutes: result.reminder_before_minutes };
    if (result.schedule) cache.config.web_chat = { ...cache.config.web_chat, business_hours: result.schedule };
    await flushRoutingSettingsAudit(file).catch(err => log.error('Routing settings audit remains pending:', err));
    return result;
  } finally {
    if (temp) await fs.unlink(temp).catch(() => undefined);
    await lock.close(); await fs.unlink(lockPath);
  }
}

/** Recovery reads the same YAML outbox; stable event IDs make repeated appends idempotent. */
export async function flushRoutingSettingsAudit(file='./config/config.yaml'): Promise<void> {
  if (typeof db.recordRoutingSettingsEvent !== 'function') return;
  let value:any;
  try { value=YAML.parse(await fs.readFile(file,'utf8')); }
  catch(err) { if((err as NodeJS.ErrnoException).code==='ENOENT')return;throw err; }
  for(const h of Array.isArray(value?.routing_settings_history)?value.routing_settings_history:[]) {
    if(!h || !/^[0-9a-f]{24}$/.test(h.id) || typeof h.actor!=='string'
      || !['acceptance_minutes','reminder_before_minutes','schedule','timezone'].includes(h.field)) throw new Error('settings_audit_invalid');
    await db.recordRoutingSettingsEvent('routing-settings:'+h.id,h.actor,{field:h.field,old:h.before,new:h.after,occurred_at:h.at});
  }
}
