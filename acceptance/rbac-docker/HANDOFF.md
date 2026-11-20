# AOR continuation: RBAC Compose acceptance over PR #55

Status: BLOCKED pending controller publication, real Actions execution and fresh
independent AOR review. This editor has not created a commit or a PASS artifact.

Verified through GitHub: PR #55 head is
`d7da31bc182b71136a6b884200e02bdfd343fe23` (the managed worktree base).
The restored fixture is from PR #54 head
`c1a98f4751555d6b838c81b2aaf427ad2a00f295`.
Application inputs remain pinned to #51
`e48f6e5a520d9d04af4a4a36f4684e1794274ca1` and #52
`c4add43d45c34c1c74c9ae8b7b0a952b9ae15e8d`, relative to
`e72be3e2b8d0fd74f941cd3f2a2b257d04f2b58e`.
Historical CI IDs in provenance are source references, not current acceptance.

The dedicated job checks the new candidate head and #55 ancestry, verifies the
source pins, applies the package delta without heuristic conflict resolution,
and exports a clean integrated Git tree for Docker. Existing #55 CI jobs remain.
The integrated checkout installs its lockfile dependencies separately from the
archived build context. NODE_PATH explicitly selects that node_modules for the
unchanged host check-runtime.cjs under Node 24, including through sudo. A CI
assertion checks the actual yaml resolution and absence of node_modules in the
Docker context. No deployment checker or application source is changed.

Compose runs ephemeral MongoDB and the actual application handlers with synthetic
Telegram transport on an internal network. The restored matrix checks first
callback answer, consumed update_id with a fresh valid confirmation and a fresh
update control, stale confirmation, rights revoked after preview, exact audit
counts, runtime/YAML persistence after process restart, application undo and
stopped-writer backup restore. result.json reports each scenario separately;
uncompleted scenarios cannot appear as PASS. The transport build context allows
only its Dockerfile and transport.cjs.

Local checks: two runner failure tests PASS; Bash/JS/Python syntax PASS;
workflow and Compose YAML parsing PASS. Local Node is v22.23.2. No Docker/gh
executable or callable AOR publication/CI-start/review endpoint is available in
this editor session. Git execution is denied by the managed environment.
No Node 24, application integration or real Compose success is claimed.

Controller continuation (authorized test CI; no dependency on release #49):

1. Create/publish the new candidate using the existing AOR route. The orchestrator
   owns Git; do not substitute direct GitHub commits for that route.
2. Run MOST Core CI on that exact candidate head. Require the separate
   rbac-docker-acceptance job, its actual Actions URL, and the SHA/run/attempt-bound
   artifact containing provenance.json and result.json with PASS for every
   scenario. A Jest or smoke result does not satisfy this gate.
3. Submit the entire new delta and same candidate SHA for independent review
   through the registered AOR reviewer route, accounting for the restored source
   and new OpenAI changes. Prior approvals do not carry over. This file is a
   handoff request, not evidence that a review was dispatched or approved.
4. Stop before merge and deployment. VM3902, VM4090, live bot, real roles and
   tickets remain outside this task; no such resources were accessed.
