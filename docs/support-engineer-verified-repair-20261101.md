# Existing support bot: verified bounded repair, 2026-11-01

Task: `support-engineer-bot-verified-repair-20261101`; trusted managed base: `b0890003ba39c99c7962bf1a8834986668771290` (AOR handoff, not independently queried with Git). Manifest and native architectural reassessment were read first. Prior `c103ffbe17a32baffe76e1790881f1117ed3b19a` proposal, both reviews and actual failing log were treated as evidence, not approval. Only the inspected bridge/catalog/UI hunks and relevant tests were ported onto this base. Old task/history/reviews were not edited. No commit was made; AOR owns provenance and commits.

## Delivered behavior

- `src/ai-engineer-bridge.ts:54` and `:176`: exact accepted conclusion receipt is recognized before live authority/catalog/facts checks, after matching request/revision/authority/policy. Stored claim, snapshot and normalized result must match, and no live compute lease is accepted. Response retains the original `awaiting_operator` status after handoff, cancellation or stale repair. Exact accepted failure retains `failed`. Replay does not publish, CAS, emit audit/outbox, archive or repair.
- `src/ai-engineer-bridge.ts:217`, `src/ai-engineer-catalog.ts:14`: fresh catalog publication requires a valid absolute canary window and exactly the admitted binding/version/profile, with expiry no later than admission expiry. Validation precedes persistence. Standard validation remains unchanged.
- `src/ai-engineer-ui.ts:34`, `:127`, `:182`, `:309`: readiness has its own readable failure after staff-surface validation, before authorization. Failure reasons and callback hints are bounded Russian text. Canary does not offer retry/rework; standard start after terminal work remains available (including real cancellation). Duplicate ternary removed. Existing conclusion/history navigation is retained.
- `test/ai-engineer-bridge.test.ts`: real `EngineerStore` over mocked persistence; create/acknowledge/collector/finishChecks/acknowledge/claim/finishConclusion/repair before handoff or cancel, separate jobs per test. Owner and epoch changes drive real repair to stale. Exact replay asserts no write methods; foreign result/snapshot/claim/request after every transition refuse without persistence writes.
- `test/ai-engineer-canary.test.ts`: real validate/publish catalog with `models.AIEngineerCatalog` persistence mock; exact canary and unique standard bindings pass; foreign identities/profile, excessive TTL and empty canary catalog fail before write.
- UI tests use valid parsed admission and a task under that same fingerprint, actual compose collision helper mocks, null failure code, all failure-status labels and known callback hints, unknown-code fallback, no raw codes/secrets, and no fictitious canary retry.

## Authority and lifecycle audit

| Source reference | What was checked and result |
| --- | --- |
| `src/ai-engineer-authority.ts:4`; `src/ticket-ownership.ts:20`, `:58`; `src/ticket-state.ts:25` | Authority updates increment epoch only when status/owner/category changes; assignment and transfer use the update helper. No new authority mechanism needed. |
| `src/ai-engineer.ts:78`, `:138`, `:190` | Role/policy fingerprint includes sorted staff roles and backend/protocol/profile; canary fingerprint binds the full admission, including owner. `current` checks ticket, owner, epoch, scope, fingerprint, admission and requester authorization. |
| `src/ai-engineer-worker.ts:17`, `:36`, `:45` | Startup revokes old policy work via epoch before bounded repair, initializes indexes before readiness, processes maintenance in bounded batches, and clears readiness/stops scheduling before a 5000 ms drain. Tick resets busy in finally; per-ticket errors defer repair with bounded log text. |
| `src/ai-engineer-readiness.ts:1`; `src/index.ts:107`, `:131` | Readiness starts false; startup failure is caught while ordinary support remains active; scheduling requires successful initialization. Shutdown stops engineer before addon shutdown. No new timer was introduced. |
| `src/permissions.ts:11`, `:68`; `src/ai-engineer-ui.ts:28`, `:34` | Staff chat/thread middleware and UI surface gates remain, followed by readiness and fresh role/owner authorization. Readiness hint does not bypass authorization. |
| `src/ai-engineer-store.ts:81`, `:136`, `:246`, `:252` | Persistence CAS binds current owner/status/epoch and previous request/version; computational writes additionally check window/admission. Human cancel and handoff use active authority. Repair acknowledges pending projection before invalidating changed authority; terminal archives remain immutable. Read-only bridge receipt path runs before these writes. |
| `src/ai-engineer-ui.ts:191`, `:231`, `:261`; `src/ai-engineer.ts:316` | Conclusion/section text is HTML-escaped, evidence references must exist in collected facts, history revisions remain browsable. Handoff/cancel require actor-bound one-shot intent. Card refresh remains existing behavior; no extra notifications added. |
| `src/staff.ts:160`, `:174`, `:239`, `:375`; `src/ai-engineer-ui.ts:119`, `:269` | AI text is consumed before generic staff reply routing. AI prompts target the staff chat; handoff only changes internal state. Customer delivery remains the explicit staff reply path with permission, prompt/surface, reservation and completion checks. No automatic send of conclusion/customer draft was added. |

The audit found the small standard-mode terminal-start regression in the ported UI; it was corrected and covered through real cancel/acknowledge. No further confirmed defect required authority/worker/readiness/index/permissions/store changes within this bounded scope. This is source inspection plus mocked tests, not a live-system assurance.

