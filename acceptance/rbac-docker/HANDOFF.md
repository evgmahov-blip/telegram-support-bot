# Integrated candidate acceptance

Publication, required CI and independent review belong to the controller AOR route.
No commit, PR or passing Docker artifact is created by this editor.

The application and deployment package are now tracked together. prepare.sh verifies
an untouched checkout at CANDIDATE_SHA and archives that exact commit once for both.
Old PR pins are provenance only; no historical checkout or patch is executed.
provenance.json binds published head, Git tree, archive digest, workflow SHA and run
attempt; result.json retains application/transport image IDs and scenario outcomes.
The acceptance job checks PR head; verify, configuration-node24 and docker-validation
use the Actions default checkout (PR merge SHA). Both identities must be recorded
by AOR; merge-SHA success alone does not replace head acceptance.

Compose runs ephemeral MongoDB and the actual application handlers with synthetic
Telegram transport on an internal network. The restored matrix checks first
callback answer, consumed update_id with a fresh valid confirmation and a fresh
update control, stale confirmation, rights revoked after preview, exact audit
counts, runtime/YAML persistence after process restart, application undo and
stopped-writer backup restore. result.json reports each scenario separately;
uncompleted scenarios cannot appear as PASS. The transport build context allows
only its Dockerfile and transport.cjs.

Controller: publish one PR against most-core; require all four jobs and all
13 scenarios on its final SHA, then independent review of that same final diff/SHA.
Return PR number, full head and tree, image IDs, run ID/URL and review decision.
Any later edit requires corresponding final-SHA evidence. Stop before merge/release.
See ../../docs/INTEGRATED_CANDIDATE.md for source verification and separate VM plans.
