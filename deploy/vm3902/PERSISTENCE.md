# Persistent team settings: candidate, not activation evidence

The integrated candidate contains the exact #51 application and #52 package.
Historical source identities and verification are in ../../docs/INTEGRATED_CANDIDATE.md.
No live host, role, request or secret was changed.

## Contract

The container runs as 1000:1000 with a read-only root filesystem, dropped
capabilities, no-new-privileges and one instance. The only persistent writable
bot mount is `persistent-config` at `/bot/config`. Directory mode 0700 and YAML
mode 0600 allow the existing writer to create its sibling lock and temporary
file, fsync and rename the YAML inode. A file bind, even `:rw`, cannot support
that replacement. The same YAML holds roles, version and audit history; there
is no new registry or writer. The existing optional debug log also lives here;
never place backups, unrelated secrets or other configuration files here.

Both checked-in Compose entry points use the directory scheme. There are no
runtime override generators or installation scripts in this base besides the
new offline installer. Startup never copies a sample or regenerates YAML.
Do not run two Compose projects, systemd units or host processes against this
same directory. `scale: 1` is a configuration default, not a cross-project lease.
The existing shared writer lock and single-poller deployment rule remain required.

## Future offline installation / migration (not executed on any VM)

Requires host Node 24, installed repository dependencies, and an unprivileged
installation account whose numeric UID/GID is 1000:1000. Do not run the installer
or bot as root. If the current source is owned by another account, an authorized
operator must arrange private ownership during the future deployment window;
this package does not grant privileges or change ownership automatically.

1. Stop the sole writer/poller using existing approved supervision. Record the
   old immutable package/image identity and complete Compose arguments. Do not
   stop or change the database. A whole-stack unit may stop Mongo too: inspect
   supervision and arrange a bot-only stop before this step, as detailed in
   ../../docs/INTEGRATED_CANDIDATE.md. Inventory runtime overrides and installation
   automation outside the repository; they have not been supplied here.
2. Under the installation account, create a private backup directory outside
   the mounted directory (`umask 077`, directory 0700). Copy the **current** YAML
   with mode 0600 and verify its digest against the original while stopped.
   Keep this backup private and out of version control/build context. Never
   print its contents or attach its digest to public evidence. Preserve the
   old package and original single-file configuration for rollback.
3. In a new immutable package directory on the same filesystem, run from its
   repository root (SOURCE below is that private current YAML, never the sample):

   ```sh
   node deploy/vm3902/prepare-config.cjs dry-run SOURCE deploy/vm3902/persistent-config
   node deploy/vm3902/prepare-config.cjs install SOURCE deploy/vm3902/persistent-config
   node deploy/vm3902/prepare-config.cjs check deploy/vm3902/persistent-config
   node deploy/vm3902/check-runtime.cjs deploy/vm3902/persistent-config --project-name most-support-bot --file deploy/vm3902/compose.yaml
   ```

   The installer validates YAML but deliberately preserves every byte, including
   unknown fields, current staff_roles and team_settings_history. It does not
   apply sample defaults, repair roles or clear history. It refuses an existing
   destination, even when valid. Never run install again at container restart.
4. For **every** generated runtime override, pass the exact `--file` sequence to
   `check-runtime.cjs`, then use the identical sequence for startup. Do not
   persist rendered Compose output containing secrets. The supplied unit checks
   the explicit standalone VM Compose model before launch. Host Node and its
   YAML dependency must be installed before installing this unit.
5. Keep the old package untouched; switch an operator-managed release symlink
   to the new immutable package by renaming a prepared sibling symlink on the
   same filesystem while the service is stopped. Retain the existing service
   working-directory path and all network/firewall/DNS prerequisites. Only the
   future approved activation process may start the service.

The ordinary root `docker-compose.yml` now points at the same private directory;
its startup also requires this preparation. Do not copy an entire repository
config folder into it. The original quick-start copy alone is insufficient for
Docker. Direct npm development continues to use `config/config.yaml`.

