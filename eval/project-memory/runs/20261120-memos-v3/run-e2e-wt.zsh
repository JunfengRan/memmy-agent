#!/bin/zsh
# Local end-to-end replay of gold v3 against an isolated MemOS server, with every model call
# recorded by the usage proxy. Usage: WT=<MemOS worktree> run-e2e-wt.zsh <run-dir> <port> [runner flags]
# Runner flags go to run-memos-v3-live.mjs (for example --no-flush). The embedding server
# (embed_server.py next to this script) must already listen on 127.0.0.1:58112.
set -u
: ${WT:?set WT to the MemOS worktree under test}
dir=${1:A}; port=$2; pport=$((port + 1000)); shift 2
here=${0:A:h}
repo=${here:h:h:h:h}
G=$repo/eval/project-memory/gold-add-memory
PY=/Users/junfengran/repos/MemOS/.venv/bin/python
mkdir -p $dir/usage
stamp() { print "$(date '+%F %T') $*" >> $dir/stages.log; }
stamp "choose models"
node $G/harness/model-env.mjs --out $dir/models.json > /dev/null || exit 1
sut_profile=$(python3 -I -c "import json,sys;print(json.load(open(sys.argv[1]))['roles']['sut']['profile'])" $dir/models.json)
sut_base=$(python3 -I -c "import json,sys;print(json.load(open(sys.argv[1]))['roles']['sut']['baseUrl'])" $dir/models.json)
node $G/harness/memos-stages.mjs ${WT}/src/memos/project_memory > $dir/usage/stages.json
git -C ${WT} rev-parse HEAD > $dir/memos-commit.txt
git -C $repo rev-parse HEAD > $dir/eval-commit.txt
stamp "start proxy :$pport and server :$port (sut profile $sut_profile)"
node $G/harness/usage-proxy.mjs --upstream $sut_base --embed-upstream http://127.0.0.1:58112/v1 \
  --port $pport --out $dir/usage/sut-calls.jsonl --stages $dir/usage/stages.json > $dir/usage/proxy.log 2>&1 &
proxy_pid=$!
MEMOS_V3_REPO=${WT} MEMOS_LOCAL_MODEL_PROFILE=$sut_profile MEMOS_V3_THINKING_MODE=disabled \
  MEMOS_V3_LLM_PROXY=http://127.0.0.1:$pport MEMOS_V3_RETRIEVAL=${MEMOS_V3_RETRIEVAL:-} $PY $here/launch_eval.py $port replay > $dir/server.log 2>&1 &
server_pid=$!
for i in {1..90}; do curl -s -m 2 http://127.0.0.1:$port/openapi.json > /dev/null && break; sleep 2; done
cd $repo
export MEMMY_EVAL_BASE=http://127.0.0.1:$port/product MEMMY_EVAL_CLOCK_BASE=http://127.0.0.1:$port
export MEMMY_EVAL_USAGE_PROXY=http://127.0.0.1:$pport
stamp "replay"
node $G/harness/model-env.mjs --out $dir/models.json -- node $G/run-memos-v3-live.mjs --out $dir "$@" > $dir/replay.log 2>&1
stamp "replay exit $?"
# Optional Episode snapshot (episode-observations.json); nothing in scoring reads it.
if [[ -f $here/observe.py ]]; then
  MEMOS_V3_PORT=$port $PY $here/observe.py $dir > $dir/observe.log 2>&1 || stamp "observe failed"
else
  stamp "observe skipped: $here/observe.py is not present"
fi
stamp "score"
MEMMY_EVAL_JUDGE_CACHE=$dir/judge-cache.json MEMMY_EVAL_SUT_USAGE=$dir/usage/sut-calls.jsonl \
  node $G/harness/model-env.mjs --out $dir/models.json -- node $G/run-pipeline-eval.mjs $dir/live-run.json --dataset 3 --gate --out $dir/score.json > $dir/score.log 2>&1
stamp "score exit $?"
node $G/harness/cost-report.mjs $dir >> $dir/stages.log 2>&1
stamp "done"
kill $server_pid $proxy_pid 2> /dev/null
