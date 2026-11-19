import assert from "node:assert/strict";
import test from "node:test";
import { loadDataset } from "./build-gold-baseline.mjs";
import { loadGold } from "./load-eval-set.mjs";
import { createRun, executeReplay, makeWire, replaySchedule } from "./run-memos-v3-live.mjs";

const sourceDataset = loadDataset();
const sourceGold = loadGold();
const create = (gold) => createRun({
  base: "http://product.test/product", clockBase: "http://clock.test", runTag: "replay-test", gold, sutModel: "test"
});

function fakeService(finalAt, { dropClockAfterAdd = false, firstStatusFails = false } = {}) {
  const added = [];
  const received = new Map();
  const events = [];
  const statuses = [];
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
      case "/product/search":
        if (!body.space_ids) return failure(422, "SCOPE_REQUIRED");
        events.push({ search: body.query });
        return success({ topic_detail_list: [topicFor(body.space_ids[0])] });
      case "/product/get_memory": {
        const topics = [...received.values()].some((item) => item.space_ids.includes(body.space_id)) ? [topicFor(body.space_id)] : [];
        return success({ total: topics.length, topic_detail_list: topics });
      }
      default: throw new Error(`unexpected test path ${request.pathname}`);
    }
  };
  return { added, events, statuses, wire: (run) => makeWire({ run, fetchImpl,
    productHeaders: { authorization: "Bearer product-only" }, clockHeaders: { authorization: "Bearer clock-only" } }) };
}

test("MemOS v3 replay submits each source Turn with stable ids and observes as-of snapshots", async () => {
  const { events, finalAt } = replaySchedule(sourceDataset, sourceGold);
  assert.equal(Date.parse(finalAt), Date.parse(sourceGold.visibilityEvents.at(-1).at));
  assert.equal(events.length, 149);
  const server = fakeService(finalAt);
  const run = create(sourceGold);
  let checkpoints = 0;
  await executeReplay({ ds: sourceDataset, gold: sourceGold, run, call: server.wire(run),
    answer: async (question) => {
      assert.deepEqual(Object.keys(question).sort(), ["askedAt", "question"]);
      return "测试答案";
    }, checkpoint: () => { checkpoints += 1; } });
  assert.equal(run.state, "completed");
  assert.equal(run.nextEvent, 149);
  assert.equal(run.tasks.length, 113);
  assert.equal(run.questions.length, 36);
  assert.equal(new Set(server.added.map((body) => body.task_id)).size, 108);
  assert.equal(run.tasks[0].memory_views.project.open_episode_messages, 2);
  assert.equal(run.tasks[0].final.memory_views.project.open_episode_messages, 0);
  assert.equal(checkpoints, 155);
  assert.equal(Object.keys(run.final).length, 6);
  assert.deepEqual(run.apiChecks.map(({ passed }) => passed), [true, true, true, true]);
  const first = server.events.findIndex((event) => event.added);
  assert.deepEqual(server.events[first - 1], server.events[first + 1]);
  assert.ok(run.requests.some((request) => request.call === "/scheduler/status" && request.poll));
});

test("an interruption after acceptance resumes the same Turn; failed statuses are retained", async () => {
  const ds = structuredClone(sourceDataset);
  ds.corpus.traces = ds.corpus.traces.slice(0, 3);
  ds.questions.questions = [];
  const gold = { ...sourceGold, apiChecks: [] };
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
