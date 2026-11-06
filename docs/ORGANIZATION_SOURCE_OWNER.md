# Organization source-owner read foundation

Status: **code-ready, unmounted, not deployed**. This slice does not register routes in `index.ts`, listen on a port, write organization or ticket data, seed fixtures, contact Telegram, or call a live identity provider.

## Source identity and DTOs

The only organization identity is `{authority:"support-bot", instance, id}`. `instance` is an immutable opaque value supplied by a trusted owner registry; it is never inferred from a token, username, host, or browser input. `id` is a canonical UUID issued by the support-bot owner. Missing or mismatched registration fails closed.

Organization cards have `owner_version >= 1`, `active|archived` status, safe display/contact data, at most one primary engineer, unique ascending positive-priority backups, and time-bounded substitutes. Engineer `principal_ref` is canonical and opaque; optional Telegram identity is separate. Ticket `assigned_to` is unrelated to authorization.

Responses use `schema_version:1`, exact source authority/instance, UTC `as_of`, and `source_status`. This factory emits `fresh` only after a fresh central authorization decision and a successful repository read; transport failures return 503 rather than a fake empty result. An organization item's `owner_version` is the current version of that organization row. A ticket-ref item's `owner_version` is instead the organization owner version stamped on that ticket when it was written: it can be older than the organization's current `owner_version` and must not be presented as the current version. Ticket-ref DTO field names remain unchanged for compatibility. List envelopes carry the central authorization `scope_version`, which is separate from every item stamp, and have no top-level `owner_version`. A future adapter may represent `stale|unavailable`, but stale data must never authorize access.

## Private routes and authorization

The router factory exposes GET-only logical paths beneath `/internal/v1`:

- `/organizations`, `/organizations/:organizationId`
- `/organizations/:organizationId/contacts`
- `/organizations/:organizationId/engineer-relationships`
- `/ticket-refs`, `/organizations/:organizationId/ticket-refs`, `/organizations/:organizationId/ticket-refs/:ticketId`

It requires both a workload verifier and the central AINOC authorizer. HMAC proves a registered workload and binds an opaque actor; it grants nothing. The central callback freshly verifies enabled principal, enabled RBAC, explicit permission, exact organization allow, and deny-wins for every request/detail. Assignment, contact, chat membership, Telegram identity, and role ordering grant nothing. Unavailable identity/authz is 503 and no prior allow is cached.

| Permission | Returned fields |
|---|---|
| `organizations.read` | org ref/version, status, display name, service contact |
| `contacts.read` | org ref/version, display name, service contact |
| `engineer_relationships.read` | org ref/version, engineer names/service contacts, substitute intervals |
| `ticket_refs.read` | exact org ref, ticket owner-version stamp, ticket id/status |
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

### Exact-organization ticket-ref list adapter contract

`GET /internal/v1/organizations/<canonical-uuid>/ticket-refs` is GET-only. `HEAD`, `POST`, and every other method return 405 before workload-proof verification. The only query keys are `limit` and `cursor`; each, when present, must be one non-empty string. `limit` defaults to 50 and must be a decimal integer from 1 through 100. Unknown, repeated, empty, or otherwise invalid query values return 400.

The Python adapter signs the exact path `/internal/v1/organizations/<canonical-uuid>/ticket-refs` and the canonical query using the HMAC mapping above. A valid workload proof establishes only the actor. The source then calls the central authorizer with `{permission:"ticket_refs.read", requested_org:<exact OrgRef>}`. The decision must use strict booleans, enable both the principal and RBAC, not deny, and include that exact `{authority:"support-bot", instance, id}` in `org_refs` before the repository is accessed.

Pagination is ascending by positive safe-integer `ticketId`. Cursor signing uses the existing purpose-separated codec and binds `actor`, source `support-bot:<instance>`, central `scope_version`, and filter `JSON.stringify(["ticket-refs", authority, instance, id])`; `after` is the last positive safe-integer ticket ID. Consequently a cursor cannot be replayed for another organization, actor, source instance, or authorization scope.

Invalid request data or cursors return 400, invalid workload proofs return 401, and central denial returns 403. Central authorization, nonce-store, or repository outages return 503. Any source row that fails validation, including a cross-organization row, rejects the whole page with 503 rather than returning a partial result. Each returned ticket-ref `owner_version` remains the stamp stored on that ticket, even when it is older than the organization's current owner version. The envelope carries only the distinct central `scope_version`; adapters must never map the ticket stamp to `scope_version` or label it as the current organization version.

## Cabinet adapter and activation gates

A future Python cabinet `OrganizationOwner` adapter maps source `org_ref` unchanged, preserves an organization row's `owner_version`, and preserves a ticket-ref `owner_version` only as that ticket's historical owner-version stamp. It must not treat a ticket stamp as the organization's current version or as the central `scope_version`. It treats any invalid/unavailable payload as denial and sends the canonical signed request through a registered private transport. The production central-authz URL, credentials, atomic nonce store, cursor key, and source-instance registry are intentionally unknown here and must be bound by reviewed deployment configuration; no route has been fabricated.

Non-null organization activation remains **blocked**. Existing legacy queries are unscoped. Before writing any non-null organization ticket row, inventory and physically partition every list/detail/count/search/export/history/stream/worker/notification caller, verify legacy behavior, bind the central private route and instance registry, and complete end-to-end cutover review. This slice does not implement assignment, routing, transfer, mutation, publication, release, or deployment.

Run `npm run tsc`, `npm test -- test/organization-foundation.test.ts`, and `npm test -- test/organization-ticket-list.test.ts`. Tests use local crypto and mocked model chains only; no MongoDB, config, provider, Telegram, listener, or network is required.
