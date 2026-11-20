#!/usr/bin/env bash
set -euo pipefail
source_tree=$1
package_tree=$2
evidence_dir=$3
base=e72be3e2b8d0fd74f941cd3f2a2b257d04f2b58e
rbac=e48f6e5a520d9d04af4a4a36f4684e1794274ca1
package=c4add43d45c34c1c74c9ae8b7b0a952b9ae15e8d
mkdir -p "$evidence_dir"
# Refuse tracked modifications and untracked build inputs before integration.
for checkout in "$source_tree" "$package_tree"; do
  test -z "$(git -C "$checkout" status --porcelain --untracked-files=all)"
done
test "$(git -C "$source_tree" rev-parse HEAD)" = "$rbac"
test "$(git -C "$package_tree" rev-parse HEAD)" = "$package"
git -C "$source_tree" merge-base --is-ancestor "$base" HEAD
git -C "$package_tree" merge-base --is-ancestor "$base" HEAD
git -C "$package_tree" diff --binary "$base" "$package" > "$evidence_dir/package.patch"
# Only the CI scratch checkout is modified. Never resolve a conflict heuristically.
if ! git -C "$source_tree" apply --3way --index "$evidence_dir/package.patch" > "$evidence_dir/apply.txt" 2>&1; then
  git -C "$source_tree" diff --name-only --diff-filter=U >> "$evidence_dir/apply.txt"
  echo 'BLOCKED: package application failed; exact paths are in apply.txt' >&2
  exit 1
fi
tree_digest=$(git -C "$source_tree" write-tree)
tree_sha256=$(git -C "$source_tree" archive "$tree_digest" | sha256sum | cut -d' ' -f1)
mkdir "$evidence_dir/build-input"
git -C "$source_tree" archive "$tree_digest" | tar -x -C "$evidence_dir/build-input"
patch_digest=$(sha256sum "$evidence_dir/package.patch" | cut -d' ' -f1)
cat > "$evidence_dir/provenance.json" <<EOF
{"base_sha":"$base","rbac_sha":"$rbac","package_sha":"$package","integrated_git_tree":"$tree_digest","integrated_archive_sha256":"$tree_sha256","package_diff_sha256":"$patch_digest","candidate_sha":"${CANDIDATE_SHA:?}","source_ci":[44501709927,44515847002],"run_id":"${GITHUB_RUN_ID:?}","run_attempt":"${GITHUB_RUN_ATTEMPT:?}"}
EOF
