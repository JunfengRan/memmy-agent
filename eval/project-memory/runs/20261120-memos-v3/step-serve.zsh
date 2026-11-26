#!/bin/zsh
# Long-lived server half of run-e2e-wt.zsh for the step-by-step review: chooses models, starts the
# usage proxy (with full prompt traces) and the MemOS replay server, then waits. Keep it running
# across pauses; step-run.zsh drives the replay against it.
# Usage: WT=<MemOS worktree> step-serve.zsh <run-dir> <port>
set -u
: ${WT:?set WT to the MemOS worktree under test}
dir=${1:A}; port=$2; pport=$((port + 1000))
here=${0:A:h}
repo=${here:h:h:h:h}
G=$repo/eval/project-memory/gold-add-memory
PY=/Users/junfengran/repos/MemOS/.venv/bin/python
mkdir -p $dir/usage
stamp() { print "$(date '+%F %T') $*" | tee -a $dir/stages.log; }
[[ -f $dir/models.json ]] || { stamp "choose models"; node $G/harness/model-env.mjs --out $dir/models.json > /dev/null || exit 1; }
sut_profile=$(python3 -I -c "import json,sys;print(json.load(open(sys.argv[1]))['roles']['sut']['profile'])" $dir/models.json)
sut_base=$(python3 -I -c "import json,sys;print(json.load(open(sys.argv[1]))['roles']['sut']['baseUrl'])" $dir/models.json)
[[ -f $dir/usage/stages.json ]] || node $G/harness/memos-stages.mjs ${WT}/src/memos/project_memory > $dir/usage/stages.json
git -C ${WT} rev-parse HEAD >> $dir/memos-commit.txt
git -C $repo rev-parse HEAD >> $dir/eval-commit.txt
stamp "start proxy :$pport and server :$port (sut profile $sut_profile, schema memos_v3_$port)"
node $G/harness/usage-proxy.mjs --upstream $sut_base --embed-upstream http://127.0.0.1:58112/v1 \
  --port $pport --out $dir/usage/sut-calls.jsonl --trace $dir/usage/sut-trace.jsonl \
  --stages $dir/usage/stages.json >> $dir/usage/proxy.log 2>&1 &
proxy_pid=$!
HF_HUB_OFFLINE=1 MEMOS_V3_REPO=${WT} MEMOS_V3_DB=${MEMOS_V3_DB:-add_verify_step} MEMOS_LOCAL_MODEL_PROFILE=$sut_profile MEMOS_V3_THINKING_MODE=disabled \
  MEMOS_V3_LLM_PROXY=http://127.0.0.1:$pport MEMOS_V3_RETRIEVAL=${MEMOS_V3_RETRIEVAL-1} \
  $PY $here/launch_eval.py $port replay >> $dir/server.log 2>&1 &
server_pid=$!
trap 'kill $server_pid $proxy_pid 2> /dev/null; stamp "server stopped"' EXIT INT TERM
ready=0
for i in {1..150}; do
  kill -0 $server_pid 2> /dev/null || break
  curl -s -m 2 http://127.0.0.1:$port/openapi.json > /dev/null && { ready=1; break; }
  sleep 2
done
(( ready )) || { stamp "server failed to start, see $dir/server.log"; exit 1; }
stamp "server ready on :$port (pid $server_pid); Ctrl-C stops it"
wait $server_pid
