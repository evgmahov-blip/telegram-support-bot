# Bitrix24 support bridge architecture

Status: PROPOSED / review candidate  
Base: `most-core @ 79a94f2b8c9ab7f141af817a55776beb840e674a`  
Scope: architecture only; no implementation or production activation.

## 1. Goal

Expose the existing MOST Telegram support workflow in one dedicated Bitrix24 group chat while keeping Bitrix24 non-authoritative and removable.

The Telegram support bot remains the source of truth for tickets, lifecycle, history, routing, authorization and delivery to end users. Bitrix24 is only an optional operator-facing projection and reply ingress.

Removing the Bitrix credentials, bot, chat membership, or the entire bridge must not break Telegram support.

## 2. Non-goals

V1 does not:
- move ticket state or history into Bitrix24;
- make Bitrix CRM, Tasks, Disk, Calendar or users authoritative;
- install code/modules into Bitrix24;
- expose the support-bot database directly to Bitrix;
- let Bitrix execute infrastructure actions;
- synchronize arbitrary Bitrix chats;
- mirror edits/deletes/reactions;
- replace the existing Telegram staff chat.

## 3. Architectural decision

Use a separate `bitrix-bridge` process next to support-bot.

```text
Telegram user
    |
    v
+---------------------------+
| telegram-support-bot      |
| authoritative ticket core |
| MongoDB / TicketMessage   |
| lifecycle / auth / audit  |
+-------------+-------------+
              |
              | loopback/private integration API
              | replay events + idempotent reply commands
              v
+---------------------------+
| bitrix-bridge             |
| local durable spool       |
| cursor + mappings only    |
+-------------+-------------+
              |
              | outbound HTTPS only
              v
+---------------------------+
| Bitrix24                  |
| one dedicated group chat  |
| regular support bot       |
+---------------------------+
```

The bridge is not an Addon inside the support-bot process. This keeps Bitrix API churn, credentials, outages and deployment lifecycle outside the core.

## 4. Trust boundaries

### support-bot

Authoritative for:
- ticket IDs and lifecycle;
- TicketMessage history;
- staff authorization;
- user delivery;
- audit/event sequence;
- duplicate suppression.

It must never depend synchronously on Bitrix availability.

### bitrix-bridge

A replaceable adapter. It may persist only integration state:
- support event cursor;
- Bitrix event cursor;
- `support_event_id -> bitrix_message_id`;
- `bitrix_message_id -> ticket_id`;
- processed external event IDs;
- retry/quarantine state.

It must not maintain a second ticket database.

### Bitrix24

An untrusted external UI boundary. Data received from Bitrix is treated as external input and must pass authorization, size and format validation before becoming a support command.

## 5. Bitrix24 permission model

Use Chatbots 2.0 (`imbot.v2.*`) only.

Required design:
- inbound webhook authorization with only the `imbot` scope;
- dedicated integration/service user with the least Bitrix permissions practical;
- bot type: `bot`, not `personal` and not `supervisor`;
- event mode: `fetch`;
- bot is added only to one explicitly configured support group chat;
- no CRM, Tasks, Disk, Calendar or other REST scopes;
- no public callback URL from our infrastructure.

A regular bot in a group receives events addressed to it. Therefore V1 requires an operator to reply to the bot's ticket message and address/mention the support bot. This is intentional: it avoids giving the integration visibility into all ordinary Bitrix chat traffic.

If a future UX change requires reading every message in that chat, promotion to `personal`/`supervisor` is a separate security decision and is not part of this architecture approval.

## 6. Support-bot integration contract

Do not grant the bridge direct MongoDB access.

Reuse the persisted sequenced event feed as the outbound source, but message bodies remain in TicketMessage and are not added to generic event metadata.

Add a narrow feature-gated internal API, bound to loopback/private Docker networking:

### Read path

`GET /integrations/v1/events?since=<seq>&limit=<n>`

May reuse the existing replay cursor semantics.

