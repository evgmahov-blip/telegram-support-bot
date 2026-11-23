# Integrated candidate: controller handoff and separate approval plans

Input manifest SHA-256: 4fcb15a2c9114c54cfccd553838a5b824539f3e6c2a36924936bbd6bf3c86938.
All seven manifest file sizes/hashes and all 61 preimages (including absent paths)
were verified with Python before edits. Archives were validated and read into a
private temporary directory. Git object hashing was independently reconstructed
from file bytes/modes, without Git: base 2d1000a6f91144ddcef9d223399d52b1fbb74742;
#51 7e6a0b4a9dfcf58539bcc02f5c3424adaec93c23;
#52 4d009379670220ea31257342af909fbf03253884;
#57 675be6d0cef060016fdad0644ec86105dc334e67;
compose-tested-tree d48bab7e33789b7ca1b02df2370308f6ef064dc3.

48 app_and_packaging paths came from compose-tested-tree; 13 ci_and_acceptance
paths came from #57. The shared VM README was merged: persistent writable config
directory from #52 plus Node 24/Docker CI explanation from #57. Read-only root is
retained; config is writable. Historical source review artifacts are provenance,
not approval of this candidate. #55 is already included in #57, never applied twice.
Runtime, deployment executables, Dockerfile, both deployment Compose files and
lockfile must match compose-tested-tree byte-for-byte. The only integration edits
beyond transfer are acceptance prepare.sh and workflow head binding, this document,
acceptance HANDOFF, VM README and PERSISTENCE documentation reconciliation.
No application business logic, Mongo schema or data migration was added.
Source approvals/CI listed in the input are evidence for unchanged parts only.

AOR must publish one candidate PR, run required CI and independently review the
final SHA. The editor does not commit, invoke models, change approvals or publish
outside that route. Final head/tree/image/run IDs are assigned by that continuation;
none are claimed here. Do not merge, release or activate. #49 historically had an
expired release attempt CLAIMED with git_failed: a future release needs ordinary
AOR reconciliation, with no manual reset or repeat of the old attempt.

## Separate VM4090 Telegram Desktop decision

Request a separate AOR decision before accessing VM4090 or Telegram. Use a new
test-only token, isolated YAML/Mongo, synthetic accounts and requests; verify bot
identity and no production mounts or endpoints before starting exactly one poller.
Capture exact candidate SHA/image, Desktop version and redacted step evidence.
With owner/admin/supervisor/agent/unprivileged test accounts, open Settings →
Engineers, verify visibility and permitted actions, add/change/remove roles,
protect owner and last admin, and check fresh rights on old cards and commands.
Check first click ACK and visible result, stale confirmation, concurrent admin
change, revoked rights and repeated update (silent ACK, no extra mutation/audit).
Create a request before role edits; verify access, assignment, reply and lifecycle
afterward. Restart Docker/process; verify YAML roles/version/audit and existing
requests survive, first clicks still work, and only one poller runs. Restore the
test backup and check it. Synthetic Compose proves handlers, not Desktop GUI.

## Separate VM3902 switch decision

Before any VM action, request explicit AOR authorization for a bounded window.
Inventory current owner, engineers and staff_roles privately; reconcile with owner,
not sample defaults or the historical sole-admin assertion in the old template.
Record current immutable image/package, unit and ExecStart/Stop, Compose file order,
environment, overrides, restart policy and actual mounts/security/network model.
Preserve firewall/DNS/Xray/redsocks and existing access topology.

Privately back up current YAML byte-for-byte with mode/ownership, launch config,
unit/overrides and old image/package. Take a logical Mongo backup and demonstrate
restore into a separate isolated temporary database, including current requests,
roles/permissions and counts. Keep credentials and production digests out of public
artifacts. Establish RPO/window and a final stopped-writer YAML copy.

Stop only the existing sole poller via its actual supervisor, ensuring no restart
or second unit can resurrect it. The proposed foreground Compose unit manages the
whole stack: stopping it can stop Mongo too. Inspect actual unit behavior first;
plan a bot-only stop with supervision held, and separately approve any database
interruption. Do not blindly stop a whole-stack unit assuming Mongo stays running.
Confirm no poller/writer before copying current YAML using prepare-config dry-run,
install, check; compare source/destination bytes privately. Never seed from sample.
Use the same full Compose/override sequence for check-runtime and launch. Verify
UID/GID 1000, private directory 0700/YAML 0600, writable directory mount, read-only
root, dropped caps, no-new-privileges, one replica, no public Mongo and unchanged
network prerequisites. Install/switch package and supervision only under approval;
start exactly one poller, confirm process/image/mount identities and health.

Canary: owner/current engineer permissions, old requests, first button response,
role save and audit, process restart persistence, no duplicate poller or updates.
Rollback immediately for lost requests/rights, failed persistence, duplicate poller,
identity/network mismatch or unavailable essential handlers. Stop new poller first;
retain new YAML/audit and all new Mongo activity. Restore old package/image/unit,
Compose/overrides and compatible prior YAML only after reconciling post-switch role
changes. Restart exactly one prior poller. Do not overwrite Mongo with the preflight
backup: that would discard new requests/activity. Any data restore requires a
separate approved reconciliation plan. Preserve all evidence and failed package.

## Editor validation

npm ci --ignore-scripts completed; npm run build passed; npm test passed all
76 suites / 951 tests. Two acceptance runner failure tests passed. Bash and JS
syntax and workflow/Compose YAML parsing passed. Local runtime was Node v22.23.2;
Node 24 and real Docker Compose were not run (Docker unavailable). These remain
required CI gates, not waived checks. No callable AOR publication/review/CI-start
endpoint was exposed to this managed editor; return this working diff to the
controller for the authorized publication/review sequence.

INTEGRATION_PATH_VERIFICATION.json lists expected/actual hashes for every supplied
path plus Dockerfile/package/lockfile. Differences are only the five reconciled
or adapted paths: workflow, prepare.sh, acceptance HANDOFF, VM README, PERSISTENCE.
This plan and the verification JSON are two new integration evidence files.
All remaining original base files were checked byte-for-byte against base.tar.
