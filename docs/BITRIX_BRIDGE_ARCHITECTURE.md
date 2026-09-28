# Bitrix24 Support Bridge Architecture

Status: APPROVED ARCHITECTURE (independent review APPROVE on normative commit `3cf916ef7352bad8ccd0c3ed3250b10a4f6c9e4f`)  
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

The bridge is a **narrowly trusted staff-reply relay**, not an untrusted parser.

Reason: Bitrix fetch events are authenticated to the bridge by the Bitrix bot credential, but Bitrix does not provide a per-event signature/provenance artifact that support-bot can independently verify after relay. Therefore support-bot cannot cryptographically prove that a claimed Bitrix actor/chat/event field was not fabricated by a compromised bridge.

This trust is explicit and deliberately bounded.

A compromised bridge/bridge credential MAY be able to impersonate one of the configured Bitrix integration principals for the limited operation "send a staff reply" to a ticket for which the bridge possesses a valid core-issued reply capability.

A compromised bridge MUST NOT be able to:
- enumerate historical ticket content;
- choose arbitrary ticket IDs;
- change lifecycle/owner/queue/priority;
- write MongoDB;
- obtain generic support APIs;
- reply to tickets never projected to this integration;
- bypass current core ticket-state checks;
- bypass per-integration/principal rate limits;
- execute infrastructure actions.

Support-bot still independently enforces every control it can enforce: integration credential, current actor mapping, opaque reply capability validity, ticket state, command idempotency, attachment policy, rate limits and audit.

This bounded trust/blast-radius model is a required security acceptance at the architecture gate. If future requirements demand cryptographically independent proof of each Bitrix actor action, this bridge model is insufficient and must be replaced with a different identity/authentication design.

The bridge may persist only integration state:
- support projection cursor/page state;
- Bitrix fetch cursor/state;
- projection jobs;
- correlation mappings and core-issued reply capabilities;
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


## 6. Server-enforced forward-only Bitrix projection API

The bridge MUST NOT receive a credential that can call generic support replay/history APIs and MUST NOT choose a numeric `since` cursor.

Support-bot owns a per-integration **server-side projection checkpoint** and exposes only a forward-only protocol over private networking.

Logical API:

- `POST /integrations/bitrix/v1/projection/next`
- `POST /integrations/bitrix/v1/projection/ack`
- exceptional operator-only reconciliation endpoint using a short-lived reconciliation capability.

### 6.1 Authoritative projection ordering

The underlying support event log has an immutable monotonically increasing global `seq`.

For Bitrix projection, the server checkpoint means:

`last_scanned_seq` = highest authoritative support sequence that this integration has durably acknowledged as scanned, whether or not every scanned event was projectable.

Filtering is deterministic and versioned by `projection_policy_version`.

Initial projectable allowlist:
- `ticket.message.user`;
- explicitly approved safe ticket-status notices.

Excluded by default:
- `ticket.message.staff`;
- `ticket.message.ai`;
- internal notes;
- raw audit metadata;
- authorization changes;
- credentials/secrets;
- unrelated lifecycle/internal events.

### 6.2 Forward-only page protocol

`projection/next` takes no caller-selected historical sequence.

Server behavior:

1. read the integration's current server-side checkpoint;
2. if an unacknowledged page already exists, return that same page;
3. otherwise scan the authoritative event log strictly after `last_scanned_seq`;
4. build a deterministic bounded page up to a fixed `scan_to_seq`;
5. include only projectable records from that scanned interval;
6. create an opaque, unguessable `page_token` bound to:
   - integration identity;
   - checkpoint version;
   - immutable pending-page ID;
   - `scan_from_seq`;
   - `scan_to_seq`;
   - projection policy version;
   - token generation;
7. persist the immutable pending page descriptor server-side;
8. return projectable records plus `page_token`, `scan_from_seq`, `scan_to_seq`, and current authoritative high-watermark.

The bridge cannot request an earlier range or arbitrary history.

