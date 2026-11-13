// The four API checks of dataset v2 (gold.apiChecks), run through the spec API only.
// A check passes only on positive evidence: the documented error code, or a positive control
// that proves the query would have found something. A refused connection, a 404 or a 500 fails.
// Each check is isolated: an exception fails that check and is recorded, the others still run.
//
// ctx: { gold, ds, spaceMap, call, searchBody, addBody, waitTask, readSpace }
//   call(path, body, { strict: false }) → { ok, status, code, message, data }
//   searchBody(conversation, query), addBody(trace, overrides) build spec request bodies
//   readSpace(datasetSpaceId) → topic_detail_list of get/memory, throws on any failure
export const INVALID_PARAMS = 40001;
export const DOMAIN_INVALID = 40002;

const envelope = (r) => ({ status: r.status, code: r.code ?? null, message: r.message ?? null });

async function searchRequiresSpaceIds(check, ctx) {
  const { space_ids, ...body } = ctx.searchBody("ledger-ask", "月报的金额现在从哪里取？");
  const r = await ctx.call("/search/memory", body, { strict: false });
  return { passed: r.code === INVALID_PARAMS, expected: `code ${INVALID_PARAMS}`, ...envelope(r), returned: r.data?.topic_detail_list?.length ?? 0 };
}

async function addRequiresSpaceIds(check, ctx) {
  const trace = ctx.ds.corpus.traces.find((t) => t.conversation === "ledger-build");
  const { space_ids, ...body } = ctx.addBody(trace, { conversation_id: `${ctx.addBody(trace).conversation_id}:check` });
  const r = await ctx.call("/add/message", body, { strict: false });
  return { passed: r.code === INVALID_PARAMS, expected: `code ${INVALID_PARAMS}`, ...envelope(r), task_id: r.data?.task_id ?? null };
}

// Positive control: the same question asked in space_ledger must return at least one ledger topic,
// so an empty catalog result means isolation and not a broken or empty search.
async function searchSpaceIsolation(check, ctx) {
  const ledgerServer = ctx.spaceMap.space_ledger;
  const probeServer = ctx.spaceMap[check.space_id];
  const ledgerIds = new Set((await ctx.readSpace("space_ledger")).map((t) => t.id));
  const isLedger = (t) => t.space_id === ledgerServer || ledgerIds.has(t.id);
  const rows = [];
  for (const qid of check.questionTexts) {
    const question = ctx.gold.questions.find((q) => q.id === qid);
    const control = await ctx.call("/search/memory", ctx.searchBody("ledger-ask", question.question), { strict: false });
    const probe = await ctx.call("/search/memory", ctx.searchBody("catalog-ask", question.question), { strict: false });
    const controlTopics = control.data?.topic_detail_list ?? [];
    const probeTopics = probe.data?.topic_detail_list ?? [];
    rows.push({
      question: qid,
      control: { ...envelope(control), ok: control.ok, topics: controlTopics.length, ledgerTopics: controlTopics.filter(isLedger).length },
      probe: { ...envelope(probe), ok: probe.ok, topics: probeTopics.length },
      leaks: probeTopics.filter((t) => t.space_id !== probeServer || isLedger(t)).map((t) => ({ topic: t.id ?? null, space_id: t.space_id ?? null }))
    });
  }
  const leaks = rows.flatMap((row) => row.leaks.map((leak) => ({ question: row.question, ...leak })));
  const controlFailed = rows.filter((row) => !row.control.ok || row.control.ledgerTopics < 1).map((row) => row.question);
  const probeFailed = rows.filter((row) => !row.probe.ok).map((row) => row.question);
  return { passed: leaks.length === 0 && controlFailed.length === 0 && probeFailed.length === 0, leaks, controlFailed, probeFailed, rows };
}

async function addUnregisteredDomain(check, ctx) {
  const before = (await ctx.readSpace(check.space_id)).length;
  const trace = ctx.ds.corpus.traces.find((t) => t.conversation === "ledger-build");
  const r = await ctx.call("/add/message", ctx.addBody(trace, { domains: [check.domain], conversation_id: `${ctx.addBody(trace).conversation_id}:domain-check` }), { strict: false });
  let task = null;
  if (r.ok && r.data?.task_id) task = await ctx.waitTask(r.data.task_id, check.id);
  const after = (await ctx.readSpace(check.space_id)).length;
  const syncRejected = !r.ok && (r.code === DOMAIN_INVALID || r.message === "DOMAIN_INVALID");
  const taskRejected = task?.status === "failed" && JSON.stringify(task.error ?? {}).includes("DOMAIN_INVALID");
  return { passed: (syncRejected || taskRejected) && after === before, expected: `code ${DOMAIN_INVALID} or task failed with DOMAIN_INVALID`, ...envelope(r), task, topicsBefore: before, topicsAfter: after };
}

const RUNNERS = {
  search_requires_space_ids: searchRequiresSpaceIds,
  add_requires_space_ids: addRequiresSpaceIds,
  search_space_isolation: searchSpaceIsolation,
  add_unregistered_domain: addUnregisteredDomain
};

export async function runApiChecks(ctx) {
  const results = [];
  for (const check of ctx.gold.apiChecks) {
    const runner = RUNNERS[check.id];
    if (!runner) { results.push({ id: check.id, passed: false, detail: "no runner for this check" }); continue; }
    try {
      results.push({ id: check.id, ...(await runner(check, ctx)) });
    } catch (error) {
      results.push({ id: check.id, passed: false, error: String(error.message ?? error) });
    }
  }
  return results;
}
