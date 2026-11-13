#!/usr/bin/env bash
# Replays dataset v2 against the legacy (pre-v0.1) project memory and writes a run for
# run-pipeline-eval.mjs. See run-control-legacy.mjs for what is and is not comparable.
#
# Required env (no secrets live in the repo):
#   SUT_ENV_FILE     shell file exporting MODEL, OPENAI_API_KEY, OPENAI_API_BASE for the model under test
#   JUDGE_ENV_FILE   shell file exporting MEMMY_EVAL_JUDGE_* and MEMMY_EVAL_READER_* (the reader is replayed with it)
# Optional: LEGACY_REF (default 44dcbb1e^), WORK_DIR (default /tmp/pm-eval/legacy-<stamp>), PORT (18962), PROXY_PORT (18970)
#
# The server rewrites its own config file, so the config is copied into WORK_DIR first.
set -euo pipefail
: "${SUT_ENV_FILE:?set SUT_ENV_FILE}" "${JUDGE_ENV_FILE:?set JUDGE_ENV_FILE}"
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../../.." && pwd)"
REF="${LEGACY_REF:-44dcbb1e^}"
WORK="${WORK_DIR:-/tmp/pm-eval/legacy-$(date +%Y%m%d-%H%M%S)}"
PORT="${PORT:-18962}"
PROXY_PORT="${PROXY_PORT:-18970}"
mkdir -p "$WORK/src"

(cd "$REPO" && git archive "$REF" Memory package.json tsconfig.base.json tsconfig.json Migrations) | tar -x -C "$WORK/src"
ln -sfn "$REPO/node_modules" "$WORK/src/node_modules"
ln -sfn "$REPO/Memory/node_modules" "$WORK/src/Memory/node_modules"
cp "$HERE/eval-config.yaml" "$WORK/eval-config.yaml"

set -a; source "$SUT_ENV_FILE"; set +a
SUT_MODEL="$MODEL"; SUT_KEY="$OPENAI_API_KEY"; SUT_BASE="$OPENAI_API_BASE"

node "$HERE/usage-proxy.mjs" --upstream "$SUT_BASE" --port "$PROXY_PORT" --out "$WORK/sut-usage.jsonl" > "$WORK/proxy.log" 2>&1 &
PROXY_PID=$!
(cd "$WORK/src/Memory" && \
  MEMMY_MEMORY_PORT="$PORT" MEMMY_MEMORY_DB="$WORK/memory.sqlite" MEMMY_CONFIG="$WORK/eval-config.yaml" \
  MEMMY_SUMMARY_PROVIDER=openai_compatible MEMMY_SUMMARY_ENDPOINT="http://127.0.0.1:$PROXY_PORT/v1" MEMMY_SUMMARY_MODEL="$SUT_MODEL" MEMMY_SUMMARY_API_KEY="$SUT_KEY" \
  MEMMY_EVOLUTION_PROVIDER=openai_compatible MEMMY_EVOLUTION_ENDPOINT="http://127.0.0.1:$PROXY_PORT/v1" MEMMY_EVOLUTION_MODEL="$SUT_MODEL" MEMMY_EVOLUTION_API_KEY="$SUT_KEY" \
  exec npx tsx src/server/index.ts > "$WORK/server.log" 2>&1) &
SERVER_PID=$!
cleanup() { pkill -P "$SERVER_PID" 2>/dev/null || true; kill "$SERVER_PID" "$PROXY_PID" 2>/dev/null || true; }
trap cleanup EXIT

for _ in $(seq 1 30); do curl -s -m 2 -o /dev/null "http://127.0.0.1:$PORT/api/v1/health" && break; sleep 1; done

set -a; source "$JUDGE_ENV_FILE"; set +a
cd "$HERE/.."
MEMMY_EVAL_ENDPOINT="http://127.0.0.1:$PORT" MEMMY_EVAL_SUT_MODEL="$SUT_MODEL" node harness/run-control-legacy.mjs | tee "$WORK/replay.out"
echo "score with: node run-pipeline-eval.mjs <live-run.json from above> --sut-usage $WORK/sut-usage.jsonl"
