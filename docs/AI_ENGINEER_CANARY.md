# Exact-request canary admission (bot side)

Status: the bot-side change is implemented and **disabled by default** (`ai_engineer_enabled: false`, `ai_engineer_mode`
absent → `standard`). Production approval has not been given. This change does **not** make the full integration READY:
the AINOC installer defects R4 (UNKNOWN state) and R5 (rollback) are a separate AINOC dependency, and the installer repair
is still `ACTIVATION_READY=False` with no independent APPROVE. Nothing here installs, enables, restarts or writes production
config/Mongo, and nothing here calls a model.

Fixes R1/R2: a global enable plus a timer no longer admits any real ticket. In canary mode, the bot computes for exactly
one pre-created synthetic staff ticket/request/revision named in the config, and only inside an absolute window of at most 1 hour.

## What changed (minimal extension, no new subsystem)

- `EngineerPolicy` gets an optional `canary` field (`src/ai-engineer.ts`). Standard mode has no `canary` field, so the policy
  fingerprint stays byte-identical (`test/fixtures/support-conclusion-v1.json` is unchanged).
- `createTask`, `current` and the Store's computational commits enforce exact identity. `claim`/`claimSummarizer`/`renewSummarizer`
  and new `publish*`/`fail*` writes also enforce the window. The Mongo CAS filter re-checks the admitted ticket, owner and epoch
  on the live document (`canaryWriteFilter`).
- Bridge queue selection (`findQueued`/`findSummarizer`) adds an exact filter (`canarySelection`). Outside the window it runs
  no query at all. Fresh `claim-checks`/`claim-summarizer` fail closed with the window error code.
- The staff UI uses the existing `ae:start` → input → binding → `ae:confirm` → `Store.submit(ids, fence)` path. In canary mode
  the draft carries the admitted `request_id` instead of a random UUID, the binding list contains only the admitted binding,
  the start button appears only on the admitted ticket, and rework is hidden and denied.
- `support-conclusion-v1`, the bridge wire schemas, check/fact and conclusion shapes and `execution_allowed: false` are unchanged.
  The only shared tightening: a collector lease never extends past task expiry, because publication after expiry was already
  rejected.

## Config contract (YAML in `config/config.yaml`; JSON-neutral shape)

```yaml
ai_engineer_enabled: true          # default false
ai_engineer_scope: most-support-vm3902
ai_engineer_mode: canary           # default 'standard'
ai_engineer_canary_admission:      # default null
  schema: support-engineer-canary-admission-v1
  deployment_scope: most-support-vm3902
  ticket_id: 4242
  request_id: "40000000-0000-4000-8000-000000000004"   # UUIDv4, lowercase
  revision: 1
  expected_owner: "2"              # quoted string Telegram id, or null. Unquoted YAML 2 is a number and fails closed
  ticket_epoch: 3
  requested_by: "2"                # quoted; must be in staff_roles and authorized for the ticket
  binding_id: canary
  binding_version: 1
  profile_id: host-info-v1
  base_policy_digest: "<64 lowercase hex>"
  issued_at: 1700000000000         # epoch ms
  expires_at: 1700003600000        # epoch ms; expires_at - issued_at in (0, 3600000]
```

Exactly these 14 keys are allowed. Validation, in order (the first failure is the error code):

| Condition | Code |
|---|---|
| mode absent/`standard` and admission non-null | `canary_mode_required` |
| mode not in {absent, `standard`, `canary`} | `canary_mode_invalid` |
| admission null/absent in canary mode | `canary_admission_missing` |
| canonical size > 2048 bytes | `canary_admission_oversize` |
| missing/extra key, bad UUID/schema/ints/ids/binding_id/digest syntax | `canary_admission_invalid` |
| `profile_id` ≠ `host-info-v1` | `profile_denied` |
| `deployment_scope` ≠ configured scope | `scope_denied` |
| `ai_engineer_enabled` ≠ true, or `base_policy_digest` ≠ live base digest (any staff/role/scope change) | `canary_policy_mismatch` |
| `requested_by` not in `staff_roles` | `canary_actor_unknown` |
| non-positive/oversized window | `canary_ttl_invalid` |
| at runtime: `now < issued_at` / `now >= expires_at` | `canary_not_started` / `canary_expired` |
| tuple mismatch at submit/compute | `canary_not_admitted`; missing caller ids: `canary_identity_required` |
| rework/continuation in canary mode | `canary_rework_denied` |

