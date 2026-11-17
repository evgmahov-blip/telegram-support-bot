import * as fs from 'fs/promises';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import * as YAML from 'yaml';
import cache from './cache';
import { withStaffAccess } from './staff-access-gate';
import * as team from './team';
import * as db from './db';
import type { StaffMemberConfig } from './interfaces';

const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 24);
const requireAdmin = (actor: string) => { if (!team.canPerformAction(actor, 'manage_team')) throw new Error('team_forbidden'); };
interface Change { id: string; actor: string; at: string; before: StaffMemberConfig | null; after: StaffMemberConfig; }
export async function readTeamSettings(actor: string, file = './config/config.yaml') {
  requireAdmin(actor);
  const raw = await fs.readFile(file, 'utf8'), value = YAML.parse(raw);
  if (!value || !Array.isArray(value.staff_roles)) throw new Error('team_config_invalid');
  return { etag: hash(raw), members: value.staff_roles as StaffMemberConfig[], history: (value.team_settings_history || []) as Change[] };
}

/** Same YAML source and writer lock as routing settings. No second employee registry. */
export async function saveTeamMember(actor: string, etag: string, next: StaffMemberConfig,
  verifiedIdentity = false, file = './config/config.yaml') {
  return withStaffAccess('write', () => saveTeamMemberLocked(actor, etag, next, verifiedIdentity, file));
}
async function saveTeamMemberLocked(actor: string, etag: string, next: StaffMemberConfig, verifiedIdentity: boolean, file: string) {
  requireAdmin(actor);
  if (!/^[0-9a-f]{24}$/.test(etag) || !/^[1-9]\d{0,15}$/.test(next.telegram_id)
    || !['admin','supervisor','agent'].includes(next.role) || typeof next.active !== 'boolean'
    || typeof next.name !== 'string' || !next.name.trim() || next.name.length > 80 || /[\u0000-\u001f\u007f]/.test(next.name)) throw new Error('team_invalid');
  const lock = await fs.open(file + '.routing-lock', 'wx', 0o600).catch(() => { throw new Error('team_busy'); });
  let temp: string | null = null;
  try {
    const current = await readTeamSettings(actor, file);
    if (current.etag !== etag) throw new Error('team_stale');
    // Check both durable authority and the current runtime projection.
    const initiator = current.members.find(m => m.telegram_id === actor);
    if (initiator?.role !== 'admin' || initiator.active === false) throw new Error('team_forbidden');
    const before = current.members.find(m => m.telegram_id === next.telegram_id) || null;
    if (!before && (!verifiedIdentity || next.active || next.role !== 'agent')) throw new Error('team_identity_required');
    if (next.telegram_id === String(cache.config.owner_id) && (next.role !== 'admin' || !next.active)) throw new Error('team_owner_protected');
    if (actor === next.telegram_id && (next.role !== before?.role || next.active !== (before?.active !== false))) throw new Error('team_self_change_denied');
    if (before?.role === 'admin' && before.active !== false && (next.role !== 'admin' || !next.active)
      && current.members.filter(m => m.role === 'admin' && m.active !== false).length <= 1) throw new Error('team_last_admin');
    // No silent orphaning; use the existing transfer/common-queue workflow first.
    if (before && !next.active && await db.hasActiveStaffAssignments(next.telegram_id)) throw new Error('team_has_assignments');
    const members = before ? current.members.map(m => m.telegram_id === next.telegram_id ? next : m) : [...current.members, next];
    const raw = await fs.readFile(file, 'utf8');
    if (hash(raw) !== etag) throw new Error('team_stale');
    const doc = YAML.parseDocument(raw);
    if (doc.errors.length) throw new Error('team_config_invalid');
    doc.set('staff_roles', members);
    doc.set('team_settings_history', [...current.history, { id: randomUUID(), actor, at: new Date().toISOString(), before, after: next }]);
    const stat = await fs.stat(file);
    temp = path.join(path.dirname(file), '.team-' + randomUUID() + '.tmp');
    const out = await fs.open(temp, 'wx', stat.mode & 0o777);
    try { await out.writeFile(String(doc)); await out.sync(); } finally { await out.close(); }
    requireAdmin(actor);
    if (hash(await fs.readFile(file, 'utf8')) !== etag) throw new Error('team_stale');
    await fs.rename(temp, file); temp = null;
    // Reflect a successful rename even if a subsequent directory fsync fails.
    cache.config.staff_roles = members;
    cache.staffMembers = new Map(members.map(m => [m.telegram_id, m]));
    const dir = await fs.open(path.dirname(file), 'r');
    try { await dir.sync(); } finally { await dir.close(); }
  } finally {
    if (temp) await fs.unlink(temp).catch(() => undefined);
    await lock.close(); await fs.unlink(file + '.routing-lock');
  }
}

/** Rollback is a new audited, versioned change and obeys all current guards. */
export async function undoTeamChange(actor: string, etag: string, file = './config/config.yaml') {
  const current = await readTeamSettings(actor, file), last = current.history.at(-1);
  if (!last || current.etag !== etag) throw new Error('team_stale');
  // Newly connected identities are retained disabled, preserving history.
  const previous = last.before ? { ...last.before, active: last.before.active !== false } : { ...last.after, active: false };
  await saveTeamMember(actor, etag, previous, false, file);
}
