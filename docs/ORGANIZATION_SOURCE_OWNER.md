# Organization source-owner read foundation

Status: **code-ready, unmounted, not deployed**. This slice does not register routes in `index.ts`, listen on a port, write organization or ticket data, seed fixtures, contact Telegram, or call a live identity provider.

## Source identity and DTOs

The only organization identity is `{authority:"support-bot", instance, id}`. `instance` is an immutable opaque value supplied by a trusted owner registry; it is never inferred from a token, username, host, or browser input. `id` is a canonical UUID issued by the support-bot owner. Missing or mismatched registration fails closed.

Organization cards have `owner_version >= 1`, `active|archived` status, safe display/contact data, at most one primary engineer, unique ascending positive-priority backups, and time-bounded substitutes. Engineer `principal_ref` is canonical and opaque; optional Telegram identity is separate. Ticket `assigned_to` is unrelated to authorization.

Responses use `schema_version:1`, exact source authority/instance, UTC `as_of`, and `source_status`. This factory emits `fresh` only after a fresh central authorization decision and a successful repository read; transport failures return 503 rather than a fake empty result. Detail envelopes carry the item's positive `owner_version`. List items each carry their own authoritative positive `owner_version`, while the list envelope carries the central `scope_version` (there is deliberately no misleading maximum owner version across mixed organizations). A future adapter may represent `stale|unavailable`, but stale data must never authorize access.

## Private routes and authorization

The router factory exposes GET-only logical paths beneath `/internal/v1`:

- `/organizations`, `/organizations/:organizationId`
- `/organizations/:organizationId/contacts`
- `/organizations/:organizationId/engineer-relationships`
- `/ticket-refs`, `/organizations/:organizationId/ticket-refs/:ticketId`

It requires both a workload verifier and the central AINOC authorizer. HMAC proves a registered workload and binds an opaque actor; it grants nothing. The central callback freshly verifies enabled principal, enabled RBAC, explicit permission, exact organization allow, and deny-wins for every request/detail. Assignment, contact, chat membership, Telegram identity, and role ordering grant nothing. Unavailable identity/authz is 503 and no prior allow is cached.

| Permission | Returned fields |
|---|---|
| `organizations.read` | org ref/version, status, display name, service contact |
| `contacts.read` | org ref/version, display name, service contact |
| `engineer_relationships.read` | org ref/version, engineer names/service contacts, substitute intervals |
| `ticket_refs.read` | exact org ref/version, ticket id/status |
| `staff_internal.read` | reserved for a separately authorized future projection; not exposed here |

Personal phones, internal notes, message/raw text, logs, prompts, model cost, canonical engineer principals, and Telegram identities are never in client projections.

## Canonical request and golden vector

Headers name key id, RFC3339 UTC timestamp ending in `Z`, one-use nonce, actor, fixed audience, registered source instance, and base64url HMAC-SHA256 signature. HMAC keys are at least 32 bytes and come only from trusted factory configuration. The signed input is method, route path, canonical query, actor, audience, instance, timestamp, nonce, and body SHA-256 digest, each encoded as `<UTF8-byte-length>:<value>` and joined with LF.

Query handling first parses the raw URL with Express's simple/querystring semantics: `+` and `%20` both become a space, percent escapes are UTF-8 decoded, and repeated keys become an ordered value array. Nested/non-string values are rejected. Each decoded key/value is then UTF-8 percent-encoded using only the RFC3986 unreserved set `A-Z a-z 0-9 - . _ ~`; hex digits are uppercase. Pairs are sorted by encoded key and then encoded value (so repeated values are normalized), then joined with `&` and `=`. Thus literal `+` must arrive as `%2B`; `+` in a raw query denotes space. This decode-then-canonicalize rule is the Python adapter contract (`urllib.parse.parse_qs(..., keep_blank_values=True)` followed by `quote(value, safe='-._~')`).

Golden inputs use `GET`, `/internal/v1/organizations`, actor `ainoc:principal:7`, audience `ainoc-cabinet`, instance `owner-registry-01`, timestamp `2026-10-29T12:00:00.000Z`, nonce `abcdefghijklmnop`, empty-body digest `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`, and key bytes `0x07` repeated 32 times.

Empty-query canonical string (the line after the path is `0:`):

```text
3:GET
26:/internal/v1/organizations
0:
17:ainoc:principal:7
13:ainoc-cabinet
17:owner-registry-01
24:2026-10-29T12:00:00.000Z
16:abcdefghijklmnop
64:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
```

Expected base64url HMAC-SHA256: `Dj99BAaofEjNY6b1nao93XYLaBOzjMBPf83d0WVa-a4`.

For parsed query `{limit:"10", cursor:"a/b"}`, canonical query is `cursor=a%2Fb&limit=10`, its signed field is `21:cursor=a%2Fb&limit=10`, and the expected signature with the remaining inputs unchanged is `1KU3B1fSTobRZ_sU5xVr-gzrh7j42UcYMV7s9DVvfC8`.

Additional canonical-query vectors (values shown after query parsing):

| Parsed input | Canonical query |
|---|---|
| `{q:"a b"}` | `q=a%20b` |
| `{q:"a+b"}` (raw `q=a%2Bb`) | `q=a%2Bb` |
| `{q:"!*'()~"}` | `q=%21%2A%27%28%29~` |
| `{q:"café"}` | `q=caf%C3%A9` |
| `{q:["z","a"]}` | `q=a&q=z` |

Cursors use a separate key/purpose and bind actor, source, filter, authorization scope version, position, and expiry. Scope or actor changes invalidate them. List authorization supplies exact OrgRefs before any database query; detail always reauthorizes.

## Cabinet adapter and activation gates

A future Python cabinet `OrganizationOwner` adapter maps source `org_ref` unchanged, maps `owner_version` to its scoped version, treats any invalid/unavailable payload as denial, and sends the canonical signed request through a registered private transport. The production central-authz URL, credentials, atomic nonce store, cursor key, and source-instance registry are intentionally unknown here and must be bound by reviewed deployment configuration; no route has been fabricated.

Non-null organization activation remains **blocked**. Existing legacy queries are unscoped. Before writing any non-null organization ticket row, inventory and physically partition every list/detail/count/search/export/history/stream/worker/notification caller, verify legacy behavior, bind the central private route and instance registry, and complete end-to-end cutover review. This slice does not implement assignment, routing, transfer, mutation, publication, release, or deployment.

Run `npm run tsc` and `npm test -- test/organization-foundation.test.ts`. Tests use local crypto and mocked model chains only; no MongoDB, config, provider, Telegram, listener, or network is required.
