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
2. No private/direct reply flow that exposes engineer Telegram identity to users.
3. No secrets or full ticket bodies in normal logs.
4. MongoDB and other databases stay internal-only.
5. AI is OFF/DRAFT first; it must not block the Telegram user path or execute infrastructure actions.
6. Prefer new files/modules over large edits to high-churn upstream files.

## First foundation fixes

- isolate grammY sessions per engineer/chat;
- safer logging;
- Node runtime alignment and non-root container;
- remove unused public/admin services from the default compose stack;
- bind the optional app port to localhost only.
