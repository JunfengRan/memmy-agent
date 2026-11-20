#!/usr/bin/env node
// MemOS project memory replay. The isolated clock receives only a timestamp.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { loadDataset, submittedTrace } from "./build-gold-baseline.mjs";
import { acceptedTime } from "./episode-timeline.mjs";
import { createLlm, resolveModelConfig } from "./llm.mjs";
import { loadGold } from "./load-eval-set.mjs";
import { displayNames } from "./oracle.mjs";
import { createReader, renderTemplate3 } from "./reader.mjs";
import { RUNS_DIR } from "./run-pipeline-eval.mjs";

const digest = (value) => createHash("sha256").update(value).digest("hex");
const stableId = (...parts) => digest(parts.join("\0")).slice(0, 32);
const topicsOf = (data) => {
  if (!Array.isArray(data?.topic_detail_list)) throw new Error("Missing topic_detail_list");
  return data.topic_detail_list;
};
const projectOf = (data) => {
  const row = data?.find?.((item) => item.memory_view === "project");
  if (!row?.task_id || !["running", "completed", "failed"].includes(row.status)) {
    throw new Error("Missing or invalid project Add receipt");
  }
  return row;
};
const errorInfo = (error) => ({
  message: String(error.message ?? error).slice(0, 400),
  ...(error.call ? { call: error.call, status: error.status, code: error.code, reason: error.reason } : {})
});

export function replaySchedule(ds, gold) {
  const events = [
    ...ds.corpus.traces.map((trace) => ({ at: acceptedTime(trace), trace })),
    ...ds.questions.questions.filter((question) => !question.excluded).map((question) => ({ at: question.askedAt, question }))
  ].sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
  const end = Math.max(Date.parse(events.at(-1)?.at), Date.parse(gold.visibilityEvents.at(-1)?.at));
  if (!Number.isFinite(end)) throw new Error("Dataset has no valid final clock checkpoint");
  return { events, finalAt: new Date(end).toISOString() };
}

export function createRun({ base, clockBase, runTag, gold, sutModel, reader }) {
  return {
    runVersion: 2, datasetVersion: 3, datasetDigest: digest(JSON.stringify(gold)), runnerRevision: 1,
    kind: "live", startedAt: new Date().toISOString(), base, clockBase, runTag,
    sut: { model: sutModel ?? null }, reader: reader ?? null,
    spaceMap: {}, tasks: [], questions: [], final: {}, apiChecks: [], requests: [], phaseMs: {}, usage: {},
    failures: [], nextEvent: 0, state: "in_progress"
  };
}

export function makeWire({ run, productHeaders = {}, clockHeaders = {}, timeoutMs = 300_000, fetchImpl = fetch }) {
  return async function call(path, { body, phase, clock = false, method = "POST", strict = true } = {}) {
    const at = Date.now();
    const started = performance.now();
    const base = clock ? run.clockBase : run.base;
    let status = 0;
    let payload = null;
    try {
      const response = await fetchImpl(`${base}${path}`, {
        method,
        headers: { "content-type": "application/json", ...(clock ? clockHeaders : productHeaders) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs)
      });
      status = response.status;
      payload = await response.json();
    } catch {
      // Record the failure without copying an upstream response body into the run log.
    }
    const code = payload?.code ?? null;
    const reason = payload?.reason ?? null;
    const latency = performance.now() - started;
    const ok = status >= 200 && status < 300 && payload !== null &&
      (clock ? payload.ok !== false && (code === null || code === 200) : code === 200);
    run.requests.push({ call: path.split("?")[0], phase, poll: path.startsWith("/scheduler/status?"), at, ms: latency, status, code });
    if (!ok && strict) {
      const error = new Error(`${path.split("?")[0]} returned HTTP ${status}, code ${code}${reason ? ` (${reason})` : ""}`);
      throw Object.assign(error, { call: path.split("?")[0], status, code, reason });
    }
    return { ok, status, code, reason, data: payload?.data, ms: latency };
  };
}

