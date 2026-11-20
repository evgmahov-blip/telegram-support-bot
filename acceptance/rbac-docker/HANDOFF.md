# Docker acceptance handoff — revision 1

Status: **BLOCKED pending controller candidate publication, CI execution and
independent review**. No real Docker run or integration success is claimed by
the editor. Docker is absent locally; local Node is 22.23.2, not the required 24.
The editor has no callable AOR autodispatch/source-export/CI-start endpoint and
must not commit or publish a substitute candidate via direct GitHub writes.
Controller owns candidate SHA, PR, existing executor/fallback selection and
independent review. Do not merge or deploy this candidate.

Local verification: `npm ci --ignore-scripts --no-audit --no-fund`,
`npm run build`, and `npm test` completed (71 suites, 901 tests passed).
Bash, Python and JavaScript syntax and both YAML documents were checked.
These checks cover the local base plus acceptance files, not the integrated
application or Docker matrix; those are deliberately gated by the new CI job.

Continuation of archived task `support-bot-rbac-docker-acceptance-20261119`,
revision 0, base `e72be3e2b8d0fd74f941cd3f2a2b257d04f2b58e`.
Archive operation reported by trusted user handoff:
`archive-support-bot-docker-claude-stop-v10-20261119` (APPLIED).
Previous attempt stopped before candidate with
`claude_identity_generation_unsuccessful`. This continuation does not replace
historical attempts, cost records, approvals or TaskStore entries.

Preserved source identities and historical evidence (user supplied):

| Source | Exact SHA | Review | Original CI |
| --- | --- | --- | --- |
| PR #51, `ao-rem-c2bae32a3037` | `e48f6e5a520d9d04af4a4a36f4684e1794274ca1` | APPROVE | 44501709927 |
| PR #52, `support-bot-rbac-docker-persistence-20261119` | `c4add43d45c34c1c74c9ae8b7b0a952b9ae15e8d` | APPROVE | 44515847002 |

These prior CI runs are not new acceptance evidence. Neither branch/PR is edited.
The new job in the existing MOST Core workflow checks out both pinned SHAs,
verifies HEAD and base ancestry, and applies only the binary #52-minus-base
diff to a scratch #51 checkout. Any failed application stops without resolution;
`apply.txt` includes exact conflict paths. The Git tree and SHA256 of its Git
archive identify the integrated input; candidate SHA/run/attempt identify the
driver. No commit is manufactured for the scratch tree.

The application Dockerfile builds the exact integrated tree on its pinned Node
24 base. A second, recorded image adds only the synthetic transport driver.
The actual Telegram addon registers its middleware, permissions, Mongo update
deduplication and application callback handlers. The driver replaces Bot API
transport/init and disables external long polling, then calls `bot.handleUpdate`.
No application business module is mocked. This proves server handling, not
Telegram Desktop GUI or external Telegram delivery.

The dedicated Compose project uses an internal network, ephemeral Mongo tmpfs,
no published ports, no external networks/volumes, and no Docker socket. The host
driver controls Docker; the application runs as 1000:1000 with read-only rootfs,
dropped capabilities, no-new-privileges and one writer. Only synthetic config
is writable. The exact #52 runtime checker validates the new mount model and
directory ownership/modes before startup. The read-only stages use the original
single-file mount contract with the same immutable application image. Rollback
stops the writer, fsyncs a sibling backup restore, renames it, fsyncs its directory,
and recreates the service with the old mount contract.

Successful `result.json` must contain PASS and every matrix assertion: read-only
callback refusal, authorized one-entry audit with preserved unrelated fields,
Compose restart with a changed boot ID and identical durable/runtime role,
explicit stale/authority refusals and replay, and backup restore with renewed
read-only refusal. Versions, image IDs and actual inspect mount/security fields
are included. No result.json or failed job means no acceptance. Artifacts contain
only synthetic projections/provenance, never full environment, production logs
or rendered secret-bearing Compose models. Cleanup removes only this isolated
project; source scripts remain available for diagnosis and rerun.

