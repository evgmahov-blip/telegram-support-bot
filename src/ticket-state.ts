import { ISupportee, Supportee, TicketStatus } from './db';

/**
 * Compare-and-set transition for a ticket lifecycle state.
 * The update succeeds only while the ticket is still in one of expectedStates.
 */
export async function transitionTicketStateFrom(
  ticketId: number,
  expectedStates: TicketStatus | TicketStatus[],
  target: TicketStatus,
): Promise<ISupportee | null> {
  const states = Array.isArray(expectedStates) ? expectedStates : [expectedStates];
  const ticket = await Supportee.findOneAndUpdate(
    {
      ticketId,
      status: { $in: states },
    },
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
