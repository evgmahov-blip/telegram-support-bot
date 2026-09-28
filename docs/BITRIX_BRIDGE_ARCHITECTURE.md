# Bitrix24 Support Bridge Architecture

Status: REVIEW CANDIDATE v3  
Base: `most-core @ 79a94f2b8c9ab7f141af817a55776beb840e674a`  
Scope: architecture only. No implementation and no production activation.

## 1. Goal

Provide one dedicated Bitrix24 group chat as an optional operator UI for the existing MOST Telegram support system.

The Telegram support bot remains authoritative for:
- tickets and lifecycle;
- ticket/message history;
- staff identity and authorization;
- routing/queues;
- audit/events;
- end-user Telegram delivery.

Bitrix24 is a removable projection/reply surface only.

**Hard invariant:** disabling or deleting Bitrix credentials, bot membership, the bridge process, or the Bitrix integration must not block, corrupt, or change the existing Telegram support path.

## 2. Non-goals

V1 does not:
- move ticket state/history to Bitrix24;
- make CRM, Tasks, Disk, Calendar, users, or Bitrix roles authoritative;
- mirror arbitrary Bitrix chats;
- install code/modules inside Bitrix24;
- grant Bitrix direct MongoDB access;
- allow Bitrix to execute infrastructure actions;
- replace the Telegram staff chat;
- expose generic support replay/history APIs to the bridge;
- synchronize edits/deletes/reactions;
- enable lifecycle commands such as close/take/transfer from Bitrix.

## 3. Topology and trust boundaries

```text
Telegram user
    |
    v
+----------------------------------+
| telegram-support-bot             |
| authoritative core               |
| MongoDB / TicketMessage / audit  |
| canonical reply outbox           |
+----------------+-----------------+
                 |
                 | private integration API only
                 | projection feed + reply commands
                 v
+----------------------------------+
| bitrix-bridge                    |
| replaceable external adapter     |
| durable local spool/mappings     |
| no ticket database               |
+----------------+-----------------+
                 |
                 | outbound HTTPS only
                 v
+----------------------------------+
| Bitrix24                         |
| one dedicated support group chat |
| regular bot, eventMode=fetch     |
+----------------------------------+
```

### 3.1 support-bot trust level

Trusted authoritative component. It owns all business decisions.

It MUST NOT synchronously depend on Bitrix availability.

### 3.2 bitrix-bridge trust level

Lower-trust replaceable adapter.

It may persist only integration state:
- support projection cursor;
- Bitrix fetch cursor/state;
- projection jobs;
- correlation mappings;
- processed Bitrix event IDs;
- retry/quarantine state.

It MUST NOT persist an independent ticket lifecycle or write MongoDB directly.

### 3.3 Bitrix24 trust level

External system and operator UI. All Bitrix input is untrusted until validated by support-bot policy.

## 4. Bitrix permission model

Use Chatbots 2.0 only: `imbot.v2.*`.

Required:
- dedicated integration/service user where practical;
- inbound webhook credential with **only `imbot` scope**;
- separate random `botToken`;
- bot type = `bot` (not `personal`, not `supervisor`);
- `eventMode=fetch`;
- `withUserEvents=false`;
- bot present only in one explicitly configured support group chat;
- no `im`, CRM, Tasks, Disk, Calendar, or other REST scopes;
- no public callback URL on our infrastructure.

A regular bot receives events addressed to that bot, e.g. by mention. V1 intentionally requires the operator to reply to/mention the bot. Promotion to a bot type that can observe all chat traffic is a separate future security decision.

## 5. Verified Bitrix API assumptions

Architecture relies on documented Chatbots 2.0 behavior:

### Registration
`imbot.v2.Bot.register`
- scope: `imbot`;
- V1 fields include `type=bot` and `eventMode=fetch`;
- returned/configured `botId` is pinned in bridge config.

### Event polling
`imbot.v2.Event.get`
- scope: `imbot`;
- returns `events`, `nextOffset`, `hasMore`;
- request `offset=X` confirms all events with IDs less than X;
- V1 does not use `withUserEvents=true`;
- only the application that registered the bot may fetch its events.

