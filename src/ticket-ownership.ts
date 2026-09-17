import { ISupportee, Supportee } from './db';

const ACTIVE_STATUSES: Array<'open' | 'waiting_user'> = ['open', 'waiting_user'];

/**
 * Atomically take an unowned active ticket. Taking a ticket already owned by
 * the same agent is idempotent; a ticket owned by somebody else is untouched.
 */
export async function takeTicket(
  ticketId: number,
  agentId: string,
): Promise<ISupportee | null> {
  const ticket = await Supportee.findOneAndUpdate(
    {
      ticketId,
      status: { $in: ACTIVE_STATUSES },
      $or: [
        { assigned_to: null },
        { assigned_to: agentId },
      ],
    },
    { $set: { assigned_to: agentId } },
    { new: true },
  );

  return ticket as ISupportee | null;
}

/**
 * Atomically transfer an active ticket. When expectedOwner is supplied the
 * transfer succeeds only if ownership has not changed since it was checked.
 * For supervisor/admin transfers we first snapshot the current owner and then
 * use that owner in the update query, so concurrent ownership changes are not
 * silently overwritten.
 */
export async function transferTicket(
  ticketId: number,
  targetAgentId: string,
  expectedOwner?: string,
): Promise<ISupportee | null> {
  let ownerGuard: string | null;

  if (expectedOwner !== undefined) {
    ownerGuard = expectedOwner;
  } else {
    const current = await Supportee.findOne({
      ticketId,
      status: { $in: ACTIVE_STATUSES },
    });
    if (!current) return null;
    ownerGuard = current.assigned_to ?? null;
  }

  const ticket = await Supportee.findOneAndUpdate(
    {
      ticketId,
      status: { $in: ACTIVE_STATUSES },
      assigned_to: ownerGuard,
    },
    { $set: { assigned_to: targetAgentId } },
    { new: true },
  );

  return ticket as ISupportee | null;
}
