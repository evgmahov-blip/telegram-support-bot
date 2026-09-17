import { ISupportee, Supportee } from './db';
import { TicketPriority } from './interfaces';

const ACTIVE_STATUSES = ['open', 'waiting_user'];

function activeFilter(ticketId: number, expectedOwner?: string): Record<string, unknown> {
  const filter: Record<string, unknown> = {
    ticketId,
    status: { $in: ACTIVE_STATUSES },
  };
  if (expectedOwner !== undefined) filter.assigned_to = expectedOwner;
  return filter;
}

/**
 * Atomically updates priority only while the ticket is active and, for agents,
 * still owned by the expected engineer.
 */
export async function setPriority(
  ticketId: number,
  priority: TicketPriority,
  expectedOwner?: string,
): Promise<ISupportee | null> {
  const ticket = await Supportee.findOneAndUpdate(
    activeFilter(ticketId, expectedOwner),
    { $set: { priority } },
    { new: true },
  );
  return ticket as ISupportee | null;
}

/**
 * Guard used before writing an internal note. It prevents notes from being
 * added through the operational command after close or after an ownership race.
 */
export async function getActiveManageableTicket(
  ticketId: number,
  expectedOwner?: string,
): Promise<ISupportee | null> {
  const ticket = await Supportee.findOne(activeFilter(ticketId, expectedOwner));
  return ticket as ISupportee | null;
}
