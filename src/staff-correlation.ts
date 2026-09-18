import * as db from './db';
import * as log from './logger';

const STAFF_CORRELATION_ATTEMPTS = 3;

/**
 * Persist reply correlation after a staff-chat delivery has already succeeded.
 * Retry locally, but do not rethrow after exhaustion: replaying the ingress
 * update would duplicate the already delivered staff message.
 */
export async function persistStaffMessageCorrelation(
  ticketId: number,
  messageId: string,
  name: string | null,
): Promise<void> {
  let lastError: unknown = null;

  for (let attempt = 0; attempt < STAFF_CORRELATION_ATTEMPTS; attempt += 1) {
    try {
      await db.addIdAndName(ticketId, messageId, name);
      return;
    } catch (err) {
      lastError = err;
    }
  }

  log.error(`Could not persist staff message correlation for #T${ticketId}:`, lastError);
}