Any parse error leaves canary mode in a fail-closed state: nothing is admitted, claimed, renewed or published. A typo can never
fall back to standard mode.

## Canonicalization and fingerprints

`canonical(x)`: UTF-8 JSON with no whitespace. Object keys are sorted by UTF-16 code unit (all keys here are ASCII, so this
equals Python `sort_keys`). Strings use JSON escaping (all admission strings are ASCII by validation). Only safe integers,
`true`/`false`/`null`. Arrays keep their order. In Python, `json.dumps(x, sort_keys=True, separators=(',', ':'), ensure_ascii=False)`
gives the same bytes for these inputs. `sha256` is lowercase hex.

1. `base_policy_digest = sha256(canonical({enabled, scope, staff, profiles:["host-info-v1"], generation_backend:"ainoc-aor",
   conclusion_protocol:"support-conclusion-v1"}))`. `staff` is `[{telegram_id: string, role}]` sorted by `telegram_id`. This is
   exactly the existing standard policy fingerprint, computed with `enabled: true`.
2. `admission_fingerprint = sha256(canonical(admission))`, covering all 14 fields.
3. Canary policy fingerprint (stored as the task's `policy_fingerprint`):
   `sha256(canonical({mode:"canary", base_policy_digest, admission_fingerprint}))`.
   Fail-closed state: `sha256(canonical({mode:"canary", base_policy_digest, error}))`. No task is ever created under it.

This is not cyclic: the admission binds only the base digest, and the policy fingerprint binds both. The clock is excluded, so
expiry never makes a task "not current" and never blocks human control.

Vectors: `test/fixtures/support-engineer-canary-admission-v1.json` contains the base pre-image and its pinned digest
(`7719cd0b…cf69c`), the admission pre-image (exact canonical bytes), the canary pre-image template and three fail-closed
pre-images. The suite asserts JS canonical bytes == fixture bytes and `sha256(bytes)` == the computed fingerprint. The hex for
the admission and canary fingerprints is defined by these pre-images. Pin it in the AINOC adapter from `sha256(admission_canonical)`.

## Gate semantics

| Operation | Identity (fingerprint + exact tuple) | Window |
|---|---|---|
| submit (staff confirm) | required, caller-supplied ids only | required |
| claim-checks / claim-summarizer / summarizer-status (heartbeat) | required | required |
| publish-checks / publish-conclusion / fail-conclusion (new result) | required | required |
| exact accepted receipt replay (lost ack) | read-only recognition: no write, audit, lease, catalog or model call | not required |
| handoff / cancel by an authorized role | current task only | **not required** (works after expiry) |
| repair / outbox / expiry / stale invalidation | not required | not required |
| rework / continuation | denied in canary mode | — |

- Task TTL = `min(created_at + 15 min, admission.expires_at)`. Summarizer and collector leases are capped by it. Restarts do not
  extend anything, because the window is absolute config data. A late restart expires the task via `repair`.
- Ownership transfer, close, reopen and ban still go through the existing epoch-bumping paths. The old task becomes `stale` in
  `repair`, and the ticket is never trapped. New AI work on it needs a new admission.
- Any admission, staff/role, scope or enable change changes the fingerprint. In-flight work is then fenced (`authority_changed`)
  and repaired to `stale`.
- Any other pending/ordinary job, including one created earlier in standard mode, is neither selected nor claimable. Startup
  under canary bumps its epoch (`EngineerWorker.initialize`), so switching back cannot revive it.
- **Rollback/finish = `ai_engineer_enabled: false`.** Switching to `ai_engineer_mode: standard` while still enabled is NOT a
  rollback: it re-admits every ticket under standard rules. The start gate below must forbid it.

## Preparing the exact tuple before approval (no customer data)

1. While the feature is disabled (current state), a staff member creates a dedicated ticket through the existing **manual
   intake** (`messenger: manual`, no client channel). They use neutral synthetic text and no customer content. The owner names
   this ticket as the canary target. It is an owner-approved target chosen by `ticket_id`, not a marker recognized by prefix or
   model assertion.
2. The owner takes it (`Взять`) or leaves it unassigned. Then the owner reads only authority fields with a projection, for
   example `{ticketId, status, assigned_to, ai_epoch, "ai_engineer.state", "ai_engineer.revision", "ai_engineer.continuation"}`.
   This is a read-only Mongo projection, done by the owner and not by this change. Never load history/messages.
   Requirements: `status` ∈ {open, waiting_user}; `ai_engineer` null, or terminal with no `continuation` and no pending
   outbox. Otherwise the startup fence bumps the epoch and the tuple becomes unreachable.
3. Set `revision = (ai_engineer?.revision ?? 0) + 1`, `ticket_epoch = ai_epoch ?? 0`, `expected_owner = assigned_to ?? null`.
   `requested_by` is the staff id who will press the button (an admin/supervisor, or the owner-agent). Generate a fresh
   UUIDv4 `request_id`. Compute `base_policy_digest` from the exact `staff_roles`/scope that will be deployed. Use a binding that
   the AINOC catalog will publish for this scope.
4. After approval, choose `issued_at`/`expires_at` (≤ 1 h), write the config and hand it off (below). The staff member then
   opens the ticket card → «ИИ-инженер» → enters a synthetic goal → picks the single binding → confirms. Authority does not
   depend on the goal text.

## Typed canary-start gate (AINOC controller/installer adapter) — dependent, not implemented here

```json
{
  "schema": "support-engineer-canary-start-gate-v1",
  "deployment_scope": "most-support-vm3902",
  "bot_commit": "<merged, independently APPROVED bot candidate sha>",
  "installer": { "task_id": "<installer task>", "commit": "<sha>", "activation_ready": true,
                 "independent_verdict": "APPROVE", "open_defects": [] },
  "config_handoff": { "app_update_receipt_id": "<id>", "config_sha256": "<verbatim from receipt>" },
  "admission": { "...": "exact 14-key object parsed from the handed-off config bytes" },
  "admission_fingerprint": "<sha256(canonical(admission))>",
  "base_policy_digest": "<recomputed from handed-off staff_roles/scope>",
  "canary_policy_fingerprint": "<recomputed>",
  "owner_approval_ref": "<approval record>",
  "evaluated_at": 1700000001000
}
```

The result is `START` only if every check holds. Otherwise it is `BLOCKED{reason}`, and `UNKNOWN` is treated as `BLOCKED`:
- the installer `activation_ready === true`, an actual independent APPROVE exists for the installer and for this bot change,
  and `open_defects` is empty (R4/R5 closed). **Currently false → BLOCKED**;
- the adapter recomputes `sha256(config bytes)` and it equals the app_update receipt `config_sha256` verbatim. The adapter
  never edits, regenerates, re-serializes or skips this check. Any config change requires a new owner handoff and a new receipt;
- the admission parsed from those bytes passes the rules above, and the three digests match the recomputation;
- the config has `ai_engineer_enabled: true` and `ai_engineer_mode: canary`. `evaluated_at ∈ [issued_at, expires_at)`;
- AINOC's own model admission/budget is still authoritative. This gate only allows the controller to start polling the bridge.

Stop: on `canary_expired`, a terminal state, or any error, the controller stops polling. The owner hands off config with
`ai_engineer_enabled: false`.

## Tests (mock/fixture only — not live E2E)

`test/ai-engineer-canary.test.ts`: parser and fail-closed matrix, vectors, window boundaries, Store with an in-memory CAS
(both stages, TTL boundary, late restart, heartbeat after expiry, accepted-receipt replay, handoff/cancel after expiry by role,
owner transfer, role/admission/standard/disabled switches in flight, ordinary pending job cannot be claimed/revived), Mongo CAS
filter shape, bridge selection queries and operations. `test/ai-engineer-canary-ui.test.ts`: existing start/confirm path with
admitted UUID, mismatch matrix, no customer send, hidden rework. `test/ai-engineer-worker.test.ts`: canary startup revokes
ordinary jobs.