### Send
`imbot.v2.Chat.Message.send`
- scope: `imbot`;
- uses exact configured `dialogId=chat...`;
- supports `replyId`;
- returns Bitrix message ID.

### Files
Optional V1 file support uses only:
- `imbot.v2.File.upload`;
- `imbot.v2.File.download`.

No generic message-read API is required for a regular bot.

Before production activation, B24-03 MUST run a live contract test against the target portal and record the detected API revision/request-response fixtures.

## 6. Server-enforced Bitrix projection API

The bridge MUST NOT receive a credential that can call the generic support event replay API or arbitrary TicketMessage reads.

Support-bot exposes a dedicated, feature-gated Bitrix projection endpoint over private networking.

Example logical API:

`GET /integrations/bitrix/v1/projection?since=<seq>&limit=<n>`

The server, not the bridge, decides which events are projectable.

Initial allowlist:
- `ticket.message.user`;
- explicitly approved safe ticket-status notices.

Explicitly excluded by default:
- `ticket.message.staff`;
- `ticket.message.ai`;
- internal notes;
- raw audit metadata;
- authorization changes;
- credentials/secrets;
- unrelated lifecycle/internal events.

Each projection record contains only deterministic redacted fields:
- support event ID and sequence;
- ticket display number / opaque ticket reference;
- safe customer display label;
- normalized text/caption;
- approved attachment descriptors;
- timestamp;
- optional safe routing/status label.

### 6.1 Event-bound content capabilities

If body/file retrieval is separate from the projection page, the projection record carries an **opaque, unguessable, short-lived capability**.

The capability is server-bound to:
- integration = Bitrix;
- integration principal;
- support event ID;
- ticket ID;
- content class;
- expiry.

The content endpoint accepts only that capability and verifies all bindings. It does not accept an arbitrary ticket/message ID.

A compromised bridge credential therefore cannot enumerate unrelated ticket history.

## 7. Outbound support -> Bitrix durable protocol

Bridge local storage uses transactional durable state.

Unique job key:
`support_event_id + projection_kind + portal_id + chat_id`.

For every projection page:

1. fetch projection page from support-bot;
2. in one local DB transaction:
   - insert missing projection jobs under the unique key;
   - persist candidate/new support cursor;
3. commit;
4. only after commit may the bridge request the next support page;
5. Bitrix worker sends jobs asynchronously;
6. successful send stores `portal_id + chat_id + bitrix_message_id` mapping;
7. retryable failures use bounded exponential backoff;
8. permanent or ambiguous sends enter quarantine.

Cursor MUST NOT advance if jobs cannot be durably persisted.

Bitrix outage therefore grows only the bridge's bounded spool and never backpressures the Telegram core.

## 8. Exact Bitrix fetch acknowledgement protocol

Bridge stores explicit fetch state.

Persisted entities:
- `last_confirmed_offset`;
- fetched page/batch record with returned event IDs and `nextOffset`;
- per-event durable job records;
- page state: `fetched -> durable -> ack_pending -> acknowledged`.

Protocol:

1. Call `Event.get` using `last_confirmed_offset` (or no offset for first fetch).
2. Validate response shape and monotonicity.
3. In one local transaction:
   - persist every returned event under unique key `portal_id + bot_id + event_id`;
   - persist the returned `nextOffset`;
   - mark the page `durable`.
4. Only after that transaction commits, the next `Event.get` call may send the prior `nextOffset`; this is the remote confirmation action.
5. Before the confirming call, mark page `ack_pending`.
6. If confirming call returns a valid response, persist local `last_confirmed_offset` and mark prior page `acknowledged`.
7. If the confirming call times out/has ambiguous outcome, do **not** invent a new local confirmed offset. Retry using the same offset and rely on event-ID uniqueness to suppress any refetched page/events.
8. Event processing is independent from fetch acknowledgement once events are durably stored.

Thus crash before local durability cannot acknowledge the page; crash after durability may cause safe refetch, not loss.

## 9. Complete inbound Bitrix acceptance predicate

