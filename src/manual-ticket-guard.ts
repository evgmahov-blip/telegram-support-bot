/**
 * Manual (phone/email/in-person) tickets have no client transport. Their
 * synthetic recipient lives in a non-Telegram namespace and must never reach
 * Telegram, Signal or Web delivery. Dependency-free so every transport can use it.
 */
export const MANUAL_MESSENGER = 'manual';
export const MANUAL_USER_PREFIX = 'MANUAL:';
export const MANUAL_SOURCE_LABELS: Record<string, string> = {
  phone: 'Телефон', email: 'Email', in_person: 'Лично', other: 'Другое',
};

export class ManualTicketDeliveryError extends Error {
  constructor() {
    super('Ручная заявка не имеет канала доставки клиенту; отправка запрещена.');
    this.name = 'ManualTicketDeliveryError';
  }
}

export function isManualRecipient(id: unknown, messenger?: unknown): boolean {
  return messenger === MANUAL_MESSENGER || String(id ?? '').startsWith(MANUAL_USER_PREFIX);
}

export function isManualTicket(ticket: { userid?: unknown; messenger?: unknown } | null | undefined): boolean {
  return Boolean(ticket) && isManualRecipient(ticket!.userid, ticket!.messenger);
}

/** Fail closed: transports call this before any network side effect. */
export function assertDeliverableRecipient(id: unknown, messenger?: unknown): void {
  if (isManualRecipient(id, messenger)) throw new ManualTicketDeliveryError();
}
