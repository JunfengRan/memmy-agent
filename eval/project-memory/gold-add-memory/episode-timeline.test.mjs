import assert from "node:assert/strict";
import test from "node:test";
import { buildEpisodeTimeline, validateEpisodeLabels } from "./episode-timeline.mjs";

const time = (clock) => `2026-11-01T${clock}+08:00`;
const turn = (id, conversation, clock, extra = {}) => ({
  id, conversation, domain: "领域", query: id, chat_time: time(clock), reply_time: time(clock), ...extra
});
const episode = (id, traces, topic = "topic") => ({ id, traces, topic, goal: id, quote: traces[0] });
function dataset(traces, episodes, ops = {}) {
  return {
    corpus: {
      conversations: ["left", "right"].map((id) => ({ id, space_id: "space" })),
      traces
    },
    labels: {
      topics: [{ id: "topic", space_id: "space", domain: "领域" }, { id: "other", space_id: "space", domain: "领域" }],
      entries: { dec: { kind: "decision", topic: "topic" }, other: { kind: "decision", topic: "other" } },
      traces: Object.fromEntries(traces.map((trace) => [trace.id, { ops: ops[trace.id] ?? [] }]))
    },
    episodes: { episodes }
  };
}

test("the virtual clock distinguishes a semantic episode, an idle split, and a retransmission", () => {
  const turns = [turn("a", "left", "09:00:00"), turn("b", "left", "09:20:00"),
    turn("copy", "left", "09:00:00", { resubmitOf: "a", submit_time: time("09:04:00") })];
  const ds = dataset(turns, [episode("work", ["a", "b"])], { a: [{ op: "add", entry: "dec" }] });
  const timeline = buildEpisodeTimeline(ds);
  assert.deepEqual(timeline.batches.map(({ traces, closeReason }) => [traces, closeReason]), [[['a'], 'idle'], [['b'], 'idle']]);
  assert.equal(timeline.events.find((event) => event.kind === "resubmit").trace, "copy");
  assert.equal(timeline.batchByTrace.get("b").previous, timeline.batchByTrace.get("a").id);
  assert.equal(timeline.commitByTrace.has("copy"), false);
});

test("a staged decision becomes visible after a later formation, then an existing topic can update", () => {
  const turns = [turn("a", "left", "09:00:00"), turn("b", "right", "11:01:00"), turn("c", "left", "11:30:00")];
  const ds = dataset(turns, [episode("first", ["a"]), episode("next", ["b"], "other"), episode("edit", ["c"])], {
    a: [{ op: "add", entry: "dec" }], b: [{ op: "add", entry: "other" }], c: [{ op: "rewrite", entry: "dec" }]
  });
  const timeline = buildEpisodeTimeline(ds);
  assert.equal(timeline.batchByTrace.get("a").stagedAt, time("09:15:01"));
  assert.equal(timeline.commitByTrace.get("a"), time("11:16:01"));
  assert.equal(timeline.commitByTrace.get("a"), timeline.commitByTrace.get("b"));
  assert.equal(timeline.commitByTrace.get("c"), time("11:45:01"));
  assert.equal(timeline.events.filter((event) => event.kind === "formation").length, 1);
});

test("episode gold rejects missing, repeated, noncontiguous and cross-conversation turns", () => {
  const turns = [turn("a", "left", "09:00:00"), turn("b", "left", "09:05:00"), turn("c", "left", "09:10:00"), turn("d", "right", "09:10:00")];
  const ds = dataset(turns, [episode("bad", ["a", "c", "d"]), episode("again", ["a"])]);
  assert.match(validateEpisodeLabels(ds).join("\n"), /not contiguous/);
  assert.match(validateEpisodeLabels(ds).join("\n"), /crosses conversation/);
  assert.match(validateEpisodeLabels(ds).join("\n"), /multiple episodes/);
  assert.match(validateEpisodeLabels(ds).join("\n"), /missing episode for b/);
});

test("turn limit, longest wait, and semantic switch each close an active batch", () => {
  const left = Array.from({ length: 8 }, (_, i) => turn(`l${i}`, "left", `09:${String(3 * i).padStart(2, "0")}:00`));
  const right = Array.from({ length: 4 }, (_, i) => turn(`r${i}`, "right", `09:${String(9 * i).padStart(2, "0")}:00`));
  const closing = turn("next", "left", "09:32:00");
  const switchTurn = turn("switch", "left", "09:34:00");
  const ds = dataset([...left, ...right, closing, switchTurn], [
    episode("left", left.map((trace) => trace.id)), episode("right", right.map((trace) => trace.id)),
    episode("next", ["next"]), episode("switch", ["switch"], "other")
  ]);
  const { batchByTrace } = buildEpisodeTimeline(ds);
  assert.equal(batchByTrace.get("l0").closeReason, "turn_count");
  assert.equal(batchByTrace.get("r0").closeReason, "max_wait");
  assert.equal(batchByTrace.get("next").closeReason, "task_boundary");
  assert.equal(batchByTrace.get("next").closedAt, time("09:34:00"));
});