## Required isolated Docker acceptance

Use a dedicated runner with Docker Engine and Compose v2, no production networks,
no real Telegram token, private temporary directories and synthetic identities.
The existing acceptance/rbac-docker harness archives the published candidate head
for both application and deployment package. Historical PR pins are provenance only.
Require all 13 scenarios and head/tree/image/run evidence from required CI.

Commands already applicable to this package:

```sh
npm ci
npm run build
npm test
node --version
uname -srmo
docker version
docker compose version
# All laboratory overrides must be explicitly listed for both check and launch:
node deploy/vm3902/check-runtime.cjs LAB_CONFIG --project-name rbac-persistence-lab --file LAB_COMPOSE
# Launch only after the exact source and callback harness are supplied:
docker compose --project-name rbac-persistence-lab --file LAB_COMPOSE up --build -d
docker compose --project-name rbac-persistence-lab --file LAB_COMPOSE restart supportbot
docker compose --project-name rbac-persistence-lab --file LAB_COMPOSE stop
```

`LAB_COMPOSE` is an isolated adaptation of the candidate: no external VM network,
no production IP/DNS, no production database volume and no external Telegram
traffic. It must retain the candidate security and mount contract. It and a test
Telegram transport/callback driver must be reviewed with the exact PR source;
they are supplied in acceptance/rbac-docker and require Docker CI. Never execute the VM
Compose on a production host to obtain laboratory evidence.

Evidence matrix to execute, not assertions of success:

| Step | Required sanitized observation |
| --- | --- |
| Old read-only file/directory bind | Deliver a real menu confirmation callback through application update handling; save fails; parsed role, etag and history unchanged |
| New directory bind | Application boots; same authorized workflow changes synthetic agent to supervisor; exactly one history record; current etag changes; unrelated YAML unchanged |
| Restart | `docker compose restart supportbot`; new process reloads same role and identical one-entry history from host directory |
| Rejections | Stale confirmation, insufficient privilege and replayed callback each leave etag/role/history unchanged; no second audit |
| Restore | Stop writer; restore synthetic backup using sibling temp file, fsync and atomic rename; restore old immutable package/file-bind scheme; start old mode and verify original role/history; save is read-only again |

Capture only synthetic before/after YAML projections, update IDs, callback
outcomes and history counts. Never dump full config, environment, rendered
models or production logs. Synthetic updates with test transport prove server
handling only, not Telegram Desktop GUI operation. Local filesystem tests and
Compose rendering cannot substitute for this matrix.

## Rollback criterion and procedure

Abort on ownership/mount drift, failed boot/save/reload, extra/missing audit,
unauthorized successful write, duplicate writer or failed network prerequisites.
Stop and confirm the new poller is gone. Preserve the failed directory privately.
Restore the synthetic or approved private pre-switch YAML via a sibling temp file
(mode 0600), fsync, atomic rename and directory fsync while stopped. With all
writers stopped, atomically rename the release symlink back to the old immutable
package containing its original Compose/file bind. Verify the effective old
model before starting its sole service through existing gates. Do not use Compose
merge to restore a nested file bind over a retained directory mount. Do not delete
Mongo volumes. A package-pointer rollback is atomic; stop/switch/start is an
outage, not a transaction. Restoring a pre-switch YAML intentionally discards
post-backup settings changes: retain the failed copy for reconciliation.

## Outstanding handoff

No candidate Git SHA, fresh CI or independent dispatcher review exists yet:
AOR owns checkpoint/CI/review dispatch after these edits. Preserve PR #51 and its
original evidence. Required before calling this integrated/verified: exact
SHA-attested #51 source export, Docker-capable isolated runner, reviewed callback
transport/driver, all five matrix results, assigned packaging SHA and CI plus
independent review of that SHA. No available tool in this editor session exposes
an AOR source-export or autodispatch API; no TaskStore/approval/provider changes
were attempted.