## Wire and known limits

`publicEnvelope` (`src/ai-engineer-bridge.ts:33`) has no `expected_owner` expansion. Owner remains bound by admission fingerprint, `canaryMatches` and current ticket authority. Snapshot v1 fixture bytes were not edited (SHA-256 `081e5406866cf4eacdf53435b5164c74fefde2caf54c5041723be6d59c1974eb`). AINOC fingerprint guard coordination remains a separate task; bot tests do not establish its readiness.

Empty canary catalog publication refuses with `binding_unavailable`; it is not a revocation mechanism. `readCatalog` (`src/ai-engineer-catalog.ts:47`) uses ordinary freshness validation without admission, so an unexpired standard catalog may remain readable after switching modes. Selection/admission/current checks and UI binding filtering still restrict work to the admitted identity. Catalog TTL does not extend the absolute admission window. Profile remains `host-info-v1`, read-only only.

All executions below were offline mocks/fixtures: no live Mongo, Telegram messages, customer data, model calls, canary E2E, release or activation. MiMo/model config and external AINOC source were not changed. Independent native Opus review has not run in this editor session; there is no self-approval. AOR should submit this green candidate to its native reviewer, maximum two fresh reviews under the adopted plan; after two REVISE outcomes stop and reconsider.

## Actual verification

Standalone writable export: `/tmp/support-engineer-verified-vawl_4tm`. Copied src/test, package manifests, tsconfig and Jest configs; excluded .git, runtime config, secrets, state, dependencies and build output. Packaging verification additionally needs the existing non-secret `Dockerfile`, `.gitignore`, `deploy/vm3902/config-sample.yaml`, `compose.yaml`, `most-support-bot.service`; these were copied as plain data, never executed. No managed-worktree symlink, build output, chmod, ignore edit or Git refs were created.

Node PATH: `/opt/ainoc-project-artifacts/support-bot/test-runtime-node24/node-v24.22.2-linux-x64/bin`, actual `node --version`: `v24.22.2`. Export-only node_modules link points to manifest-verified fresh dependencies at `/opt/ainoc-project-artifacts/support-bot/verify-c103ffbe-20261101/node_modules`. No install was run. Current package-lock SHA-256 was verified as `dd927f5e6663c91ec79d2b56fd84ddd73f5ad11b690978ac4595c35aa088532b`. All exported src/test files were byte-compared to the managed candidate before delivery. Jest uses repository setup mocks and NODE_ENV=test; no runtime config was copied.

Commands executed in that export with the Node PATH above:

```sh
npm run build
npm test -- test/ai-engineer-bridge.test.ts test/ai-engineer-canary.test.ts test/ai-engineer-canary-ui.test.ts test/ai-engineer-ui.test.ts test/ai-engineer-worker.test.ts
npm test
```

| Final command | Actual result |
| --- | --- |
| build | exit 0, TypeScript compilation succeeded |
| focused Jest | exit 0; 5 suites passed; 164 tests passed; 0 failed; 2.217 s |
| full Jest | exit 0; 57 suites passed; 609 tests passed; 0 failed; 7.616 s |

Intermediate evidence was not counted as green: initial focused run had 149 pass/1 fail because a legacy new-claim test mutated receipt and left a projection pending. Replaced it with real acknowledgement and foreign claim payload; next focused run passed 150/150. After adding exhaustive callback coverage and standard terminal-start regression coverage, build and focused ran again with the final counts above. First full run had 56 passing suites and 605 passing/4 failing tests, all in packaging because the initial export lacked its static input files. Only the export was completed with those inputs; no production source/types changed to fit tooling. Full run repeated once for that concrete export failure and passed. No further broad reruns.

Logs remain in export; SHA-256:

- `build.log`: `a60c96f0902ef5503ad3e420b49ddc3fb735a51cb0e4c5c989dd25614caae075`
- `focused.log`: `6c2374081b034ed5c3d09755e6b7e863cbb1b346de6e9113b380e1d4f595f262`
- `full.log`: `ca3344dc70a769c16e8525cbeb75ae05726f5f37ddf20c8543b3dcdd83e8617f`
- `full-incomplete-export.log`: `daf4b3906803ac91243eec90add649fcd60599b74a4be9abe66d8202185b9cdb`

## Operator stop and restore checklist (not executed)

1. Through existing owner/root production gates, disable `ai_engineer_enabled` and use the existing coordinated restart procedure. Confirm readiness false and no fresh AI admission; ordinary support remains available.
2. Expiry of the absolute admission window already denies new computational work. Removing admission while mode remains canary fails closed. Do not treat switching mode to standard while enabled as a safe stop: it restores standard admission behavior.
3. Keep already accepted receipts/outcomes and audit/history intact; let existing projection repair and epoch/policy revocation handle in-flight work. Do not delete ticket state or try to revoke by publishing an empty canary catalog.
4. Stop any separately managed AINOC controller through its existing authorized procedure; this editor installed no service or scheduler.
5. To restore a trial, obtain the existing owner production authorization and separate AINOC guard compatibility evidence, configure a fresh exact bounded admission under the current base policy, and use existing restart/readiness checks. Do not reuse an old request/revision or extend a window through catalog TTL. Deployment/restore remains outside this source-edit task.
