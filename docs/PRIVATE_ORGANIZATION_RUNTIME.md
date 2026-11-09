# Private organization reads

The five `organization-{auth,domain,model,repository,router}.ts` sources are
imported byte-for-byte from PR37 (2890e0cb782d906e750349bf5ce1b914c4a3bb95).
`organization-runtime.ts` mounts their read router in the existing events HTTP
server. The existing `api_enabled`, host, port, and shutdown lifecycle apply.
No additional listener or database connection is created.

`organization_private_runtime_module` is an optional absolute path in the
server-owned YAML configuration to a trusted CommonJS module exporting
`PrivateOrganizationRuntimeBinding` (see `src/organization-runtime.ts`).
This is executable operator-managed server code; it must never be writable or
selected by an API client. There is deliberately no default module, instance,
endpoint, credential, or permissive authorizer.

The binding must supply the registered source instance, private read audience,
dedicated workload keys and allowed key IDs, cursor signing secret, atomic
`consumeNonce(keyId, nonce, expiresAtMs)` callback, and `centralAuthorizer`.
Nonce consumption must return true exactly once across all workers/restarts
within the proof validity window; errors fail closed. Do not substitute an
in-process set in a deployed binding.

The central callback uses the separately authenticated workload integration
with AINOC PR920. It forwards the verified `principal_ref`, requested permission
and exact `requested_org` when present, and returns `allowed`,
`principal_enabled`, `rbac_enabled`, `denied`, `org_refs`, and `scope_version`.
Its workload identity/credentials belong to this capability; neither the
legacy events bearer token nor browser assertions authorize private reads.
Connection details and credentials must come from the approved private binding;
this repository does not guess the PR920 endpoint or its transport credentials.

Missing or invalid bindings return 503 for `/internal/v1` paths while legacy
health/events continue. Valid bindings mount the original router, which verifies
HMAC proofs, consumes nonces, and calls central authorization before repository
reads. The repository uses `db.Supportee` and its existing connection and owner
collection namespace. Model auto-creation/indexing remains disabled. This change
does not populate organizations or enable writes of non-null OrgRefs.

Provisioning a real private binding and VM3902 deployment require the owner's
separate release/activation task. The paired consumer is
`ainok-workspace-site-runtime-20261109`.
