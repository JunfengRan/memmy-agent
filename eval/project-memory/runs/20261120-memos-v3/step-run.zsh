#!/bin/zsh
# Drives the replay against step-serve.zsh, pausing after each event whose Add or answer is wrong.
# Usage: step-run.zsh <run-dir> <port> [--resume] [runner flags, e.g. --stop-at <event-id>]
# Exit 3 means paused: review pauses/<latest>.json, then run again with --resume.
set -u
dir=${1:A}; port=$2; pport=$((port + 1000)); shift 2
here=${0:A:h}
repo=${here:h:h:h:h}
G=$repo/eval/project-memory/gold-add-memory
cd $repo
export MEMMY_EVAL_BASE=http://127.0.0.1:$port/product MEMMY_EVAL_CLOCK_BASE=http://127.0.0.1:$port
export MEMMY_EVAL_USAGE_PROXY=http://127.0.0.1:$pport MEMMY_EVAL_RUN_TAG=${MEMMY_EVAL_RUN_TAG:-step$port}
# Fall back to the openai or claude profile when the pinned reader or judge stops answering;
# MEMOS_SUT_PROFILE must match the profile step-serve.zsh runs MemOS on.
export MEMMY_EVAL_ALLOW_READER_SWITCH=1 MEMMY_EVAL_SUT_PROFILE_OVERRIDE=${MEMOS_SUT_PROFILE:-}
export MEMMY_EVAL_JUDGE_CACHE=$dir/judge-cache.json MEMMY_EVAL_STEP_SCHEMA=memos_v3_$port MEMMY_EVAL_PROJECT_ID=memos_v3_$port
args=(--out $dir)
if [[ ${1:-} == --resume ]]; then shift; args=(--resume $dir/live-run.partial.json); fi
node $G/harness/model-env.mjs --out $dir/models.json --pin -- node $G/run-memos-v3-live.mjs $args --pause-on-bad "$@" 2>&1 | tee -a $dir/replay.log
exit ${pipestatus[1]}
