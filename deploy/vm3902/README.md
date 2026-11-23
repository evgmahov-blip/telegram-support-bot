# VM3902 replacement candidate (not an activation record)

This directory is a reviewed-candidate input for the owner-authorized replacement of Balbuto. Preparing it does not authorize a live change. Production activation remains behind the existing AINOC/root gates and must preserve the VM's Xray, firewall, transparent redsocks, DNS and admin-access topology.

## Fixed boundaries

- For a fresh install only, prepare a private source YAML from `config-sample.yaml` and supply a token through the approved secret path. Use `prepare-config.cjs` as described in `PERSISTENCE.md`; existing installations must migrate the current YAML byte-for-byte instead of using the sample. No token is included here and no old bot token may be reused.
- The deployment IDs are owner `79813552`, staff supergroup `-1003918239593`, and expected bot ID `8932572525`. These are historical template identities, not a current-instance inventory. Reconfirm them and preserve current engineers and staff_roles with the owner before any switch; do not replace current roles with sample defaults.
- AI, autoreplies, webhooks, optional messengers and both HTTP features are off. Privacy, role checks, lifecycle CAS and append-only history remain in force. There is no ticket-to-AOR integration.
- Open PR #10 is a separate pending ingress-history dependency; this candidate neither includes nor reproduces it.
- The bot is dual-homed only between the external `tg_support_bot_internal` network and the internal Mongo network. Mongo has no published port. The only host publications are loopback `8080` and `8081`, for currently disabled features.
- The old bot owns `172.31.109.3`; the candidate must not start until the old poller is stopped and that address is released. Existing DNS is `172.31.109.1`. Do not add proxy variables, listeners, networks or direct-egress paths.
- Containers have no autonomous Docker restart policy. The foreground Compose process is supervised by systemd only after firewall/DNS prerequisites, preventing Docker daemon startup from bypassing the reboot gate.
- The Mongo healthcheck uses exec-form `mongosh` with a literal JavaScript expression. That expression reads the bootstrap credentials from `process.env` inside `mongosh`, authenticates against `admin`, and reports healthy only after a successful ping; credentials are never placed in the probe's command-line arguments.

The root filesystem remains read-only. Only the private configuration directory is writable by UID/GID 1000:1000; it contains YAML, sibling locks/temporary files, and the existing optional redacted debug log. See `PERSISTENCE.md` for migration and acceptance gates.

## Candidate validation (synthetic services only)

Configuration and Docker validation are separate jobs in `most-core-ci.yml`.
The configuration job uses Node 24 and `npm ci --ignore-scripts` from the tracked
lockfile, then runs the deployment packaging and read-only logger regressions.
It does not build an image or create a runtime configuration containing a token.
The existing full build/unit-test job remains required as well.

The Docker job uses its own checkout and does not install dependencies into it.
Run the same validation on an isolated Docker-capable CI host after the
orchestrator creates the new candidate commit:

```bash
node scripts/docker-validation.cjs <full-new-candidate-sha> /tmp/support-bot-docker-result
```

The runner exports only that commit with `git archive` into a temporary clean
context. It builds a separate test image with `npm ci`, compiles TypeScript,
runs the complete Jest suite without network access, then builds the production
Dockerfile independently. Both builds disable layer-cache reuse and refresh the
pinned base. A non-root, read-only, network-disabled production container checks
Node 24, required runtime/native modules and ERROR logging against the non-secret
sample configuration. It overrides the entrypoint and never starts polling,
Compose, MongoDB, production networks or the live bot.

`result.json` records the exact commit SHA, outcome, step exit codes, image IDs
and timestamps; adjacent logs contain diagnostics. CI uploads these artifacts
also on failure. Only `status: passed` with all expected stages for the new SHA
is evidence of this Docker run. A missing runtime, failed test or missing stage
is not success. Temporary source and validation images are removed afterwards.
The Dockerfile pins Node 24.15.0 / Alpine 3.22 by digest.

The source candidate is input only: its approvals, exhausted review budget and
SUCCESS/UNKNOWN effects do not carry over. This task must pass existing AOR
admission, a fresh independent review and CI for the new SHA. These checks grant
no production permission; release and activation still require their separate
gates. No live installation is changed by this validation.

## Proposed pre-switch checks

These are operator steps for a later approved production window, not actions authorized by this candidate.

1. Reconfirm `/root/support-bot-rollback-20261014` and its database/archive checks without modifying or deleting it or the old PostgreSQL data.
2. Confirm the external network is still `172.31.109.0/24`, bridge `tgbot0`, gateway/DNS `172.31.109.1`, and protected bot address `172.31.109.3`. Record effective firewall/NAT counters proving TCP from `.3` is transparently redirected, direct outbound is rejected if that path fails, and DNS from `.3` is restricted to `172.31.109.1:53`. Confirm the existing firewall, DNS, redsocks and Xray path are healthy.
3. Validate the Compose model and exact reviewed image without starting a poller. Stop on any placeholder, unexpected network, public Mongo port, unpinned Node base or failed local test/build.
4. Through the existing approved VM3902 proxy path only, use the securely supplied new token for read-only `getMe`, `getChat` and `getChatMember` checks. Require `getMe.id == 8932572525`, chat ID `-1003918239593`, owner membership, bot membership and adequate bot permissions. These calls are identity/permission checks only and do not prove polling safety.
5. Obtain fresh independent review of the integrated final SHA through the current registered AOR route. Historical review/escalation records do not authorize this candidate; do not reset or retry old tasks.

## Proposed switch and verification

Only after all production gates and explicit final approval:

1. Stop the old poller through `tg-support-stack.service`, confirm `telegram_support_bot` is stopped, and confirm `172.31.109.3` is released. Never run both pollers.
2. Install the reviewed unit, daemon-reload, disable the old unit so reboot cannot resurrect it, then enable/start the new unit. Do not alter Xray/firewall/DNS/redsocks.
3. Confirm exactly one poller, healthy Mongo, bot address `.3`, no published database port, only loopback `8080/8081`, and no unexpected networks/listeners. Confirm the recorded redirect/DNS counters increment and there is no direct-egress accept path.
4. With the owner, run a bounded user/staff canary covering anonymous replies, identity hiding, current owner/admin protections, ownership/lifecycle CAS, append-only history, and disabled AI/webhooks/integrations. A separately approved process-exit test must be recovered by systemd. A separately approved reboot test must start only the new stack and only after its firewall/DNS prerequisites.

## Proposed rollback

On any failed check, stop the new unit and confirm its poller is gone before re-enabling and starting the archived old unit through its existing fail-closed prerequisites. Preserve the new Mongo volume, old PostgreSQL database and `/root/support-bot-rollback-20261014` for investigation; do not delete them.

The detailed integrated-candidate plan in ../../docs/INTEGRATED_CANDIDATE.md governs
current-instance preservation, whole-stack unit stopping, backups and rollback.
