import { AnalyticsEvent, IAnalyticsEvent } from './db';

/**
 * Read-only audit history for one ticket. Event metadata is deliberately kept
 * out of the presentation layer unless a caller explicitly needs it.
 */
export async function getTicketAuditHistory(
  ticketId: number,
  limit: number = 0,
): Promise<IAnalyticsEvent[]> {
  const query = AnalyticsEvent.find({ ticketId }).sort({ timestamp: -1 });
  if (limit > 0) query.limit(limit);
  return await query.lean<IAnalyticsEvent[]>();
}
