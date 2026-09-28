# Bitrix24 bridge — future task registry

Status: PLANNED / NOT STARTED  
Approved architecture: `docs/BITRIX_BRIDGE_ARCHITECTURE.md`  
Normative approved architecture commit: `3cf916ef7352bad8ccd0c3ed3250b10a4f6c9e4f`  
Review record commit: `53915c99cd353083bccec9bd68b660c7a9a8357f`

These tasks are planning records only. They do not authorize implementation, deployment, or production activation.

## B24-01 — Core integration projection API and durable reply outbox

Status: FUTURE

Deliver:
- server-owned forward-only Bitrix projection cursor/page/ack protocol;
- integration-specific projection credential and deterministic redaction;
- opaque projection_handle and reply_capability lifecycle;
- explicit Bitrix principal mapping to canonical staff identities;
- canonical durable staff-reply command receipt + Telegram delivery outbox;
- CAS/fencing and ambiguous-send handling;
- no generic replay/history access for bridge.

Gate: architecture sections 6, 9-12, 17 and crash/idempotency tests.

## B24-02 — Standalone bridge, durable spool and resource isolation

Status: FUTURE

Deliver:
- separate bridge process/container;
- transactional local spool/cursors/mappings/quarantine;
- bounded retries/circuit breaker;
- CPU/memory/PID/FD limits;
- quota-controlled spool volume and watermarks;
- no public listener;
- no backpressure into support-bot.

Gate: architecture sections 3, 7-8, 14, 16, 20.

## B24-03 — Bitrix24 imbot.v2 adapter and live compatibility proof

Status: FUTURE

Deliver:
- regular bot with `eventMode=fetch`;
- `imbot` scope only, `withUserEvents=false`;
- `Event.get` polling/ack;
- `Chat.Message.send`;
- optional `File.upload/File.download` primitives;
- exact portal/bot/chat validation;
- target-portal live contract test and API revision fixtures.

Gate: architecture sections 4-5.

## B24-04 — Support -> Bitrix text projection and correlation

Status: FUTURE

Deliver:
- project approved support events only;
- one dedicated Bitrix support chat;
- persist portal+chat+message -> support event/ticket mapping;
- issue reply capability only after successful Bitrix post;
- outbound-only shadow mode first;
- no staff/internal/AI leakage.

Gate: architecture sections 6-7, 12, 18.

## B24-05 — Authorized Bitrix -> support replies

Status: FUTURE

Deliver:
- configured portal/chat/bot only;
- bot-addressed replies only;
- explicit external actor -> canonical staff mapping;
- reply-capability routing only;
- durable command receipt and canonical reply outbox;
- rate limits/fail closed;
- audited manual resolution for ambiguous Telegram delivery.

Gate: architecture sections 9-12.

## B24-06 — Secure image/document transport

Status: FUTURE

Deliver:
- images/photos and ordinary documents;
- support event-bound file capabilities;
- `imbot.v2.File.upload/download`;
- exact HTTPS origin allowlist: scheme + host + port;
- controlled DNS, validated-IP connection pinning, TLS hostname validation;
- redirect/size/MIME/filename/retention/quarantine policy;
- SSRF, DNS-rebinding and TOCTOU tests.

Gate: architecture section 13.

## B24-07 — Reconciliation, failure/security tests, observability and runbook

Status: FUTURE

Deliver:
- projection/Bitrix cursor reconciliation;
- lost spool/mapping/gap handling;
- quarantine/operator actions;
- metrics for cursors, spool, retries, auth and gaps;
- outage/auth-revocation/throttling/load/resource-exhaustion tests;
- independent security/reliability review.

Gate: architecture sections 15-16, 19-22.

## B24-08 — Shadow rollout and separate production activation gate

Status: FUTURE

Deliver:
- test Bitrix bot/chat;
- outbound-only shadow rollout;
- small explicit inbound actor allowlist;
- files only after B24-06 acceptance;
- rollback/removal drill;
- separate production activation decision after all prior tasks/reviews.

This task does not itself authorize production activation.

## Execution order

`B24-01 -> B24-02 -> B24-03 -> B24-04 -> B24-05 -> B24-06 -> B24-07 -> B24-08`

B24-02 and B24-03 may be developed in parallel after B24-01 contracts are frozen. B24-06 may proceed in parallel with B24-05 after the common bridge and API contracts are stable.

No task is STARTED by this registry.