function requestsFor(ds, run) {
  const traces = new Map(ds.corpus.traces.map((trace) => [trace.id, trace]));
  const conversations = new Map(ds.corpus.conversations.map((conversation) => [conversation.id, conversation]));
  const names = displayNames(ds);
  const conversationId = (c) => `${c.conversation_id}:${run.runTag}`;
  return {
    names,
    add(trace) {
      const source = submittedTrace(trace, traces);
      const conversation = conversations.get(source.conversation);
      const taskId = stableId(run.runTag, source.id);
      return {
        task_id: taskId, user_id: conversation.user_id, agent_id: conversation.agent_id,
        conversation_id: conversationId(conversation), space_ids: [run.spaceMap[conversation.space_id]],
        domains: [source.domain], allow_memory_view: ["project"], async_mode: "async",
        messages: [
          { message_id: `${taskId}:u`, role: "user", role_id: conversation.user_id,
            role_name: names.memberNames[conversation.user_id], chat_time: source.chat_time, content: source.query },
          { message_id: `${taskId}:a`, role: "assistant", chat_time: source.reply_time, content: source.answer }
        ]
      };
    },
    search(conversationKey, query) {
      const conversation = conversations.get(conversationKey);
      return {
        user_id: conversation.user_id, conversation_id: conversationId(conversation), query,
        space_ids: [run.spaceMap[conversation.space_id]], include_memory_view: ["project"], memory_limit_number: 9
      };
    }
  };
}

function taskDetails(data, taskId) {
  const row = data?.find?.((item) => item.task_id === taskId);
  const project = row?.memory_views?.project;
  if (!row || !["completed", "failed", "in_progress", "running"].includes(row.status) ||
      !Number.isInteger(project?.open_episode_messages)) {
    throw new Error(`Missing or invalid project status for Task ${taskId}`);
  }
  return { status: row.status, memory_views: row.memory_views, error: project.error ?? null };
}

async function checkApi({ call, ds, gold, run, bodies, readSpace }) {
  const trace = ds.corpus.traces.find((item) => item.conversation === "ledger-build");
  const scratch = bodies.add(trace);
  scratch.conversation_id += ":probe";
  scratch.task_id = stableId(run.runTag, "api-check");
  scratch.messages = scratch.messages.map((item, index) => ({ ...item, message_id: `${scratch.task_id}:${index}` }));
  const post = (path, body) => call(path, { body, phase: "check", strict: false });
  const envelope = ({ status, code, reason }) => ({ status, code, reason });
  const handlers = {
    async search_requires_space_ids() {
      const { space_ids, ...body } = bodies.search("ledger-ask", trace.query);
      const result = await post("/search", body);
      return { passed: result.status === 422 && result.reason === "SCOPE_REQUIRED", ...envelope(result) };
    },
    async add_requires_space_ids() {
      const { space_ids, ...body } = scratch;
      const result = await post("/add", body);
      return { passed: result.status === 422 && result.reason === "SCOPE_REQUIRED", ...envelope(result) };
    },
    async search_space_isolation(check) {
      const expected = run.spaceMap[check.space_id];
      const ledger = new Set((await readSpace("space_ledger", "check")).map((topic) => topic.id));
      const rows = [];
      for (const id of check.questionTexts) {
        const question = ds.questions.questions.find((q) => q.id === id);
        const control = await post("/search", bodies.search("ledger-ask", question.question));
        const probe = await post("/search", bodies.search("catalog-ask", question.question));
        const controlTopics = control.ok ? topicsOf(control.data) : [];
        const probeTopics = probe.ok ? topicsOf(probe.data) : [];
        const hits = controlTopics.filter((topic) => ledger.has(topic.id) && topic.space_id === run.spaceMap.space_ledger).length;
        const leaks = probeTopics.filter((topic) => ledger.has(topic.id) || topic.space_id !== expected).map((topic) => topic.id);
        rows.push({ question: id, control: envelope(control), probe: envelope(probe), controlHits: hits, leaks,
          passed: control.ok && probe.ok && hits > 0 && leaks.length === 0 });
      }
      return { passed: rows.length > 0 && rows.every((row) => row.passed), rows };
    },
    async add_unregistered_domain(check) {
      const before = await readSpace(check.space_id, "check");
      const result = await post("/add", { ...scratch, domains: [check.domain] });
      const after = await readSpace(check.space_id, "check");
      const revisions = (topics) => topics.map((topic) => `${topic.id}:${topic.update_time}`).sort();
      const unchanged = JSON.stringify(revisions(before)) === JSON.stringify(revisions(after));
      return { passed: unchanged && result.status === 400 && result.reason === "DOMAIN_NOT_REGISTERED",
        ...envelope(result), topicsUnchanged: unchanged };
    }
  };
  const results = [];
  for (const check of gold.apiChecks) {
    try {
      const handler = handlers[check.id];
      results.push({ id: check.id, ...(handler ? await handler(check) : { passed: false, error: "Unknown API check" }) });
    } catch (error) {
      results.push({ id: check.id, passed: false, error: errorInfo(error) });
    }
  }
  return results;
}

