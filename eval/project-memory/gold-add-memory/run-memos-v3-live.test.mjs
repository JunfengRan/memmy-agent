import assert from "node:assert/strict";
import test from "node:test";
import { loadDataset } from "./build-gold-baseline.mjs";
import { loadGold } from "./load-eval-set.mjs";
import { createRun, executeReplay, makeWire, replaySchedule } from "./run-memos-v3-live.mjs";

const sourceDataset = loadDataset();
const sourceGold = loadGold();
const create = (gold, options = {}) => createRun({
  base: "http://product.test/product", clockBase: "http://clock.test", runTag: "replay-test", gold, sutModel: "test", ...options
});
const onlyQuestions = (gold, ids) => ({ ...gold, questions: gold.questions.filter((q) => ids.includes(q.id)) });

// inFlight: how many flush calls in a row report Episodes still in flight before one settles.
function fakeService(finalAt, { dropClockAfterAdd = false, firstStatusFails = false, foreignTopic = null, inFlight = 0, flushFails = false } = {}) {
  const added = [];
  const received = new Map();
  const events = [];
  const statuses = [];
  const flushes = [];
  let streak = 0;
  let now = -Infinity;
  const success = (data) => Response.json({ code: 200, data });
  const failure = (status, reason) => Response.json({ code: status, reason }, { status });
  const topicFor = (space) => ({ id: `${space}-topic`, space_id: space, topic_name: "wire test", decisions: [] });
  const fetchImpl = async (url, options) => {
    const request = new URL(url);
    const body = options.body ? JSON.parse(options.body) : undefined;
    if (request.hostname === "clock.test") {
      assert.equal(options.headers.authorization, "Bearer clock-only");
      assert.equal(request.pathname, "/advance");
      assert.deepEqual(Object.keys(body), ["at"]);
      const timestamp = Date.parse(body.at);
      assert.ok(timestamp >= now);
      now = timestamp;
      events.push({ clock: timestamp });
      if (dropClockAfterAdd && added.length === 1) {
        dropClockAfterAdd = false;
        return failure(503, "INTERRUPTED");
      }
      return Response.json({ at: body.at });
    }
    assert.equal(options.headers.authorization, "Bearer product-only");
    switch (request.pathname) {
      case "/product/create_space":
        return success({ space_id: body.space_name, domains: body.domains });
      case "/product/add": {
        if (!body.space_ids) return failure(422, "SCOPE_REQUIRED");
        if (body.domains.includes("未登记领域")) return failure(400, "DOMAIN_NOT_REGISTERED");
        assert.equal(body.async_mode, "async");
        assert.deepEqual(Object.keys(body).sort(), ["agent_id", "allow_memory_view", "async_mode", "conversation_id", "domains", "messages", "space_ids", "task_id", "user_id"]);
        assert.equal(body.messages[0].message_id, `${body.task_id}:u`);
        assert.equal(body.messages[1].message_id, `${body.task_id}:a`);
        const original = received.get(body.task_id);
        if (original) assert.deepEqual(body, original);
        received.set(body.task_id, body);
        added.push(body);
        events.push({ added: body.task_id });
        return success([{ memory_view: "project", task_id: body.task_id, status: "running" }]);
      }
      case "/product/scheduler/status": {
        assert.equal(options.method, "GET");
        assert.equal(options.body, undefined);
        const id = request.searchParams.get("task_id");
        assert.equal(request.searchParams.get("user_id"), received.get(id).user_id);
        statuses.push(id);
        return success([{ task_id: id, status: firstStatusFails && statuses.length === 1 ? "failed" : "completed",
          memory_views: { project: { open_episode_messages: now < Date.parse(finalAt) ? 2 : 0, memory_ids: [] } } }]);
      }
      case "/product/flush_project_memory": {
        assert.deepEqual(Object.keys(body).sort(), ["space_id", "wait_seconds"]);
        assert.equal(body.wait_seconds, 120);
        flushes.push({ space: body.space_id, at: now });
        events.push({ flush: body.space_id, at: now });
        if (flushFails) return failure(404, "NOT_FOUND");
        const busy = streak < inFlight;
        streak = busy ? streak + 1 : 0;
        return success({ space_id: body.space_id, closed_episode_ids: busy ? ["ep1"] : [], pending_episode_ids: busy ? ["ep1"] : [],
          formation: busy ? { space_id: body.space_id, ran: false, reason: "EPISODES_IN_FLIGHT" } : { space_id: body.space_id, ran: false, reason: "NO_STAGED" },
          staged_remaining: 0 });
      }
      case "/product/search":
        if (!body.space_ids) return failure(422, "SCOPE_REQUIRED");
        events.push({ search: body.query });
        return success({ topic_detail_list: [topicFor(body.space_ids[0]), ...(foreignTopic ? [foreignTopic] : [])] });
      case "/product/get_memory": {
        const topics = [...received.values()].some((item) => item.space_ids.includes(body.space_id)) ? [topicFor(body.space_id)] : [];
        return success({ total: topics.length, topic_detail_list: topics });
      }
      default: throw new Error(`unexpected test path ${request.pathname}`);
    }
  };
  return { added, events, statuses, flushes, wire: (run) => makeWire({ run, fetchImpl,
    productHeaders: { authorization: "Bearer product-only" }, clockHeaders: { authorization: "Bearer clock-only" } }) };
}