For message events, return a stable `message_ref` in the integration representation. The event log itself does not need to copy the body.

`GET /integrations/v1/messages/<message_ref>`

Returns only the single support message required for an authorized integration event:
- ticket_id;
- direction/type;
- display-safe actor/customer label;
- text/caption;
- supported attachment descriptors;
- timestamps.

No arbitrary ticket search is required by V1.

### Reply path

`POST /integrations/v1/replies`

Required fields:
- `integration = bitrix`;
- `external_event_id`;
- `external_message_id`;
- `ticket_id`;
- `actor_external_id`;
- text and/or supported attachment reference;
- optional reply mapping metadata.

The endpoint:
1. authenticates the bridge token;
2. rejects an unconfigured integration source;
3. checks the external actor against an allowlist/mapping;
4. validates that the target ticket is active and replyable;
5. durably deduplicates `integration + external_event_id`;
6. invokes the same canonical staff-reply service used by native staff ingress;
7. records the result in authoritative support audit/history.

The bridge must never construct Mongo writes itself.

V1 does not expose lifecycle commands such as close/take/transfer from Bitrix. Those can be designed later after reply transport is proven.

## 7. Actor authorization

Bitrix membership alone is not sufficient authorization.

Maintain an explicit mapping in support configuration, for example:

```yaml
integration_principals:
  - integration: bitrix
    external_actor_id: "42"
    canonical_staff_id: "123456789"
```

Only mapped Bitrix actors may send a user-visible reply.

Unknown actors may interact with the Bitrix bot but their attempted reply is rejected, logged without message body leakage, and may receive a short "not authorized" response.

This preserves the current staff authorization boundary and avoids trusting Bitrix role names.

## 8. Message correlation

Never use free-form parsing of `#T123` as the authority for routing a reply.

Outbound:
- support event has a stable `event_id` and `ticket_id`;
- bridge posts the formatted message to Bitrix;
- bridge stores the returned Bitrix message ID mapped to that ticket/event.

Inbound:
- operator replies to the bot's Bitrix message and addresses the bot;
- bridge resolves the Bitrix `replyId` through its mapping;
- the resulting ticket_id is sent to the support ingress endpoint.

If there is no valid reply mapping, fail closed and ask the operator to reply to a ticket message.

A visible ticket number is for humans only.

## 9. Delivery semantics and durable spool

Bitrix must never add latency or availability dependency to Telegram support.

### support -> Bitrix

1. bridge reads a page from the authoritative support replay feed;
2. in one local durable transaction it stores delivery jobs and the new support cursor;
3. the Bitrix worker sends jobs asynchronously;
4. successful sends store Bitrix message IDs;
5. clearly retryable failures use bounded exponential backoff;
6. malformed/permanent failures go to quarantine.

The support cursor advances after the jobs are durably spooled, not after Bitrix accepts them. Therefore a Bitrix outage cannot block support-bot.

### Bitrix -> support

Use `imbot.v2.Event.get` in fetch mode.

For every fetched page:
1. persist each external event and intended next offset locally;
2. only after durable local persistence may the bridge confirm/advance the Bitrix offset;
3. process persisted events asynchronously against support-bot;
4. deduplicate by Bitrix event ID;
5. only authorized reply events become support reply commands.

This avoids losing a Bitrix reply merely because the bridge crashes after fetching it.

## 10. Ambiguous external sends

Neither Telegram nor Bitrix provides a general exactly-once send primitive.

The system therefore does not claim exactly-once external delivery.

For user-visible replies from Bitrix, duplicate delivery to a customer is more harmful than delayed manual recovery. The support ingress implementation must:
- use a durable command receipt keyed by external event ID;
- distinguish `accepted`, `sending`, `delivered`, `failed-safe`, and `ambiguous`;
- automatically retry only when non-delivery is known;
- quarantine an ambiguous crash/network outcome after the irreversible user-send boundary rather than blindly replaying it.