// tag(context) labels the system-under-test model calls that follow (see harness/usage-proxy.mjs).
export async function executeReplay({ ds, gold, run, call, answer, checkpoint = () => {}, progress = () => {}, tag = async () => {} }) {
  const { events, finalAt } = replaySchedule(ds, gold);
  const bodies = requestsFor(ds, run);
  const timed = async (phase, fn) => {
    const start = performance.now();
    try { return await fn(); }
    finally { run.phaseMs[phase] = (run.phaseMs[phase] ?? 0) + performance.now() - start; }
  };
  const advance = (at) => timed("clock", () => call("/advance", { body: { at }, clock: true, phase: "clock" }));
  run.events ??= [];
  const snapshot = () => ({ ...run.phaseMs });
  const stateOf = async (taskId, userId, phase) => {
    const path = `/scheduler/status?${new URLSearchParams({ user_id: userId, task_id: taskId })}`;
    return taskDetails((await call(path, { method: "GET", phase })).data, taskId);
  };
  const readSpace = async (datasetSpace, phase = "final") => {
    const topics = [];
    for (let page = 1; ; page += 1) {
      const { data } = await call("/get_memory", { phase, body: { space_id: run.spaceMap[datasetSpace], page, size: 50 } });
      const batch = topicsOf(data);
      topics.push(...batch);
      if (!batch.length || topics.length >= (data.total ?? 0)) return topics;
    }
  };
  const search = (conversation, query, context = {}) => timed("search", async () => {
    await tag({ ...context, phase: "search", step: "search" });
    return topicsOf((await call("/search", { phase: "search", body: bodies.search(conversation, query) })).data);
  });
  const fail = (kind, id, at, error) => {
    const failure = { kind, id, at, ...errorInfo(error) };
    run.failures.push(failure);
    return failure;
  };

  await timed("setup", async () => {
    for (const space of ds.corpus.spaces) {
      if (run.spaceMap[space.space_id]) continue;
      const { data } = await call("/create_space", { phase: "setup", body: {
        space_name: `${space.space_id}_${run.runTag}`, instructions: space.instructions,
        domains: space.domains.map(({ domain, description }) => ({ name: domain, description }))
      } });
      if (!data?.space_id) throw new Error(`Create Space returned no id for ${space.space_id}`);
      if (data.domains?.length !== space.domains.length) throw new Error(`Create Space missed domains for ${space.space_id}`);
      run.spaceMap[space.space_id] = data.space_id;
      if ((await readSpace(space.space_id, "setup")).length) throw new Error(`Created Space ${space.space_id} was not empty`);
      checkpoint(run);
    }
  });
  const names = { ...bodies.names, spaceNames: Object.fromEntries(Object.entries(run.spaceMap).map(([key, value]) => [value, bodies.names.spaceNames[key]])) };

  for (let index = run.nextEvent; index < events.length; index += 1) {
    const { at, trace, question } = events[index];
    run.currentEvent = { at, id: trace?.id ?? question.id };
    const event = { event: run.currentEvent.id, event_index: index, kind: trace ? "add" : "question", at };
    const startedAt = new Date().toISOString();
    const phasesBefore = snapshot();
    // Closed Episodes are organized while the clock advances, so those model calls belong to Add.
    await tag({ ...event, phase: "add", step: "process" });
    await advance(at);
    if (trace) {
      const body = bodies.add(trace);
      const item = { trace: trace.id, at, user_id: body.user_id, requested_task_id: body.task_id, resubmitOf: trace.resubmitOf ?? null };
      if (trace.searchBefore) {
        try { item.searchBefore = (await search(trace.conversation, trace.searchBefore.query, event)).map((topic) => topic.id); }
        catch (error) { item.searchBeforeError = fail("search_before", trace.id, at, error); }
      }
      try {
        await tag({ ...event, phase: "add", step: "accept" });
        const result = await timed("add", () => call("/add", { body, phase: "add" }));
        const receipt = projectOf(result.data);
        Object.assign(item, { task_id: receipt.task_id, add_status: receipt.status, acceptMs: result.ms });
        if (receipt.task_id !== body.task_id) throw new Error(`Add returned a different Task ID for ${trace.id}`);
      } catch (error) { item.failure = fail("add", trace.id, at, error); }
      // Also drain a closed Episode created by Add. Open Tasks remain in the accumulator.
      await tag({ ...event, phase: "add", step: "process" });
      await advance(at);
      if (item.task_id) {
        try {
          Object.assign(item, await timed("add", () => stateOf(item.task_id, body.user_id, "add")), { polls: 1 });
          if (item.status === "failed") item.failure = fail("task", trace.id, at, new Error(JSON.stringify(item.error ?? "Task failed")));
        } catch (error) { item.failure = fail("task_status", trace.id, at, error); }
      }
      run.tasks.push(item);
    } else {
      const item = { id: question.id, askedAt: question.askedAt, topic_detail_list: [], rendered: "", answer: "" };
      try {
        item.topic_detail_list = await search(question.conversation, question.question, event);
        item.rendered = renderTemplate3({ topics: item.topic_detail_list, now: question.askedAt, ...names });
        await tag({ ...event, phase: "reader", step: "answer" });
        item.answer = await timed("reader", () => answer({ question: question.question, askedAt: question.askedAt }, item.rendered));
      } catch (error) { item.failure = fail("question", question.id, at, error); }
      run.questions.push(item);
    }
    const phasesAfter = snapshot();
    run.events.push({
      ...event, startedAt, endedAt: new Date().toISOString(),
      phaseMs: Object.fromEntries(Object.keys(phasesAfter).map((key) => [key, phasesAfter[key] - (phasesBefore[key] ?? 0)]).filter(([, ms]) => ms > 0))
    });
    run.nextEvent = index + 1;
    checkpoint(run);
    progress(run, events.length);
  }

  run.currentEvent = { at: finalAt, id: "final" };
  await tag({ event: "final", phase: "add", step: "process", at: finalAt });
  await advance(finalAt);
  await tag({ event: "final", phase: "final", step: "read" });
  await timed("final", async () => {
    const statuses = new Map();
    for (const task of run.tasks) {
      if (!task.task_id) continue;
      const key = `${task.user_id}\0${task.task_id}`;
      if (!statuses.has(key)) {
        try { statuses.set(key, await stateOf(task.task_id, task.user_id, "final")); }
        catch (error) { statuses.set(key, { failure: errorInfo(error) }); }
      }
      task.final = statuses.get(key);
      if (!task.failure && (task.final.failure || task.final.status !== "completed" || task.final.memory_views?.project?.open_episode_messages > 0)) {
        const reason = task.final.failure?.message ?? JSON.stringify(task.final.error ?? { status: task.final.status, open: task.final.memory_views?.project?.open_episode_messages });
        task.failure = fail("final_status", task.trace, finalAt, new Error(reason));
      }
    }
    for (const space of ds.corpus.spaces) run.final[space.space_id] = await readSpace(space.space_id);
  });
  await tag({ event: "check", phase: "check", step: "api" });
  run.apiChecks = await timed("check", () => checkApi({ call, ds, gold, run, bodies, readSpace }));
  await tag({ event: "done", phase: "idle", step: "idle" });
  run.finalAt = finalAt;
  delete run.currentEvent;
  run.state = run.failures.length || run.apiChecks.some((check) => !check.passed) ? "completed_with_failures" : "completed";
  return run;
}

