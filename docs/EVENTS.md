# Event replay API

Enable the read-only event feed in `config.yaml`:

```yaml
api_enabled: true
api_token: "replace-with-a-long-random-secret"
api_port: 8081
api_host: "127.0.0.1"
```

Bare-metal runs bind to loopback by default. Docker Compose sets `API_HOST=0.0.0.0` inside the container so Docker can forward the socket, while publishing it only as `127.0.0.1:8081` on the host. The legacy web addon remains on port `8080`.

Request:

```text
GET /events?since=123&limit=100
Authorization: Bearer <api_token>
```

Response events are contiguous and ordered by ascending `seq`. Each event includes `event_id`, `seq`, `type`, `ticket_id`, `actor_id`, `timestamp`, and `metadata`. The response also contains `next_since` and `has_more`. Persist `next_since` only after successfully processing the returned page.

Existing analytics rows from deployments before the sequenced event log are backfilled on startup in bounded batches. They receive UUID event IDs and sequence numbers, and legacy underscore event names are normalized to the canonical dotted taxonomy. If a deployment already contains sequenced rows, older unsequenced rows are appended after the current maximum so an existing cursor is never rewound. A completion marker makes subsequent startups skip the collection scan; migration failure is logged and does not prevent the bot from starting.

Message event types are `ticket.message.user`, `ticket.message.staff`, and `ticket.message.ai`. Domain events use dotted names such as `ticket.created`, `ticket.replied`, `ticket.closed`, `ticket.escalated`, `ticket.priority_changed`, `ticket.queue_changed`, `ticket.note_added`, and `csat.rated`.

Ticket message bodies are not copied into event metadata. Full conversation history remains in the append-only `TicketMessage` collection; `llm_memory_depth` only limits AI reads. Inbound user text is persisted to that authoritative history before the staff-chat delivery attempt; the corresponding replay-log mirror is emitted only after successful staff delivery. Some trusted-module events may contain identifiers such as Telegram `user_id` in metadata; replay subscribers are privileged internal components.

`GET /healthz` is intentionally unauthenticated and returns only `{ "ok": true }`. `/events` requires Bearer authentication and is rate-limited.

Webhook delivery is disabled when `webhooks: []`. A subscriber opts into durable delivery only with `durable: true`; it then consumes this persisted stream with a stored cursor and receives `event_id`/`seq`. Delivery is at-least-once, so receivers must deduplicate by `X-TSB-Event-ID` (or payload `event_id`). Non-durable entries retain the legacy compatibility path and are not replayed after restart. Webhooks do not create or synchronize AOR tickets.

Telegram ingress receipt idempotence is a separate concern handled by open PR #10. It is not included in the VM3902 deployment candidate and no duplicate ingress mechanism is implied here.

In-process event appends are serialized before sequence allocation, so callers observe replay order matching append call order within one bot instance. The unique sequence index and retry loop still arbitrate concurrent writers across instances.