PR #10 (`feat/idempotent-ticket-history`) is compatible with and useful for message-history deduplication, but the integration command receipt remains required because persistence idempotence alone does not make an external Telegram send exactly once.

For support -> Bitrix projection, an ambiguous send is lower risk. Prefer quarantine/inspection over unlimited blind replay.

## 11. Files

V1 should support the operationally important set:
- text;
- photos/images;
- ordinary documents.

The bridge retrieves only files referenced by integration events and streams them; it does not crawl historical media.

Enforce:
- size limits;
- MIME/extension policy;
- bounded download/upload timeouts;
- no executable interpretation;
- no permanent duplicate file store unless needed for retry spool.

Unsupported media is represented in Bitrix by a safe text notice.

## 12. Data minimization

Send to Bitrix only what support staff need:
- ticket number;
- safe customer display label;
- message content;
- supported attachments;
- minimal status marker if useful.

Do not send:
- Telegram bot token;
- Mongo identifiers unless they are opaque integration refs;
- unrelated customer profile data;
- credentials/secrets found in internal configuration;
- CRM enrichment by default.

Normal logs contain IDs, event types, sizes, result codes and retry state, not full ticket bodies.

## 13. Network/deployment isolation

Recommended deployment:
- separate `bitrix-bridge` container/process;
- no public listening port;
- private connection only to support-bot integration API;
- outbound HTTPS allowed only as required for the configured Bitrix portal;
- secrets injected via protected runtime configuration, never committed;
- bridge health/readiness separate from support-bot health.

Stopping/restarting the bridge must not restart support-bot.

The integration API remains disabled by default.

## 14. Failure behavior

| Failure | Required behavior |
|---|---|
| Bitrix outage | Telegram support continues; local outbound spool grows; alert |
| Bitrix credential revoked | Telegram support continues; bridge marks auth failure and stops retry storm |
| bridge stopped/crashed | Telegram support continues; resume from durable cursors |
| support-bot unavailable | Bitrix bridge waits/retries; Bitrix portal itself unaffected |
| duplicate support event | no duplicate local job |
| duplicate Bitrix event | no duplicate support command |
| unauthorized Bitrix actor | reject, audit metadata only |
| unknown reply mapping | fail closed; do not guess ticket ID |
| malformed/oversized file | quarantine/notice; no core crash |
| queue/disk pressure | pause bridge consumption and alert; never backpressure core |
| event gap/cursor inconsistency | stop affected direction and require reconciliation |

## 15. Observability

Bridge metrics/status should include:
- last support seq consumed;
- last Bitrix offset persisted;
- pending outbound jobs;
- pending inbound jobs;
- retry count;
- quarantine count;
- oldest pending age;
- last successful Bitrix API call;
- auth status.

No ticket body is required in health output.

## 16. Rollout

1. Architecture approval.
2. Implement internal integration API behind a disabled feature flag.
3. Implement bridge with fake Bitrix adapter and failure-injection tests.
4. Connect a test Bitrix bot/chat with `imbot` scope only.
5. Outbound shadow mode: support -> Bitrix only.
6. Enable inbound replies for an explicit small actor allowlist.
7. Add files.
8. Run retry/crash/auth-revocation/load tests.
9. Independent security/reliability review.
10. Enable in the production support chat by separate activation decision.

No rollout step changes the authoritative Telegram support path.

## 17. Rollback/removal

Rollback is intentionally simple:
1. disable bridge;
2. disable integration API;
3. revoke/delete the Bitrix webhook credential;
4. remove/unregister the Bitrix bot.

No ticket migration or database rollback is required. Historical support records stay in support-bot. Bridge mapping/spool data may be archived or deleted after reconciliation.

## 18. Acceptance criteria for implementation