### 6.2.1 Pending page token state machine

The **pending page descriptor itself does not expire while it is the current unacknowledged page**. Only bearer tokens used to acknowledge it have bounded validity.

If the bridge presents an expired page token to `projection/next` or `projection/ack`, support-bot does not change the pending page or checkpoint. Instead, after authenticating the same integration principal, it may atomically mint a new token generation for the **same immutable pending-page ID, same scan_from_seq, same scan_to_seq, same projection policy version**.

Reissue rules:
- reissue never rescans or changes page membership;
- old expired generations become invalid for new acknowledgements;
- `projection/ack` is idempotent by pending-page ID;
- if an acknowledgement for that page already committed, replaying any token for the same page returns the recorded acknowledged result and never advances twice;
- if token state is corrupted or the immutable pending page cannot be reconstructed exactly, the server returns `PROJECTION_RECONCILIATION_REQUIRED` and does not advance the checkpoint;
- revoking the integration credential invalidates token reissue and ack.

`projection/ack` on the current valid token atomically:
1. verifies the immutable pending-page ID and current checkpoint version;
2. sets `last_scanned_seq = scan_to_seq`;
3. records the acknowledged pending-page ID/result;
4. clears current pending-page state.

If the bridge crashes after receiving a page but before local commit, the same immutable page is returned/reissued.
If it crashes after local commit but before ack, the same immutable page is returned/reissued and bridge unique job keys suppress duplicates.
If ack outcome is ambiguous, retrying the same pending-page acknowledgement returns either the same still-pending page or the already-recorded idempotent acknowledged result.

Failure-injection tests MUST cover token expiry/reissue before local commit, after local commit before ack, during ambiguous ack, and after acknowledged-result replay.

Filtered sequence gaps are normal because the cursor represents **scanned authoritative sequence**, not count of returned projection rows.

### 6.3 Retention and gap behavior

If the server-side checkpoint is older than retained authoritative projection source data, `projection/next` returns an explicit `PROJECTION_GAP` error with the last available boundary. It MUST NOT silently jump the cursor.

The bridge stops that direction and enters reconciliation-required state.

A bridge credential cannot clear this state or select a replacement range.

### 6.4 Projection payload/data boundary

Projection records contain only deterministic server-redacted fields:
- support event ID;
- opaque ticket display/reference data needed for UI;
- safe customer display label;
- normalized text/caption only for the current forward page;
- approved attachment descriptors/capabilities;
- timestamp;
- optional safe routing/status label;
- opaque core-issued `projection_handle` that contains no message body and authorizes only later reply-capability issuance for this exact projected support event/ticket/chat.

The ordinary bridge credential cannot rewind to enumerate old customer text.

`projection_handle` is opaque, unguessable, and server-bound to:
- integration = Bitrix;
- projected ticket ID;
- source projection event/message;
- target configured integration/chat identity;
- allowed operation = issue_or_refresh_staff_reply_capability.

It exposes no generic read ability and cannot be exchanged for another ticket.

### 6.4.1 Reply-capability issuance and renewal

A short-lived `reply_capability` is **not** minted when the projection page is created.

After the bridge has successfully posted that projection to the configured Bitrix chat and durably stored the immutable mapping `projection_handle + portal_id + chat_id + bitrix_message_id`, it calls a dedicated support endpoint to issue a reply capability.

The request may contain only:
- the opaque `projection_handle`;
- the already configured integration identity;
- the exact configured portal/chat;
- the Bitrix message ID for audit/correlation.

Support-bot resolves ticket/event server-side from the projection handle. The caller cannot supply or change ticket routing.

Issued `reply_capability` is bound to:
- the immutable projection handle/event/ticket;
- integration = Bitrix;
- configured portal/chat;
- allowed operation = staff_reply;
- capability generation and expiry.

