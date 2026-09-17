import { AnalyticsEvent, IAnalyticsEvent } from './db';

/**
 * Read-only audit history for one ticket. Event metadata is deliberately kept
 * out of the presentation layer unless a caller explicitly needs it.
 */
export async function getTicketAuditHistory(
  ticketId: number,
  limit: number = 20,
): Promise<IAnalyticsEvent[]> {
  const safeLimit = Math.max(1, Math.min(limit, 100));
  return await AnalyticsEvent.find({ ticketId })
    .sort({ timestamp: -1 })
    .limit(safeLimit)
    .lean<IAnalyticsEvent[]>();
}