Implementation is acceptable only if tests demonstrate:
- Bitrix completely unavailable while Telegram ticket/reply flows remain healthy;
- deleting Bitrix credentials cannot corrupt or block core state;
- duplicate events do not produce duplicate authoritative history writes;
- an unauthorized Bitrix user cannot reply to a customer;
- replies without valid message correlation are rejected;
- cursors survive bridge restart;
- queue growth is bounded/observable;
- no public bridge listener is required;
- only the `imbot` Bitrix scope is needed;
- integration can be removed without ticket migration;
- ambiguous post-send failures do not trigger blind user-visible replay.

## 19. Future tasks after architecture approval

Create implementation tasks only after this document receives an independent APPROVE:

- B24-01: generic internal integration API + auth/principal mapping;
- B24-02: durable standalone bridge skeleton and local spool;
- B24-03: Bitrix `imbot.v2` registration/fetch/send adapter with least privilege;
- B24-04: support -> Bitrix text projection and correlation;
- B24-05: Bitrix -> support authorized reply ingress and command receipts;
- B24-06: image/document transport;
- B24-07: failure injection, security tests, observability and operator runbook;
- B24-08: shadow rollout and separate production activation gate.


## 20. Mandatory security and reliability refinements after independent review

This section is normative and supersedes any earlier ambiguous wording.

### 20.1 Bridge read access is projection-specific, not generic replay access

The Bitrix bridge credential MUST NOT grant access to the generic privileged event replay API or arbitrary TicketMessage retrieval.

Implement a dedicated server-side Bitrix projection endpoint whose policy is fixed by support-bot configuration:

- allow only explicitly projectable event types, initially `ticket.message.user` and selected safe ticket-status notices;
- deny `ticket.message.staff`, `ticket.message.ai`, internal notes, audit metadata, authorization events, and unrelated lifecycle data unless separately approved;
- apply deterministic server-side redaction/projection before content leaves support-bot;
- return only fields required for the Bitrix UI;
- use opaque, unguessable, event-bound message capabilities;
- bind each message capability to `integration=bitrix + event_id + ticket_id + allowed content class`;
- expire capabilities quickly and reject reuse outside their bound event where practical;
- never accept a caller-supplied ticket ID or arbitrary message ID as authority for reads.

A compromised bridge credential therefore cannot enumerate support history.

### 20.2 Complete inbound Bitrix acceptance predicate

A Bitrix reply is accepted only when ALL of these match configured values:

- exact portal origin/base URL;
- exact registered `botId`;
- exact dedicated support `dialogId/chatId`;
- event type is an allowed bot-addressed message event;
- event is delivered to the registered regular bot according to Bitrix bot-addressing semantics;
- sender/author ID is present and current;
- sender is mapped to a canonical MOST staff identity at processing time;
- replied-to Bitrix message mapping exists;
- mapping key is scoped as `portal_id + chat_id + bitrix_message_id`;
- mapped ticket is still replyable;
- external event ID has not already been accepted.

Events from DMs, any other group, another portal, another bot, forwarded/spoofed context, unknown reply targets, or incomplete event structures fail closed.

Authorization is re-evaluated when the durable inbound job is processed, not merely when fetched, so deprovisioning or mapping changes take effect promptly.

### 20.3 Durable reply-command protocol and irreversible Telegram boundary

Inbound Bitrix replies MUST NOT call the current direct Telegram-send path synchronously.

Before inbound Bitrix replies can be enabled, the core MUST expose a canonical durable staff-reply command path shared by integration ingress. Its persistence invariant is:

1. atomically create/find a unique command receipt keyed by `integration + portal + external_event_id`;
2. atomically persist canonical reply intent, authoritative history/audit intent, and a durable user-delivery outbox record, or persist none of them;
3. commit before any external Telegram send;
4. a retry with the same key returns the recorded command state/result and MUST NOT invoke reply creation again;
5. a delivery worker alone crosses the Telegram API boundary;
6. after a confirmed Telegram response, mark delivery `delivered`;
7. a known non-send may retry under bounded policy;
8. a crash/timeout after the send request but before durable confirmation becomes `ambiguous` and is never automatically replayed;
9. resolving `ambiguous` requires an explicit audited operator action.

