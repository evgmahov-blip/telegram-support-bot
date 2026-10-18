import cache from './cache';

const roleLabel: Record<string, string> = { admin: 'Администратор', supervisor: 'Супервизор', agent: 'Инженер' };
export const UNKNOWN_STAFF_NAME = 'Сотрудник вне списка';

/**
 * Staff-facing display name. Membership and roles remain config-authoritative;
 * a persisted display-only override takes precedence over the config name. The
 * Telegram ID stays internal (identity/RBAC/audit) and is never the fallback.
 * Returns raw text: callers escape it for their parse mode. Never use it on
 * client-facing surfaces — clients only ever see the anonymous support label.
 */
export function staffDisplayName(telegramId: string | number | null | undefined): string {
  if (telegramId === null || telegramId === undefined || telegramId === '') return UNKNOWN_STAFF_NAME;
  const member = cache.staffMembers?.get(String(telegramId));
  if (!member) return UNKNOWN_STAFF_NAME;
  const override = cache.staffNameOverrides?.get(String(telegramId));
  if (override) return override;
  const name = String(member.name ?? '').trim();
  return name || roleLabel[member.role] || 'Сотрудник';
}