Next controller action: publish this worktree as a new candidate, run its
ordinary PR CI and route that same candidate through existing independent review.
Use the existing dispatcher and its admitted fallback without changing global
models, providers, budgets, approvals or historical accounting. Attach the new
CI URL and `rbac-docker-acceptance-HEAD_SHA-RUN-ATTEMPT` artifact to the new PR. Any failure
remains BLOCKED with its exact CI step/artifact until resolved.


## Revision 2 — Fable REVISE 41e4b03e87ec8357 remediation

The previous PR #53 observation was head
`54209a872ad8e0f093887dd7b9c890f6e31ce6ae`. The trusted controller handoff
identifies the reviewed candidate/checkpoint as
`bda108965311120a779e2f98237e786ab745df3c`. Revision 3 edits below still need
a new controller-owned candidate SHA and a fresh PR head observation; the
checkpoint must not be presented as the SHA of this changed diff.
The saved Fable REVISE 41e4b03e87ec8357 feedback is supplied in this task.
Historical review records and PR #51/#52 remain untouched.

The new matrix checks the first answerCallbackQuery text on success/refusal;
reuses a consumed update_id with a freshly generated, valid confirmation,
then proves that exact confirmation works under a new update_id; invalidates
an old card through a real change by administrator 102; and revokes 102's
rights after preview and before apply. Rejected operations preserve the exact
etag, YAML projection and runtime roles. Accepted operations count audit
entries, restart preserves roles and history, and application rollback is
followed by rejection of its stale repeat. Backup restore still runs only with
the sole writer stopped, and restores the original read-only mount.

The candidate checkout, provenance and artifact name use the PR head SHA
rather than the merge ref. The Docker context is a fresh Git archive of the
recorded integrated tree, separate from npm build/test outputs. Node 24 is
checked in CI and the absolute setup-node executable is passed through sudo
to the runtime checker. Configuration preparation and Docker discovery errors
now produce BLOCKED result.json through the same error handler.

Local verification on Node 24.22.2: build PASS; 71 suites / 901 tests PASS;
Bash/Python/JavaScript syntax and workflow/Compose YAML PASS. Dependency
installation used --ignore-scripts locally; this does not validate native
module installation. CI retains ordinary npm ci and immutable application
Docker builds. See local-evidence/result.json: BLOCKED, not Docker PASS.

Independent local read-only review found sudo PATH and config ownership
issues; the fix keeps the privileged isolated driver with an explicit Node 24
path. This local review does not replace Fable or close its saved verdict.

Controller continuation: publish this diff without altering historical reviews,
run MOST Core CI on the new PR #53 head, require PASS result.json plus its
actual Actions URL and SHA-named artifact, then submit that same diff/SHA to
independent Fable review. Do not merge or deploy. Telegram Desktop remains a
separate check after agreed installation. No VM3902/VM4090 connection or real
role/ticket operation was performed.


## Revision 3 — saved review remediation

Removed tracked Python bytecode and excluded future bytecode from Git and
Docker contexts. Setup now runs inside the evidence handler, so an existing
synthetic lab produces BLOCKED result.json. Cleanup errors are recorded, mark
the run BLOCKED and fail the process without replacing the primary exception.
The matrix now records etags extracted from actual sn:apply callback_data,
checks equality with the file digest, and requires the application token to
change after saving. result.json exposes candidate_sha from provenance and
uses only an actual Actions environment for run_url.

Publication/acceptance remains pending: this editor cannot commit and has no
Docker executable or CI dispatch endpoint. Do not treat previous local checks,
the reviewed checkpoint or local-evidence/result.json as new Docker evidence.
Controller must publish this diff, run MOST Core CI on that exact PR #53 head,
attach PASS result.json and its actual run URL, then submit the same head/diff
for independent review. Preserve Fable REVISE and all earlier review history.
No merge, deployment, VM access, real role/ticket changes or Telegram Desktop
installation is authorized by this handoff.

Revision 3 local validation: Node v22.23.2, TypeScript build PASS, Jest
71 suites / 901 tests PASS; two runner failure regressions PASS via
`python3 -B acceptance/rbac-docker/test_runner.py` (also added to CI). Bash,
Python and transport JavaScript syntax PASS. Node 24 remains a CI requirement;
these local checks do not establish a Node 24 or Docker PASS. Updated local
result.json retains the previous local evidence as historical data.
