#!/usr/bin/env bash
set -euo pipefail
source_tree=$1
evidence_dir=$2
: "${CANDIDATE_SHA:?}"
[[ "$CANDIDATE_SHA" =~ ^[0-9a-f]{40}$ ]]
test "$(git -C "$source_tree" rev-parse HEAD)" = "$CANDIDATE_SHA"
test -z "$(git -C "$source_tree" status --porcelain --untracked-files=all)"
tree_digest=$(git -C "$source_tree" rev-parse "$CANDIDATE_SHA^{tree}")
mkdir -p "$evidence_dir"
git -C "$source_tree" archive "$CANDIDATE_SHA" > "$evidence_dir/candidate.tar"
tree_sha256=$(sha256sum "$evidence_dir/candidate.tar" | cut -d' ' -f1)
mkdir "$evidence_dir/build-input"
tar -xf "$evidence_dir/candidate.tar" -C "$evidence_dir/build-input"
cat > "$evidence_dir/provenance.json" <<JSON
{"candidate_sha":"$CANDIDATE_SHA","published_tree":"$tree_digest","integrated_git_tree":"$tree_digest","integrated_archive_sha256":"$tree_sha256","workflow_sha":"${WORKFLOW_SHA:-$CANDIDATE_SHA}","source_provenance":{"rbac_sha":"e48f6e5a520d9d04af4a4a36f4684e1794274ca1","package_sha":"c4add43d45c34c1c74c9ae8b7b0a952b9ae15e8d","acceptance_sha":"22e15f97d34daa2081bdc4d6d6a6ab342c929a31","compose_tested_tree":"d48bab7e33789b7ca1b02df2370308f6ef064dc3","source_ci":[44501709927,44515847002,44780813927]},"run_id":"${GITHUB_RUN_ID:?}","run_attempt":"${GITHUB_RUN_ATTEMPT:?}"}
JSON
