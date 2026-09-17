import { createHash, timingSafeEqual } from 'crypto';
import { rateLimit } from 'express-rate-limit';
import cache from './cache';
import * as db from './db';
import * as log from './logger';

let server: any = null;

function configView(): {
  api_enabled?: boolean;
  api_token?: string;
  api_port?: number;
  api_host?: string;
} {
  return cache.config as unknown as {
    api_enabled?: boolean;
    api_token?: string;
    api_port?: number;
    api_host?: string;
  };
}

function bearerToken(req: any): string {
  const header = String(req.headers?.authorization || '');
  return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
}

function authorized(req: any, expected: string): boolean {
  const actualDigest = createHash('sha256').update(bearerToken(req)).digest();
  const expectedDigest = createHash('sha256').update(expected).digest();
  return timingSafeEqual(actualDigest, expectedDigest);
}

/**
 * Read-only catch-up API for out-of-process subscribers.
 * Bare runs bind loopback. Compose sets API_HOST=0.0.0.0 inside the
 * container, while publishing the port only on host loopback.
 */
export function startEventsApi(): any {
  const config = configView();
  if (!config.api_enabled) return null;
  if (server) return server;

  const token = String(config.api_token || '').trim();
  if (!token) throw new Error('api_enabled requires a non-empty api_token');

  const express = require('express');
  const app = express();
  app.disable('x-powered-by');
  app.use('/events', rateLimit({ windowMs: 60_000, limit: 120 }));

  app.get('/healthz', (_req: any, res: any) => {
    res.status(200).json({ ok: true });
  });

  app.get('/events', async (req: any, res: any) => {
    if (!authorized(req, token)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }

    const rawSince = Number(req.query?.since ?? 0);
    const rawLimit = Number(req.query?.limit ?? 100);
    const since = Number.isSafeInteger(rawSince) && rawSince >= 0 ? rawSince : 0;
    const limit = Number.isSafeInteger(rawLimit) ? Math.max(1, Math.min(rawLimit, 500)) : 100;

    const rows = await db.getEventsSince(since, Math.min(limit + 1, 501));
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const events = page.map((event) => ({
      event_id: event.event_id,
      seq: event.seq,
      type: event.type,
      ticket_id: event.ticketId,
      actor_id: event.agent_id,
      timestamp: event.timestamp instanceof Date
        ? event.timestamp.toISOString()
        : new Date(event.timestamp).toISOString(),
      metadata: event.metadata || {},
    }));

    const nextSince = events.length > 0
      ? events[events.length - 1].seq ?? since
      : since;
    res.status(200).json({ events, next_since: nextSince, has_more: hasMore });
  });

  const port = Number(config.api_port || 8081);
  const host = String(process.env.API_HOST || config.api_host || '127.0.0.1');
  server = app.listen(port, host, () => {
    log.info(`Event replay API listening on ${host}:${port}`);
  });
  return server;
}

export async function stopEventsApi(): Promise<void> {
  if (!server) return;
  const current = server;
  await new Promise<void>((resolve, reject) => {
    current.close((err?: Error) => err ? reject(err) : resolve());
  });
  if (server === current) server = null;
}