Receipt/outbox state transitions use CAS/fencing so stale workers cannot advance newer attempts.

This is a prerequisite for B24 inbound activation, not an optional optimization.

### 20.4 Verified Bitrix fetch semantics

Architecture relies only on documented `imbot.v2.Event.get` fetch mode semantics:

- scope required for bot events: `imbot`;
- bot must be registered with `eventMode=fetch`;
- `offset` confirms all events with IDs lower than the supplied value;
- response provides `events`, `nextOffset`, and `hasMore`;
- the next call uses the persisted `nextOffset`;
- user-wide `ONIMV2*` events require `withUserEvents=true` plus the broader `im` scope and a subscription; V1 MUST keep `withUserEvents=false` and MUST NOT request `im`;
- regular bots receive events addressed to that bot (for example by mention) and do not receive all traffic in the chat;
- only the application that registered a bot may fetch that bot's events.

Bridge protocol:

1. call `Event.get` using the last durably confirmed offset;
2. durably store the returned event batch and candidate `nextOffset`;
3. only after that local transaction commits may the bridge issue the next fetch using that `nextOffset`, thereby confirming the prior batch;
4. process stored events asynchronously;
5. duplicate stored/fetched events are suppressed by a unique key including portal, bot and Bitrix event ID.

Implementation must include a compatibility test against the target Bitrix portal and record the detected Chatbots 2.0 revision before production activation.

### 20.5 Outbound support -> Bitrix transactional invariant

Local bridge storage MUST enforce:

- unique key on `support_event_id + projection_kind + target_portal + target_chat`;
- atomic transaction that inserts all jobs for a replay page and advances the support cursor;
- cursor never advances if job persistence fails;
- retries never create a second job for the same key.

If local spool state is lost or an event gap is detected, normal processing stops. Reconciliation compares the authoritative support sequence with stored mappings. Historical re-projection requires an explicit operator-approved range and must use the same unique keys.

### 20.6 Hard resource isolation

The bridge must be unable to exhaust resources required by support-bot or MongoDB.

Production deployment MUST include:

- separate quota-controlled persistent volume for bridge spool/quarantine;
- explicit maximum spool bytes and job count;
- high-water and critical-water thresholds;
- CPU quota/weight;
- memory limit;
- PID limit;
- file-descriptor limit;
- bounded worker concurrency;
- bounded HTTP response/body sizes;
- request/connect/read timeouts;
- retry-rate caps and circuit breaking.

At high-water, bridge pauses external consumption before disk exhaustion. At critical-water it stops projection/fetch, alerts, and preserves the core.

Dropping/quarantining projection data is allowed only under a documented operator policy because Bitrix is non-authoritative. Such loss MUST be visible in status and reconciliation records and MUST never backpressure Telegram support.

### 20.7 Secure attachment flows

V1 attachment support is implemented only through authenticated platform APIs and event-bound identifiers.

Support -> Bitrix:
- support-bot issues an opaque one-time/short-lived file capability bound to the projectable support event;
- bridge streams that content from the private support integration endpoint with strict byte limit;
- bridge sends it through `imbot.v2.File.upload` to the configured `dialogId`;
- temporary retry storage is on the quota-controlled bridge volume and is deleted by retention policy.

Bitrix -> support:
- inbound event must identify an allowed file belonging to the authenticated configured portal/chat/event;
- bridge calls `imbot.v2.File.download` with its registered `botId/botToken` and that file ID;
- returned download URL is treated as a one-time capability;
- bridge validates HTTPS, host against the configured Bitrix portal/official redirect policy, redirect count, resolved-address policy, content length and streaming byte cap before fetching;
- arbitrary URLs from message text/attachments are never fetched;
- support-bot ingress receives bytes/stream plus verified metadata, never a caller-controlled URL to fetch itself.

No attachment path may perform arbitrary SSRF.

Allowed MIME/extensions, executable blocking policy, maximum decoded/upload size, quarantine behavior, retention, and optional malware scanning are deployment policy and must be explicit before file support activation.

