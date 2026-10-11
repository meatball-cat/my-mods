#!/usr/bin/env bash
# Every check CI runs (.github/workflows/ci.yml). Run it before pushing:
#   bash scripts/ci.sh              # validate, test, repo rules
#   bash scripts/ci.sh origin/main  # also require a version bump for each changed mod
# Needs `claude` on PATH. Runs every check, then exits 1 if any failed.
set -uo pipefail
cd "$(dirname "$0")/.."
base="${1:-}"
failed=()

run() {
  local name=$1
  shift
  if [ -n "${GITHUB_ACTIONS:-}" ]; then echo "::group::$name"; else echo "== $name"; fi
  "$@" || failed+=("$name")
  if [ -n "${GITHUB_ACTIONS:-}" ]; then echo "::endgroup::"; fi
}

run "validate marketplace" claude plugin validate --strict .
for manifest in */.claude-plugin/plugin.json; do
  mod=${manifest%%/*}
  run "validate $mod" claude plugin validate --strict "$mod"
  if [ -n "$(find "$mod" \( -name '*.test.ts' -o -name '*.test.tsx' \) -print -quit)" ]; then
    run "test $mod" claude plugin test "$mod"
  fi
done
run "repo rules" python3 scripts/check_repo.py ${base:+--base "$base"}

if [ ${#failed[@]} -gt 0 ]; then
  for name in "${failed[@]}"; do
    if [ -n "${GITHUB_ACTIONS:-}" ]; then echo "::error::$name failed"; else echo "FAILED: $name"; fi
  done
  exit 1
fi
echo "All checks passed."
