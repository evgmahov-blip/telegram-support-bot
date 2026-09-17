# MOST Support Bot fork

Upstream: `bostrot/telegram-support-bot`

Baseline: `5c4bb7386da42647bc4e55e3660238a1ab037b19`

## Goals

- Telegram-first internal IT support.
- Users only see the bot, never engineer identities.
- Keep the ticket core small; add AI/KB/integrations as optional modules later.
- Preserve upstream compatibility where practical.

## Rules for our fork

1. `master` stays close to upstream; active work goes to `most-core` and later feature branches.
2. Engineers work only in the closed staff group; private/direct engineer reply flows are disabled.
3. No secrets or full ticket bodies in normal logs.
4. MongoDB and other databases stay internal-only.
5. AI is OFF/DRAFT first; it must not block the Telegram user path or execute infrastructure actions.
6. Prefer new files/modules over large edits to high-churn upstream files.

## Foundation

- grammY sessions isolated per engineer/chat;
- atomic ticket IDs and non-destructive ticket persistence;
- ticket timestamps and guarded lifecycle transitions;
- account bans separated from ticket lifecycle state;
- stable Mongo collection name independent of bot token;
- Mongo authentication/internal-only networking;
- separate Mongo root bootstrap account and least-privilege application `readWrite` account;
- safe logging/redaction; normal INFO logs do not contain full ticket bodies;
- Telegram message-id correlation as the authoritative reply lookup;
- private/direct engineer reply paths removed, including historical callback handling;
- media messages return Telegram message IDs for correlation;
- ticket messages are append-only; `llm_memory_depth` limits reads, never stored history.

## MOST lifecycle

Current lifecycle states:

- `open`
- `waiting_user`
- `closed`

`WAITING_USER -> OPEN` happens only on an actual user reply and uses a compare-and-set guard. A concurrent close wins and the closed ticket is never resurrected.

## Ownership and staff commands

Staff commands operate by replying to the bot's ticket message:

- `/take` — take an unowned active ticket;
- `/transfer <staff_telegram_id>` — transfer an owned ticket;
- `/waiting` — move an active ticket to `WAITING_USER`;
- `/queue [name]` — show the current queue or move the ticket to another configured queue;
- `/priority <low|normal|high|urgent>` — change priority with owner/state CAS;
- `/note <text>` — add an internal-only note;
- `/notes` — show internal notes;
- `/history` — show read-only audit events without rendering event metadata payloads;
- `/templates` and configured `/<key>` responses — preview or send canned responses through the normal staff reply path.

Agents may manage only tickets they own. Supervisors/admins may manage any active ticket.

## Queues

Queues are migration-free metadata stored on the existing ticket document. Old tickets without a `queue` field automatically read as the default queue.

Optional `config.yaml` settings:

```yaml
queues:
  - general
  - billing
  - infra
default_queue: general
```

If omitted, MOST uses a single `general` queue. Queue changes are allowed only for `OPEN`/`WAITING_USER` tickets and are recorded in the event history.

## Ticket history

`TicketMessage` is an append-only conversation log. The bot never deletes old ticket messages to enforce LLM context size.

- `getConversationHistory()` returns only the newest configured window for AI context.
- `getTicketMessageHistory()` reads chronological history for audit/export/future KB workflows.
- Event records do not include message bodies; message content stays in the ticket message collection.

## Events contract

Operational/audit events are persisted before external consumers read them. New events contain:

- `event_id` — UUID;
- `seq` — globally monotonic sequence number;
- `type`;
- `ticket_id`;
- `actor_id` (stored internally as the existing `agent_id` field for compatibility);
- `timestamp`;
- `metadata`.

Every ticket message append emits `ticket.message.user`, `ticket.message.staff`, or `ticket.message.ai`. Existing ticket mutations continue to use the same append-only event collection.

Read-only replay is available when the API is explicitly enabled:

```yaml
api_enabled: true
api_token: "use-a-long-random-secret"
```

`GET /events?since=<seq>&limit=<n>` requires `Authorization: Bearer <api_token>` and returns events in ascending sequence order plus `next_since`. The default port is `8080`; Docker publishes it on host `127.0.0.1` only. Existing historical analytics rows created before event sequencing do not have `seq` and therefore are not part of replay.

## AI contract

AI output is staff-only draft material:

- `use_llm` creates a reply draft in the staff chat; it never replies to the user automatically;
- `auto_triage` creates a triage suggestion in the staff chat; it does not change ticket priority/category automatically;
- AI drafts are plain text to avoid model-generated Telegram markup injection;
- draft creation is recorded in the audit events.

Static configured `autoreply` rules are not AI and may still answer users when explicitly configured.

## Mongo credentials

The default Compose stack uses two Mongo accounts:

- `MONGO_ROOT_USERNAME` / `MONGO_ROOT_PASSWORD` — bootstrap and healthcheck only;
- `MONGO_APP_USERNAME` / `MONGO_APP_PASSWORD` — `readWrite` only on `MONGO_APP_DATABASE` and used by `MONGO_URI`.

`docker/mongo-init.js` runs only when Mongo initializes an empty data directory. If `.tmp/mongodb_data` already contains a database created by an older setup, do not delete it automatically: create/migrate the application user explicitly before switching `MONGO_URI` to the least-privilege account.