If the capability expires before an operator reply, the bridge may request a fresh generation **only with the same projection_handle and same durable successful Bitrix mapping**. Refresh:
- never exposes message content/history;
- never changes ticket/event/chat binding;
- is idempotent for the requested/current generation state;
- checks that the ticket is still replyable;
- is audited;
- may be rate-limited/revoked independently.

Thus Bitrix outages or delayed spool delivery do not consume reply-capability lifetime before the message is actually visible, while a compromised bridge still cannot select arbitrary tickets beyond projection handles it legitimately received.

For an inbound reply, the bridge must present the current valid reply capability associated with the replied-to Bitrix mapping.

### 6.5 Exceptional reconciliation capability

Historical range access is available only through an explicit operator-approved action that mints a short-lived, auditable reconciliation capability bound to:
- integration = Bitrix;
- exact `from_seq` and `to_seq`;
- purpose/reason;
- issuer/operator;
- expiry;
- allowed projection policy version.

The bridge's normal credential alone cannot mint, widen, or reuse it outside that range.

Reconciliation pages remain server-redacted/projectable only.


## 7. Outbound support -> Bitrix durable protocol

Bridge local storage uses transactional durable state.

Unique job key:
`support_event_id + projection_kind + portal_id + chat_id`.

For every support projection page:

1. call server-side `projection/next`;
2. validate page token and bounds;
3. in one local DB transaction:
   - insert all missing projection jobs under unique keys;
   - persist the received page token and scanned range;
4. commit;
5. call `projection/ack` with that exact page token;
6. persist local acknowledgement state after server ack succeeds;
7. only then request the next page;
8. Bitrix send workers process durable jobs asynchronously;
9. successful sends durably store scoped Bitrix mapping plus the associated core-issued `projection_handle`;
10. after that durable success, request/record a current `reply_capability` for the same immutable mapping;
11. retryable failures use bounded backoff;
12. permanent/ambiguous sends enter quarantine.

If capability issuance fails after the Bitrix message was posted, the mapping remains durable and enters a bounded `capability_pending` state; the bridge retries capability issuance without reposting the Bitrix message. The Bitrix message is not considered reply-ready until a valid capability is stored.

A crash before local job commit cannot advance the server checkpoint.
A crash after local commit but before support ack returns the same page and unique job keys suppress duplicates.
A crash after server ack but before local ack recording is recovered by asking for the next page and reconciling local page state; jobs were already durable before server ack.

Bitrix outage therefore grows only the bridge's bounded spool and never backpressures Telegram core.

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

The bridge is the trusted Bitrix event attestation relay within the bounded trust model of section 3.2. It must validate Bitrix event context before submission, and support-bot revalidates all controls that do not require direct access to Bitrix's authenticated fetch session.

A fetched event may become a support reply command only if ALL bridge-side checks pass:

- exact configured portal/base URL used for the authenticated Bitrix API session;
- exact configured `botId`;
- exact configured support `dialogId/chatId`;
- approved bot-addressed message-add event type;
- event is addressed to the registered regular bot;
- sender/author ID exists;
- message is a reply to a known bridge-posted projection message;
- Bitrix event/message identifiers are well-formed;
- content/files pass local prechecks.

The bridge submits:
- integration identity;
- external event ID;
- claimed external actor ID;
- scoped portal/chat/bot identifiers;
- the opaque core-issued `reply_capability` stored with the replied-to projection mapping;
- content/verified attachment payload.

Support-bot then independently requires ALL of:

- valid dedicated Bitrix-bridge credential;
- current actor mapping for the claimed actor;
- valid unexpired `reply_capability`;
- capability integration/chat binding matches the configured integration;
- capability resolves server-side to a currently replyable projected ticket;
- ticket is active/replyable;
- unique external command key has not created a second command;
- per-integration and per-principal rate/admission limits pass;
- content/attachments pass authoritative limits.

The support endpoint does not accept a caller-selected ticket ID as routing authority.