### 20.8 Credential model

The Bitrix side uses a dedicated inbound-webhook credential owned by a dedicated integration/service user where practical, with only `imbot` scope, plus a distinct random botToken for the registered bot.

The support side uses a separate Bitrix-bridge credential that is:

- integration-specific;
- audience/endpoint restricted;
- revocable independently;
- rotatable;
- never accepted by generic administrative APIs.

Private loopback/container networking is mandatory; mutual authentication or an equivalent service identity is preferred where supported.

No secrets are written to normal logs or bridge mapping records.

### 20.9 Deterministic projection and audit policy

Server-enforced Bitrix projection defines exact fields for each event class. V1 customer-message projection may include only:
- ticket display number;
- configured safe customer display label;
- customer text/caption after size/control-character normalization;
- approved attachment metadata/content;
- timestamp;
- visible routing/status label if explicitly configured.

Internal notes, staff-only draft text, hidden audit metadata, credentials, raw database IDs, and unrelated profile fields are excluded.

Security/audit records retain identifiers only:
- portal ID/base;
- bot ID;
- chat/dialog ID;
- Bitrix event/message IDs;
- support event/ticket IDs;
- external actor ID and mapped canonical staff ID;
- authorization/correlation decision;
- command-receipt/delivery state;
- reason/error code.

Normal audit/logging does not copy message bodies.

### 20.10 Quarantine and ambiguous recovery

Quarantine is access-controlled operator state, not an automatic retry bucket.

Each item has:
- reason class;
- immutable source identifiers;
- first/last attempt timestamps;
- bounded diagnostic metadata;
- retention deadline;
- explicit actions such as discard, retry-safe, reconcile, or resolve-ambiguous.

Actions are audited. `ambiguous` user-visible deliveries cannot use generic retry.

### 20.11 Additional mandatory tests

Implementation tests MUST include:
- bridge credential attempts to enumerate unrelated support events/messages;
- valid mapped employee replying from wrong Bitrix DM/group;
- same numeric Bitrix message ID in another chat/portal;
- unexpected bot ID and portal origin;
- mapping revoked after fetch but before processing;
- duplicate `Event.get` batches;
- crash injection before/after every inbound receipt/outbox transition;
- crash/timeouts around Telegram send producing safe `ambiguous` state;
- spool disk/high-water exhaustion while core Telegram path remains healthy;
- malformed and oversized event bodies;
- malicious attachment URLs, redirects, DNS/address tricks and mismatched file/chat IDs;
- Bitrix auth revocation and API throttling;
- support replay gap and operator-approved reconciliation;
- regular-bot behavior proving no `im` scope and no `withUserEvents`.

## 21. Bitrix24 API compatibility appendix

The design targets Chatbots 2.0 only.

Required methods:
- `imbot.v2.Bot.register` — register `type=bot`, `eventMode=fetch`;
- `imbot.v2.Event.get` — bot-event polling with explicit offset confirmation;
- `imbot.v2.Chat.Message.send` — post/reply as the bot using configured `dialogId`;
- `imbot.v2.File.upload` — optional outbound file send;
- `imbot.v2.File.download` — optional authenticated download capability.

V1 MUST NOT use `withUserEvents=true`, `im.v2.Event.subscribe`, generic `im` scope, supervisor bot type, or arbitrary message-read APIs.

Before implementation begins, B24-03 must pin the exact request/response fields from the official API and add compatibility fixtures. Before activation it must run a live contract test against the actual portal because `imbot.v2` is versioned/evolving.

## 22. Review-gate effect

Independent review findings in this section are blocking architecture requirements.

No B24 implementation task may enable inbound customer replies until sections 20.1-20.11 are implemented and independently verified.

Future-task decomposition remains B24-01 through B24-08, but B24-01 must include the durable canonical reply-command/outbox prerequisite and B24-03 must include the live Bitrix API compatibility proof.
