# Telegram ingress reliability

Telegram updates are guarded by a durable MongoDB receipt keyed by the deployment scope and Telegram `update_id`.

For a fresh update the bot creates a `processing` receipt before session or business middleware runs. A duplicate with a completed receipt, or with an active processing lease, is ignored. A processing receipt can be reclaimed only after its 30-minute lease expires, which lets another process recover work after a crash. Completed receipts are retained for seven days and then removed by a TTL index.

The receipt is marked `done` only after the full grammY middleware/handler chain resolves. If a handler throws, the processing receipt is released so a replay can retry. If business handling succeeds but the final receipt update fails, the receipt is deliberately left leased instead of being released immediately; this avoids turning a completion-write outage into an immediate duplicate side effect.

This is duplicate suppression, not a claim of mathematically exactly-once delivery. A process can still die after an external side effect but before the durable completion write. Eliminating that final crash window would require a durable inbox/outbox design with transactional business effects.

## Graceful shutdown

`SIGINT` and `SIGTERM` start one idempotent shutdown sequence:

1. stop scheduled timers;
2. stop platform ingress (Telegram long polling supports `stop()`);
3. close the event replay HTTP server;
4. disconnect MongoDB.

Telegram polling is stopped before MongoDB is disconnected so in-flight update handlers can drain against live storage. Repeated shutdown signals share the same shutdown promise and do not execute cleanup twice.

The support identity model is unchanged: users still communicate only with the bot, never directly with an engineer account. AI behavior is unchanged and remains draft-only.
