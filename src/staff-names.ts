import cache from './cache';

const roleLabel: Record<string, string> = { admin: 'Администратор', supervisor: 'Супервизор', agent: 'Инженер' };
export const UNKNOWN_STAFF_NAME = 'Сотрудник вне списка';

/**
 * Staff-facing display name. config staff_roles[].name is authoritative; the
 * Telegram ID stays internal (identity/RBAC/audit) and is never the fallback.
 * Returns raw text: callers escape it for their parse mode. Never use it on
 * client-facing surfaces — clients only ever see the anonymous support label.
 */
export function staffDisplayName(telegramId: string | number | null | undefined): string {
  if (telegramId === null || telegramId === undefined || telegramId === '') return UNKNOWN_STAFF_NAME;
  const member = cache.staffMembers?.get(String(telegramId));
  if (!member) return UNKNOWN_STAFF_NAME;
  const name = String(member.name ?? '').trim();
  return name || roleLabel[member.role] || 'Сотрудник';
}
