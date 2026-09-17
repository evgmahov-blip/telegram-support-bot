import cache from './cache';
import * as db from './db';
import * as log from './logger';

let server: any = null;

function configView(): { api_enabled?: boolean; api_token?: string; api_port?: number } {
  return cache.config as unknown as { api_enabled?: boolean; api_token?: string; api_port?: number };
}

function bearerToken(req: any): string {
  const header = String(req.headers?.authorization || '');
  return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
}

function authorized(req: any, expected: string): boolean {
  const actual = bearerToken(req);
  if (!actual || actual.length !== expected.length) return false;

  let diff = 0;
  for (let i = 0; i < actual.length; i += 1) {
    diff |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Read-only catch-up API for out-of-process subscribers.
 * The host port is bound to localhost by docker-compose; Bearer auth remains
 * mandatory so a reverse proxy cannot accidentally expose an open event feed.
 */
export function startEventsApi(): any {
  const config = configView();
  if (!config.api_enabled) return null;
  if (server) return server;

  const token = String(config.api_token || '').trim();
  if (!token) {
    throw new Error('api_enabled requires a non-empty api_token');
  }

  const express = require('express');
  const app = express();
  app.disable('x-powered-by');

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

    const events = await db.getEventsSince(since, limit);
    const payload = events.map((event) => ({
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

    const nextSince = payload.length > 0
      ? payload[payload.length - 1].seq ?? since
      : since;

    res.status(200).json({ events: payload, next_since: nextSince });
  });

  const port = Number(config.api_port || 8080);
  server = app.listen(port, '0.0.0.0', () => {
    log.info(`Event replay API listening on port ${port}`);
  });
  return server;
}

export async function stopEventsApi(): Promise<void> {
  if (!server) return;
  const current = server;
  server = null;
  await new Promise<void>((resolve, reject) => {
    current.close((err?: Error) => err ? reject(err) : resolve());
  });
}
