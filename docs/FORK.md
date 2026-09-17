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
- safe logging/redaction;
- Telegram message-id correlation as the authoritative reply lookup;
- private/direct engineer reply paths removed, including historical callback handling;
- media messages return Telegram message IDs for correlation.

## MOST lifecycle

Current lifecycle states:

- `open`
- `waiting_user`
- `closed`

`WAITING_USER -> OPEN` happens only on an actual user reply and uses a compare-and-set guard. A concurrent close wins and the closed ticket is never resurrected.

## Ownership commands

Staff commands operate by replying to the bot's ticket message:

- `/take` — take an unowned active ticket;
- `/transfer <staff_telegram_id>` — transfer an owned ticket;
- `/waiting` — move an active ticket to `WAITING_USER`;
- `/queue [name]` — show the current queue or move the ticket to another configured queue.

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