test("MemOS v3 replay submits each source Turn with stable ids and observes as-of snapshots", async () => {
  const { events, finalAt } = replaySchedule(sourceDataset, sourceGold);
  assert.equal(Date.parse(finalAt), Date.parse(sourceGold.visibilityEvents.at(-1).at));
  assert.equal(sourceGold.processing, "flush");
  assert.equal(events.some((event) => event.question?.id === "q49"), false, "q49 is excluded under flush");
  assert.equal(events.length, 148);
  const server = fakeService(finalAt);
  const run = create(sourceGold);
  let checkpoints = 0;
  await executeReplay({ ds: sourceDataset, gold: sourceGold, run, call: server.wire(run),
    answer: async (question) => {
      assert.deepEqual(Object.keys(question).sort(), ["askedAt", "question"]);
      return "测试答案";
    }, checkpoint: () => { checkpoints += 1; } });
  assert.equal(run.state, "completed");
  assert.equal(run.nextEvent, 148);
  assert.equal(run.tasks.length, 113);
  assert.equal(run.questions.length, 35);
  assert.equal(new Set(server.added.map((body) => body.task_id)).size, 108);
  assert.equal(run.tasks[0].memory_views.project.open_episode_messages, 2);
  assert.equal(run.tasks[0].final.memory_views.project.open_episode_messages, 0);
  assert.equal(checkpoints, 154);
  assert.equal(run.runnerRevision, 2);
  assert.equal(run.processing, "flush");
  // One settled flush per question, then one per Space before the final read.
  assert.equal(server.flushes.length, 35 + 6);
  assert.ok(run.questions.every((item) => item.flush.settled && item.flush.rounds.length === 1));
  assert.deepEqual(Object.keys(run.finalFlush).sort(), sourceDataset.corpus.spaces.map((space) => space.space_id).sort());
  for (const [index, event] of server.events.entries()) {
    if (!event.flush) continue;
    // Each flush is followed by an advance to the same instant (the clock's settle drains stages).
    assert.deepEqual(server.events[index + 1], { clock: event.at });
  }
  const firstSearch = server.events.findIndex((event) => event.search);
  assert.ok(server.events[firstSearch - 2].flush, "the Space is flushed right before a question searches");
  assert.ok(run.requests.filter((request) => request.call === "/flush_project_memory").every((request) => request.phase === "add"));
  assert.equal(Object.keys(run.final).length, 6);
  assert.deepEqual(run.apiChecks.map(({ passed }) => passed), [true, true, true, true]);
  const first = server.events.findIndex((event) => event.added);
  assert.deepEqual(server.events[first - 1], server.events[first + 1]);
  assert.ok(run.requests.some((request) => request.call === "/scheduler/status" && request.poll));
});

