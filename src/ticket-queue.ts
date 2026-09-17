import cache from './cache';
import { Supportee } from './db';

export interface QueueConfigView {
  queues?: string[];
  default_queue?: string;
}

function queueConfig(): QueueConfigView {
  return cache.config as unknown as QueueConfigView;
}

export function listQueues(): string[] {
  const configured = queueConfig().queues;
  const values = Array.isArray(configured)
    ? configured.map((q) => String(q).trim()).filter(Boolean)
    : [];

  const defaultQueue = String(queueConfig().default_queue || 'general').trim() || 'general';
  const unique = new Map<string, string>();
  for (const queue of [defaultQueue, ...values]) {
    unique.set(queue.toLowerCase(), queue);
  }
  return [...unique.values()];
}

export function defaultQueue(): string {
  const configured = String(queueConfig().default_queue || '').trim();
  if (configured) {
    const match = listQueues().find((queue) => queue.toLowerCase() === configured.toLowerCase());
    if (match) return match;
  }
  return listQueues()[0] || 'general';
}

/** Returns the configured canonical queue name, or null for an unknown queue. */
export function resolveQueueName(input: string): string | null {
  const requested = input.trim().toLowerCase();
  if (!requested) return null;
  return listQueues().find((queue) => queue.toLowerCase() === requested) ?? null;
}

/** Existing tickets without queue metadata implicitly belong to default_queue. */
export async function getTicketQueue(ticketId: number): Promise<string> {
  const ticket = await Supportee.collection.findOne(
    { ticketId },
    { projection: { queue: 1 } },
  );
  const stored = ticket?.queue;
  return typeof stored === 'string' && stored.trim() ? stored : defaultQueue();
}

/**
 * Atomically move an active ticket to a queue. Agent callers pass expectedOwner
 * so a concurrent transfer prevents the queue move. Supervisor/admin callers
 * omit it because they may manage any active ticket.
 *
 * Queue metadata is stored directly on the existing ticket document. This is
 * migration-free: old documents simply have no queue field and read as default.
 */
export async function moveTicketToQueue(
  ticketId: number,
  targetQueue: string,
  expectedOwner?: string,
): Promise<boolean> {
  const queue = resolveQueueName(targetQueue);
  if (!queue) return false;

  const filter: Record<string, unknown> = {
    ticketId,
    status: { $in: ['open', 'waiting_user'] },
  };
  if (expectedOwner !== undefined) filter.assigned_to = expectedOwner;

  const result = await Supportee.collection.updateOne(
    filter,
    { $set: { queue } },
  );

  return result.matchedCount === 1;
}
