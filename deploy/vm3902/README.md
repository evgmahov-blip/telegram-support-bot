# VM3902 replacement candidate (not an activation record)

This directory is a reviewed-candidate input for the owner-authorized replacement of Balbuto. Preparing it does not authorize a live change. Production activation remains behind the existing AINOC/root gates and must preserve the VM's Xray, firewall, transparent redsocks, DNS and admin-access topology.

## Fixed boundaries

- Copy tracked `config-sample.yaml` to ignored `config.yaml`, set mode `0600`, and insert a newly supplied token through the approved secret path. No token is included here and no old bot token may be reused.
- The deployment IDs are owner `79813552`, staff supergroup `-1003918239593`, and expected bot ID `8932572525`. The owner is the sole configured admin. Any change requires owner verification and a new review.
- AI, autoreplies, webhooks, optional messengers and both HTTP features are off. Privacy, role checks, lifecycle CAS and append-only history remain in force. There is no ticket-to-AOR integration.
- Open PR #10 is a separate pending ingress-history dependency; this candidate neither includes nor reproduces it.
- The bot is dual-homed only between the external `tg_support_bot_internal` network and the internal Mongo network. Mongo has no published port. The only host publications are loopback `8080` and `8081`, for currently disabled features.
- The old bot owns `172.31.109.3`; the candidate must not start until the old poller is stopped and that address is released. Existing DNS is `172.31.109.1`. Do not add proxy variables, listeners, networks or direct-egress paths.
- Containers have no autonomous Docker restart policy. The foreground Compose process is supervised by systemd only after firewall/DNS prerequisites, preventing Docker daemon startup from bypassing the reboot gate.
- The Mongo healthcheck uses exec-form `mongosh` with a literal JavaScript expression. That expression reads the bootstrap credentials from `process.env` inside `mongosh`, authenticates against `admin`, and reports healthy only after a successful ping; credentials are never placed in the probe's command-line arguments.

`log_level: ERROR` is compatible with the read-only root filesystem and read-only config mount: errors are redacted and emitted to container stderr; the optional `config/debug.log` append fails harmlessly and never crashes the process.

## Candidate validation (no services started)

From the repository root:

```bash
cp deploy/vm3902/config-sample.yaml deploy/vm3902/config.yaml
chmod 0600 deploy/vm3902/config.yaml
# Replace YOUR_BOT_TOKEN only through the approved secret path.
docker compose --project-name most-support-bot --file deploy/vm3902/compose.yaml config --quiet
npm ci
npm test
npm run build
```

The Dockerfile pins Node 24.15.0 / Alpine 3.22 by digest. Build/run checks require an available Docker runtime and must not be reported as performed otherwise.

## Proposed pre-switch checks

These are operator steps for a later approved production window, not actions authorized by this candidate.

1. Reconfirm `/root/support-bot-rollback-20261014` and its database/archive checks without modifying or deleting it or the old PostgreSQL data.
2. Confirm the external network is still `172.31.109.0/24`, bridge `tgbot0`, gateway/DNS `172.31.109.1`, and protected bot address `172.31.109.3`. Record effective firewall/NAT counters proving TCP from `.3` is transparently redirected, direct outbound is rejected if that path fails, and DNS from `.3` is restricted to `172.31.109.1:53`. Confirm the existing firewall, DNS, redsocks and Xray path are healthy.
3. Validate the Compose model and exact reviewed image without starting a poller. Stop on any placeholder, unexpected network, public Mongo port, unpinned Node base or failed local test/build.
4. Through the existing approved VM3902 proxy path only, use the securely supplied new token for read-only `getMe`, `getChat` and `getChatMember` checks. Require `getMe.id == 8932572525`, chat ID `-1003918239593`, owner membership, bot membership and adequate bot permissions. These calls are identity/permission checks only and do not prove polling safety.
5. Obtain the registered independent AnyModel Qwen review under the existing strict identity, independence and budget rules. The historical task `support-bot-vm3902-replacement-candidate-20261014` remains escalated after unsuccessful Claude identity generation; do not reset/retry it and do not claim APPROVE.

## Proposed switch and verification

Only after all production gates and explicit final approval:

1. Stop the old poller through `tg-support-stack.service`, confirm `telegram_support_bot` is stopped, and confirm `172.31.109.3` is released. Never run both pollers.
2. Install the reviewed unit, daemon-reload, disable the old unit so reboot cannot resurrect it, then enable/start the new unit. Do not alter Xray/firewall/DNS/redsocks.
3. Confirm exactly one poller, healthy Mongo, bot address `.3`, no published database port, only loopback `8080/8081`, and no unexpected networks/listeners. Confirm the recorded redirect/DNS counters increment and there is no direct-egress accept path.
4. With the owner, run a bounded user/staff canary covering anonymous replies, identity hiding, sole-owner admin role, ownership/lifecycle CAS, append-only history, and disabled AI/webhooks/integrations. A separately approved process-exit test must be recovered by systemd. A separately approved reboot test must start only the new stack and only after its firewall/DNS prerequisites.

## Proposed rollback

On any failed check, stop the new unit and confirm its poller is gone before re-enabling and starting the archived old unit through its existing fail-closed prerequisites. Preserve the new Mongo volume, old PostgreSQL database and `/root/support-bot-rollback-20261014` for investigation; do not delete them.
