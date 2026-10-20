# Central support conclusion protocol

Status: implemented on the bot side and disabled. Protocol: `support-conclusion-v1`.
Production installation, controller changes, bindings, restart, and enablement are outside this patch.

The existing five bridge operations remain byte-compatible. Four fixed operations are added; each request requires
`deployment_scope` and `protocol: "support-conclusion-v1"`. Unknown and additional fields are rejected.

## Operations

- `claim-summarizer`: exact request `{deployment_scope,protocol,claim_id}`, where `claim_id` is UUIDv4. It returns either
  `{protocol,status:"idle",execution_allowed:false}` or a claimed response containing `claim_id`, `lease_until`, the existing
  public task envelope, projected `input`, projected `checks`, `snapshot_digest`, and `execution_allowed:false`.
- `summarizer-status`: exact common binding below. It is a heartbeat, not a read-only status probe. It renews only the same
  live claim and never revives an expired lease or increments the attempt count. Renewal is capped by 120 seconds, task expiry,
  and fact freshness.
- `publish-conclusion`: common binding plus `result`, whose exact six keys are `summary`, `verified_findings`, `hypotheses`,
  `unknowns`, `recommended_next_steps`, and `customer_reply_draft`.
- `fail-conclusion`: common binding plus `code`, limited to `model_unavailable` or `model_output_invalid`.

The common binding is exactly:

```json
{
  "deployment_scope": "most-support-vm3902",
  "protocol": "support-conclusion-v1",
  "ticket_id": 42,
  "request_id": "UUIDv4",
  "claim_id": "UUIDv4",
  "revision": 1,
  "authority_digest": "sha256",
  "policy_fingerprint": "sha256",
  "snapshot_digest": "sha256"
}
```

The model projection contains only redacted operator `goal` and `feedback`, an always-empty `history`, and the existing
validated check projection. It contains no ticket history, attachments, raw database records, canonical host/route, secrets,
or command output. `snapshot_digest` is canonical SHA-256 of `{task,input,checks}` and is frozen into the summarizer claim.
Any later projection mutation is rejected.

The returned `task` envelope is binding-only and includes `requested_by` (a Telegram user ID). Only `input` and `checks`
may enter the model prompt. The envelope, claim ID, and all ticket, request, and user identities must remain outside it.

Every heartbeat, publication, and failure revalidates current ticket authority, revision, owner/epoch through the authority
digest and current checks, policy fingerprint, catalog binding, request/task expiry, fact freshness, claim, and snapshot.
Conclusion validation permits evidence references only from projected facts. Exact duplicate conclusion publication is
idempotent; conflicting replay and results from older revisions are rejected. The draft is internal staff data and is never
sent to a customer automatically.

The bot worker now performs only repair, outbox/archive progression, readiness, continuation, and staff-card refresh. It does
not import or call the local engineer model function and needs no model key for engineer generation. The policy fingerprint
includes generation backend `ainoc-aor` and this protocol, fencing tasks created under the earlier local-generation policy.

## Coordinated disabled rollout

Both bot and controller must remain disabled through installation and independent AOR review. Rollout requires matching
bot/controller protocol fixtures, fresh trusted catalog bindings, and a coordinated restart so the new policy fingerprint
invalidates older work. Do not change Compose/config samples, apply SQL, install controller files, create bindings, restart,
or enable either side as part of this patch. AOR owns model admission, runtime budget, provider selection/health, terminal
receipts, commits, review, and release.

The language-neutral parity fixture is `test/fixtures/support-conclusion-v1.json`.