Because the bridge can fabricate the claimed actor if compromised, the residual accepted blast radius is explicit: a compromised bridge can attempt staff replies only using reply capabilities it previously received for legitimately projected tickets, subject to current mapping, ticket state, rate limits and idempotency. It cannot broaden itself to arbitrary tickets or other core mutations.

Fail closed for unknown/expired capability, inactive mapping, wrong integration binding, inactive ticket, duplicate/conflicting command, oversized content, or failed bridge-side Bitrix context validation.

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

1. accepted authenticated event provides a Bitrix file ID/descriptor;
2. descriptor must belong to the expected configured portal/chat/event context;
3. bridge calls `imbot.v2.File.download` with the registered bot credentials;
4. returned download URL is treated as a one-time capability, never as a generally trusted URL;
5. downloader accepts HTTPS only;
6. approved download destinations are configured as exact **normalized origins**: `https://hostname:port`;
7. cloud default policy allowlists only the configured Bitrix portal origin on TCP 443; any additional redirect origin or non-default/on-prem port requires explicit separate configuration;
8. initial download URL and every redirect are canonicalized before use; URLs containing userinfo/credentials, malformed or ambiguous authority syntax, invalid ports, or a normalized origin not on the exact allowlist are rejected;
9. an explicit port on an allowlisted hostname is rejected unless that exact `scheme + hostname + port` origin is separately allowlisted; implicit HTTPS port resolves to 443 and must match an approved origin;
10. redirects are handled manually, not by unconstrained automatic redirect logic, and redirect count is bounded;
11. for each approved origin, a controlled resolver obtains A/AAAA addresses;
12. prohibited private/link-local/loopback/reserved addresses are rejected unless the exact on-prem origin/network is explicitly configured by policy;
13. the outbound TCP connection is made only to one of the validated addresses (or through an equivalently constrained egress proxy); the HTTP stack must not perform unchecked re-resolution;
14. TLS SNI/hostname and certificate verification remain bound to the approved hostname while connecting to the pinned validated IP;
15. every redirect repeats origin canonicalization, exact origin allowlist check, controlled resolution, IP policy, IP pinning and TLS-hostname validation before connection;
16. dual-stack fallback may use only addresses from the validated set;
17. authorization headers/credentials are stripped on any origin change and never forwarded to an unrelated origin;
18. streaming byte cap is enforced even if Content-Length is absent or false;
19. filename is normalized and path traversal/control characters are removed;
20. MIME/extension policy is checked;
21. support-bot receives bytes/stream plus verified metadata, never an arbitrary URL to fetch.

Arbitrary URLs from message text or attachments are never fetched.

Deployment policy must define executable blocking, file-size limits, retention, optional malware scanning and quarantine before file support activation.

Mandatory SSRF tests cover:
- allowlisted hostname with disallowed explicit non-default port;
- redirect changing only the port;
- userinfo/authority canonicalization tricks;
- DNS rebinding;
- A/AAAA switching;
- redirect to private/link-local/loopback/reserved addresses;
- proxy/client automatic re-resolution;
- validation/connect TOCTOU.

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
- bridge credential cannot rewind the forward-only projection cursor or enumerate unrelated/historical support content;
- only operator-approved bounded reconciliation capability can access a specified historical projection range;
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
- malicious URL/redirect/DNS/file cases cannot cause SSRF, including allowlisted-host non-default ports, redirect port changes, DNS rebinding, dual-stack address switching, proxy re-resolution and validation/connect TOCTOU;
- projection delayed beyond normal reply-capability TTL becomes reply-ready through mapping-bound capability issuance/refresh without reposting or changing ticket routing;
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


## 25. Independent review record

Normative architecture reviewed: `3cf916ef7352bad8ccd0c3ed3250b10a4f6c9e4f`

Independent reviewer verdict: **APPROVE**

Blocking issues: none.  
Required fixes: none.

The approval is architecture-only. It does not authorize implementation, deployment, or production activation. Future implementation tasks remain separately gated.