A fetched event may become a support reply command only if ALL conditions pass:

- exact configured portal identity/base URL;
- exact configured `botId`;
- exact configured support `dialogId/chatId`;
- event type is the approved bot-addressed message-add event;
- event recipient/addressing semantics identify the registered regular bot;
- sender/author ID exists and is active/acceptable by policy;
- sender is currently mapped to a canonical MOST staff identity;
- event references/replies to a known bot projection message;
- correlation key lookup uses `portal_id + chat_id + bitrix_message_id`;
- correlated ticket is active/replyable;
- external event ID has not already been accepted;
- message/file sizes and content types pass policy.

Fail closed for:
- DMs;
- another group;
- another portal;
- another bot;
- unaddressed messages;
- forwarded/spoofed/ambiguous context;
- unknown reply target;
- unknown/deprovisioned actor;
- incomplete event structures.

Visible `#T123` text is never routing authority.

## 10. Staff identity mapping

Bitrix roles/membership are not sufficient authorization.

Support configuration maintains explicit mapping:

```yaml
integration_principals:
  - integration: bitrix
    portal_id: "nwmost.bitrix24.example"
    external_actor_id: "42"
    canonical_staff_id: "123456789"
```

Authorization is evaluated **at processing time**, not only at fetch time. Mapping changes are audited and immediately affect queued work.

## 11. Canonical durable reply/outbox prerequisite

Inbound Bitrix replies MUST NOT call a direct Telegram send path.

Before Bitrix inbound replies can be activated, support-bot must expose a canonical durable staff-reply command path.

Unique command key:
`integration + portal_id + external_event_id`.

### 11.1 Atomic authoritative transaction

One authoritative Mongo transaction MUST atomically:

- create/find the command receipt;
- record canonical staff identity and target ticket;
- append authoritative ticket/history/audit intent;
- create exactly one Telegram delivery-outbox record;
- set command state to accepted/queued.

Or persist none of them.

A repeated request with the same unique key returns the existing recorded state/result and MUST NOT invoke reply creation again.

### 11.2 Delivery worker

Only a durable Telegram delivery worker crosses the external Telegram API boundary.

States:
- `accepted`;
- `queued`;
- `sending` with lease/fencing token;
- `delivered`;
- `failed_safe`;
- `ambiguous`.

Rules:
- known non-send may retry under bounded policy;
- confirmed send -> `delivered`;
- timeout/crash after send request but before confirmed durable outcome -> `ambiguous`;
- `ambiguous` is never auto-replayed;
- explicit operator resolution is required and audited;
- stale workers cannot advance a newer lease.

This is required even if PR #10 provides history idempotence; history dedupe alone does not make Telegram external send exactly once.

## 12. Correlation model

Outbound mapping:
`portal_id + chat_id + bitrix_message_id -> support_event_id + ticket_id`.

Inbound reply must resolve through this mapping.

Mapping rows are unique and immutable except explicit reconciliation metadata.

No free-form ticket-number parsing is authoritative.

## 13. Secure attachment flow

V1 optional attachments: text, images/photos, ordinary documents.

### 13.1 support -> Bitrix

1. projection event exposes event-bound file capability;
2. bridge streams bytes from private support integration endpoint;
3. server and bridge enforce maximum bytes before/during streaming;
4. bridge stores temporary retry copy only on quota-controlled bridge storage;
5. bridge uploads with `imbot.v2.File.upload` to exact configured `dialogId`;
6. temporary data expires/deletes by retention policy.

### 13.2 Bitrix -> support

1. accepted authenticated event provides file ID/descriptor;
2. descriptor must belong to expected portal/chat/event context;
3. bridge calls `imbot.v2.File.download` with registered bot credentials;
4. returned download URL is treated as a one-time capability;
5. downloader allows HTTPS only;
6. hostname must match configured Bitrix portal / explicitly documented allowed Bitrix redirect hosts;
7. redirect count is bounded;
8. DNS resolution is revalidated against private/link-local/loopback/reserved-address deny rules unless explicitly required for on-prem portal configuration;
9. credentials/authorization headers are never forwarded to an unrelated host;
10. streaming byte cap is enforced regardless of Content-Length;
11. filename is normalized; path traversal/control characters are stripped;
12. MIME/extension policy is checked;
13. support-bot receives bytes/stream + verified metadata, never an arbitrary URL to fetch.

