import { ISupportee, Supportee, TicketStatus } from './db';

/**
 * Compare-and-set transition for a ticket lifecycle state.
 * The update succeeds only while the ticket is still in one of expectedStates.
 */
export async function transitionTicketStateFrom(
  ticketId: number,
  expectedStates: TicketStatus | TicketStatus[],
  target: TicketStatus,
  expectedOwner?: string,
): Promise<ISupportee | null> {
  const states = Array.isArray(expectedStates) ? expectedStates : [expectedStates];
  const filter: Record<string, unknown> = {
    ticketId,
    status: { $in: states },
  };
  if (expectedOwner !== undefined) filter.assigned_to = expectedOwner;
  const ticket = await Supportee.findOneAndUpdate(
    filter,
    {
      $set: {
        status: target,
        closed_at: target === 'closed' ? new Date() : null,
      },
    },
    { new: true },
  );

  return ticket as ISupportee | null;
}

/** Resume exactly WAITING_USER -> OPEN. CLOSED must never be resurrected by a user reply. */
export function resumeWaitingTicket(ticketId: number): Promise<ISupportee | null> {
  return transitionTicketStateFrom(ticketId, 'waiting_user', 'open');
}
