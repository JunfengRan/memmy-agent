#!/usr/bin/env bash
# Builds the "原始 Memmy" checkout that run-recall.ts and run-eval.ts import as the baseline arm.
# Baseline = commit 8684cb57 plus price-filter.patch (a bare 价格/库存/余额 no longer drops L1 recall).
set -euo pipefail

BASELINE_SHA=8684cb570f1b54debcdd45da45f0f02661a76a42
repo="$(cd "$(dirname "$0")/../../.." && pwd)"
target="${MEMMY_BASELINE_DIR:-$repo/../memmy-agent-baseline}"

if [ -e "$target" ]; then
  echo "already exists: $target" >&2
  exit 0
fi

git -C "$repo" worktree add --detach "$target" "$BASELINE_SHA"
git -C "$target" apply "$repo/eval/project-memory/baseline/price-filter.patch"
# One node_modules for both checkouts: two copies in one process break instanceof checks.
ln -s "$repo/node_modules" "$target/node_modules"
ln -s "$repo/Memory/node_modules" "$target/Memory/node_modules"
(cd "$repo" && npm run build -w @memmy/agent-source-core)
echo "baseline ready: $target"