Arbitrary URLs from message text/attachments are never fetched.

Deployment policy must define executable blocking, file size, retention, optional malware scanning and quarantine before file support activation.

## 14. Resource isolation and bounded spool

Bridge must not exhaust resources required by support-bot/MongoDB.

Mandatory production limits:
- separate quota-controlled persistent volume for spool/quarantine;
- reserved free-space threshold;
- max spool bytes;
- max job count;
- high-water and critical-water marks;
- CPU quota/weight;
- memory limit;
- PID limit;
- file-descriptor limit;
- bounded worker concurrency;
- bounded outbound connections;
- integration API rate limits;
- request/body/download byte limits;
- connect/read/total timeouts;
- Bitrix API rate limiting/backoff/circuit breaker.

Behavior:
- at high-water: pause new projection/fetch intake and alert;
- at critical-water: stop bridge external intake, preserve durable state, alert;
- never backpressure or stop Telegram support;
- projection loss/drop is allowed only by explicit operator decision because Bitrix is non-authoritative, and is recorded for reconciliation.

## 15. Reconciliation protocol

Authoritative sources:
- support side: support-bot projection sequence/event IDs and authoritative ticket/outbox records;
- Bitrix side: durable fetched event IDs plus bridge mappings; Bitrix itself is not ticket authority.

### 15.1 Support projection gap/lost spool

1. stop outbound direction;
2. record gap start/end or last known event sequence;
3. query support-bot for projection range using integration-specific API;
4. compare expected projection event IDs against local jobs/mappings;
5. recreate only missing local jobs under the same unique keys;
6. never resend mappings already marked successful;
7. ambiguous external-send rows require operator decision;
8. operator approves reconciliation range/action;
9. completion requires contiguous projection cursor and zero unexplained gaps;
10. audit reconciliation result.

### 15.2 Bitrix fetch gap/state loss

1. stop inbound direction;
2. preserve current local confirmed offset and fetched-event records;
3. retry same documented offset where possible;
4. deduplicate any returned events by `portal + bot + event_id`;
5. if Bitrix retention/API no longer permits retrieval of a missing range, mark a permanent external-source gap;
6. do not synthesize replies;
7. require operator acknowledgement and audit before moving to a new safe offset.

### 15.3 Mapping loss/orphans

Rebuild only from durable support projection jobs and stored Bitrix send results where unambiguous.

Unknown/ambiguous external sends are never assumed successful or blindly resent.

## 16. Quarantine and manual recovery

Quarantine is access-controlled operator state.

Each item records only bounded diagnostics:
- immutable source IDs;
- reason class/error code;
- timestamps;
- attempt count;
- state;
- no unnecessary message body.

Allowed actions:
- discard;
- retry-safe;
- reconcile;
- resolve-ambiguous.

All actions are audited. Ambiguous user-visible Telegram sends cannot use generic retry.

## 17. Credential model

### Bitrix
- dedicated webhook credential;
- only `imbot` scope;
- dedicated service/integration user where practical;
- separate random botToken;
- rotate/revoke independently;
- secrets never committed/logged.

### support-bot internal
- dedicated Bitrix-bridge credential;
- integration-specific audience;
- accepted only by Bitrix integration endpoints;
- independently revocable/rotatable;
- private loopback/container network;
- mTLS or equivalent service identity preferred where available.

Generic admin APIs must not accept this credential.

## 18. Data minimization and logging

Only project operationally needed customer support content.

Do not project:
- internal notes;
- AI/staff drafts;
- raw audit metadata;
- unrelated customer profile data;
- database internals;
- secrets/credentials.

Security audit identifiers may include:
- portal ID;
- bot ID;
- chat ID;
- external event/message ID;
- support event/ticket ID;
- external actor ID;
- mapped staff ID;
- authorization/correlation decision;
- command/outbox state;
- error code.