test("the v3 reader sees only the requested Space while the raw response retains foreign Topics", async () => {
  const ds = structuredClone(sourceDataset);
  const question = ds.questions.questions.find((q) => q.id === "q24");
  ds.corpus.traces = [ds.corpus.traces.find((trace) => trace.conversation === "ledger-build")];
  ds.questions.questions = [question];
  const gold = { ...onlyQuestions(sourceGold, ["q24"]), apiChecks: [] };
  const run = create(gold);
  const { finalAt } = replaySchedule(ds, gold);
  const foreignTopic = { id: "foreign-topic", space_id: "space_ledger", topic_name: "账本范围探针" };
  const server = fakeService(finalAt, { foreignTopic });

  await executeReplay({ ds, gold, run, call: server.wire(run), answer: async (_, rendered) => {
    assert.match(rendered, /wire test/);
    assert.doesNotMatch(rendered, /账本范围探针/);
    return "测试答案";
  } });

  assert.equal(run.questions[0].answer, "测试答案");
  assert.deepEqual(run.questions[0].topic_detail_list[1], foreignTopic);
});

test("an interruption after acceptance resumes the same Turn; failed statuses are retained", async () => {
  const ds = structuredClone(sourceDataset);
  ds.corpus.traces = ds.corpus.traces.slice(0, 3);
  ds.questions.questions = [];
  const gold = { ...onlyQuestions(sourceGold, []), apiChecks: [] };
  const run = create(gold);
  const { finalAt } = replaySchedule(ds, gold);
  const server = fakeService(finalAt, { dropClockAfterAdd: true, firstStatusFails: true });
  const inputs = { ds, gold, run, call: server.wire(run), answer: async () => "unreachable" };
  await assert.rejects(executeReplay(inputs), /\/advance returned HTTP 503/);
  assert.equal(run.nextEvent, 0);
  assert.equal(Object.keys(run.spaceMap).length, 6);
  assert.equal(run.tasks.length, 0);
  await executeReplay(inputs);
  assert.deepEqual(server.added[0], server.added[1]);
  assert.equal(run.tasks.length, 3);
  assert.equal(run.tasks[0].failure.kind, "task");
  assert.equal(run.failures.length, 1);
  assert.equal(run.state, "completed_with_failures");
});

test("flush repeats while Episodes are in flight, then searches; an unsettled Space is a failure", async () => {
  const ds = structuredClone(sourceDataset);
  ds.corpus.traces = [ds.corpus.traces.find((trace) => trace.conversation === "ledger-build")];
  const gold = { ...onlyQuestions(sourceGold, ["q24"]), apiChecks: [] };
  const { finalAt } = replaySchedule(ds, gold);

  const busy = fakeService(finalAt, { inFlight: 2 });
  const run = create(gold);
  await executeReplay({ ds, gold, run, call: busy.wire(run), answer: async () => "测试答案" });
  assert.equal(run.questions[0].flush.settled, true);
  assert.equal(run.questions[0].flush.rounds.length, 3);
  assert.equal(run.questions[0].flush.rounds[0].formation.reason, "EPISODES_IN_FLIGHT");
  assert.equal(run.state, "completed");

  const stuck = fakeService(finalAt, { inFlight: 99 });
  const stuckRun = create(gold);
  await executeReplay({ ds, gold, run: stuckRun, call: stuck.wire(stuckRun), answer: async () => "测试答案" });
  assert.equal(stuckRun.questions[0].flush.rounds.length, 5);
  assert.equal(stuckRun.questions[0].answer, "测试答案", "the question is still asked");
  assert.equal(stuckRun.failures[0].kind, "flush");
  assert.equal(stuckRun.state, "completed_with_failures");

  const broken = fakeService(finalAt, { flushFails: true });
  const brokenRun = create(gold);
  await executeReplay({ ds, gold, run: brokenRun, call: broken.wire(brokenRun), answer: async () => "测试答案" });
  assert.match(brokenRun.questions[0].flush.failure.message, /flush_project_memory returned HTTP 404/);
});

test("--no-flush keeps the timer-only replay of runner revision 1", async () => {
  const ds = structuredClone(sourceDataset);
  ds.corpus.traces = ds.corpus.traces.slice(0, 3);
  const gold = { ...onlyQuestions(sourceGold, ["q24"]), apiChecks: [] };
  const { finalAt } = replaySchedule(ds, gold);
  const server = fakeService(finalAt);
  const run = create(gold, { flush: false });
  await executeReplay({ ds, gold, run, call: server.wire(run), answer: async () => "测试答案" });
  assert.equal(run.processing, "natural");
  assert.equal(server.flushes.length, 0);
  assert.equal(run.questions[0].flush, undefined);
  assert.equal(run.finalFlush, undefined);
});