async function main() {
  const { values } = parseArgs({ options: { out: { type: "string" }, resume: { type: "string" }, help: { type: "boolean", short: "h" } } });
  if (values.help) {
    console.log("Usage: node run-memos-v3-live.mjs [--out <directory>] [--resume <live-run.partial.json>]\nSet MEMMY_EVAL_BASE, MEMMY_EVAL_CLOCK_BASE, and MEMMY_EVAL_READER_*.");
    return 0;
  }
  if (values.resume && values.out) throw new Error("--resume already selects the checkpoint directory");
  const base = (process.env.MEMMY_EVAL_BASE ?? "http://127.0.0.1:8000/product").replace(/\/+$/, "");
  const clockBase = process.env.MEMMY_EVAL_CLOCK_BASE?.replace(/\/+$/, "");
  if (!clockBase) throw new Error("MEMMY_EVAL_CLOCK_BASE is required for the isolated replay clock");
  const timeoutMs = Number(process.env.MEMMY_EVAL_TASK_TIMEOUT_MS ?? 300_000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 4_294_967_295) throw new Error("Invalid MEMMY_EVAL_TASK_TIMEOUT_MS");
  const config = resolveModelConfig("MEMMY_EVAL_READER");
  if (!config) throw new Error("Configure MEMMY_EVAL_READER_PROVIDER, _MODEL, _BASE_URL and _API_KEY");
  const ds = loadDataset();
  const gold = loadGold();
  if (ds.corpus.datasetVersion !== 3 || gold.datasetVersion !== 3) throw new Error("MemOS live replay requires v3 fixtures");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = values.resume ? dirname(resolve(values.resume)) : resolve(values.out ?? join(RUNS_DIR, stamp));
  const partial = join(outDir, "live-run.partial.json");
  const final = join(outDir, "live-run.json");
  const reader = { model: config.model, provider: config.provider };
  const run = values.resume ? JSON.parse(readFileSync(values.resume, "utf8")) : createRun({
    base, clockBase, runTag: process.env.MEMMY_EVAL_RUN_TAG ?? stamp, gold, sutModel: process.env.MEMMY_EVAL_SUT_MODEL, reader
  });
  if (values.resume) {
    if (!["interrupted", "in_progress"].includes(run.state) || run.base !== base || run.clockBase !== clockBase ||
        run.datasetDigest !== digest(JSON.stringify(gold)) || run.reader?.model !== reader.model || run.reader?.provider !== reader.provider) {
      throw new Error("Resume requires an unfinished checkpoint with matching server, clock, dataset, and reader");
    }
  } else if (existsSync(partial) || existsSync(final)) {
    throw new Error(`Run directory already contains a checkpoint or result: ${outDir}`);
  }
  mkdirSync(outDir, { recursive: true });
  const llm = createLlm({ config, cachePath: process.env.MEMMY_EVAL_READER_CACHE ?? join(outDir, "reader-cache.json") });
  const priorUsage = run.usage.reader;
  const auth = (token) => token ? { authorization: `Bearer ${token}` } : {};
  const call = makeWire({ run, timeoutMs, productHeaders: auth(process.env.MEMMY_EVAL_API_KEY),
    clockHeaders: auth(process.env.MEMMY_EVAL_CLOCK_TOKEN) });
  const checkpoint = (target) => {
    run.wallclockMs = Date.now() - Date.parse(run.startedAt);
    run.usage.reader = { ...llm.usage };
    for (const [key, value] of Object.entries(priorUsage ?? {})) {
      if (typeof value === "number" && typeof run.usage.reader[key] === "number") run.usage.reader[key] += value;
      if (Array.isArray(value) && Array.isArray(run.usage.reader[key])) run.usage.reader[key] = [...value, ...run.usage.reader[key]];
    }
    const temp = `${target}.tmp`;
    writeFileSync(temp, `${JSON.stringify(run, null, 2)}\n`);
    renameSync(temp, target);
  };
  try {
    run.state = "in_progress";
    delete run.error;
    checkpoint(partial);
    console.log(JSON.stringify({ runTag: run.runTag, directory: outDir, nextEvent: run.nextEvent }));
    const proxy = process.env.MEMMY_EVAL_USAGE_PROXY?.replace(/\/+$/, "");
    const tag = proxy ? async (context) => {
      try { await fetch(`${proxy}/__eval/context`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(context), signal: AbortSignal.timeout(5_000) }); }
      catch (error) { console.error(`usage tag failed: ${error.message}`); }
    } : undefined;
    await executeReplay({ ds, gold, run, call, answer: createReader(llm).answer, tag,
      checkpoint: () => checkpoint(partial),
      progress: (current, total) => { if (current.nextEvent % 10 === 0) console.log(`${current.nextEvent}/${total} events · ${current.failures.length} failures`); }
    });
    checkpoint(partial);
    renameSync(partial, final);
    console.log(JSON.stringify({ out: final, runTag: run.runTag, state: run.state, tasks: run.tasks.length,
      questions: run.questions.length, failures: run.failures.length, apiChecks: run.apiChecks.map((check) => `${check.id}:${check.passed}`) }));
    return run.state === "completed" ? 0 : 1;
  } catch (error) {
    run.state = "interrupted";
    run.error = errorInfo(error);
    checkpoint(partial);
    console.error(JSON.stringify({ partial, event: run.currentEvent, error: run.error }));
    return 1;
  } finally { llm.save(); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try { process.exitCode = await main(); }
  catch (error) { console.error(errorInfo(error).message); process.exitCode = 1; }
}