Normal logs do not contain full ticket bodies.

## 19. Failure behavior

| Failure | Required behavior |
|---|---|
| Bitrix unavailable | Telegram support healthy; bridge bounded spool/backoff |
| Bitrix auth revoked | core healthy; bridge opens auth circuit/alerts |
| bridge down | core healthy; resume durable cursors |
| support-bot temporarily down | Bitrix bridge waits; Bitrix portal unaffected |
| duplicate support projection | unique job suppresses duplicate |
| duplicate Bitrix event | unique event/command receipt suppresses duplicate |
| wrong chat/portal/bot | reject |
| unauthorized actor | reject and audit IDs only |
| unknown reply mapping | reject; never guess ticket |
| ambiguous Telegram send | quarantine/manual audited resolution |
| spool pressure | pause bridge before core resource pressure |
| event gap | stop affected direction and reconcile |
| malicious file reference | reject/quarantine; no arbitrary fetch |

## 20. Observability

Bridge status/metrics:
- support projection cursor;
- Bitrix last confirmed offset;
- fetched/durable/ack-pending page count;
- pending outbound/inbound jobs;
- retry/quarantine counts;
- oldest pending age;
- spool bytes/jobs vs quota;
- last successful Bitrix API call;
- auth/circuit status;
- reconciliation-required flag.

No message bodies in health output.

## 21. Rollout gates

1. Architecture independent APPROVE.
2. B24-01: integration-specific projection API + staff principal mapping + canonical durable reply/outbox prerequisite.
3. B24-02: standalone bridge + transactional spool/cursors + resource isolation.
4. B24-03: `imbot.v2` adapter + API compatibility/live contract proof.
5. B24-04: support -> Bitrix text projection/correlation in shadow mode.
6. B24-05: Bitrix -> support replies for explicit actor allowlist.
7. B24-06: optional files after file-security tests.
8. B24-07: failure injection, reconciliation, observability, operator runbook, independent security/reliability review.
9. B24-08: separate production activation decision.

No implementation task may enable inbound replies before B24-01 durable command/outbox invariants exist.

## 22. Required implementation tests

Must prove:
- complete Bitrix outage does not affect Telegram ticket/reply path;
- bridge credential cannot enumerate unrelated support content;
- mapped employee from wrong Bitrix DM/group is rejected;
- same numeric message ID in another chat/portal cannot collide;
- wrong portal/bot/event context is rejected;
- actor mapping revoked after fetch but before processing is rejected;
- duplicate Bitrix pages/events are idempotent;
- crash injection around every command/outbox transition is safe;
- ambiguous post-Telegram-send state is not blindly replayed;
- support projection cursor/job transaction survives crash;
- Bitrix ack-pending ambiguous call safely refetches/dedupes;
- spool high-water/critical-water leaves core healthy;
- malicious URL/redirect/DNS/file cases cannot cause SSRF;
- auth revocation/throttling opens bounded retry/circuit behavior;
- gap reconciliation is auditable and does not duplicate confirmed sends;
- V1 works with `imbot` scope only and `withUserEvents=false`.

## 23. Rollback/removal

Removal:
1. stop/disable bridge;
2. disable Bitrix integration endpoints/credential;
3. revoke/delete Bitrix webhook credential;
4. unregister/remove Bitrix bot.

No ticket migration or authoritative database rollback is required.

Historical support data remains entirely in support-bot.

## 24. Future task list after architecture approval

After independent APPROVE, record only these as future tasks (no implementation yet):

- B24-01 — integration projection API, principal mapping, canonical reply/outbox;
- B24-02 — durable standalone bridge, cursors/spool, quotas;
- B24-03 — Bitrix imbot.v2 adapter and live compatibility proof;
- B24-04 — outbound text projection and correlation;
- B24-05 — authorized inbound replies and command receipts;
- B24-06 — secure image/document transport;
- B24-07 — failure/reconciliation/security tests, metrics, runbook;
- B24-08 — shadow rollout and separate activation gate.
