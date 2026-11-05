// Builds spec-shaped runs from gold: --oracle replays the labelled ops into topic_detail_list at
// every askedAt (perfect system), --empty writes and returns nothing. The scorer must give the
// first 1 and the second 0 on every score.
import { replay } from "./build-gold-baseline.mjs";
import { renderTemplate3 } from "./reader.mjs";

const item = ({ content, time, user_ids }) => ({ content, time, user_ids });

export function oracleTopics(ds, until, spaceId) {
  const { state } = replay(ds, until);
  const topics = [];
  for (const topic of ds.labels.topics.filter((t) => t.space_id === spaceId)) {
    const entries = [...state.entries()].filter(([id]) => ds.labels.entries[id].topic === topic.id && !ds.labels.entries[id].optional);
    if (!entries.length) continue;
    const of = (kind) => entries.filter(([id]) => ds.labels.entries[id].kind === kind).map(([, entry]) => entry);
    const times = entries.flatMap(([, e]) => [e.time, ...e.conflicts.map((c) => c.time)]).sort();
    topics.push({
      id: topic.id,
      space_id: spaceId,
      domain: topic.domain,
      topic_name: topic.topic_name,
      topic_summary: topic.summaryKeyPoints.join("；"),
      topic_description: topic.descriptionKeyPoints.join("；"),
      decisions: of("decision").map((e) => ({ ...item(e), conflicts: e.conflicts.map(item), history: e.history.map((h) => ({ ...item(h), reason: h.reason })) })),
      experiences: of("experience").map((e) => ({ ...item(e), history: e.history.map(item) })),
      timeline: of("timeline").map(item),
      create_time: times[0],
      update_time: times.at(-1)
    });
  }
  return topics.sort((a, b) => b.update_time.localeCompare(a.update_time));
}

export function displayNames(ds) {
  return {
    spaceNames: Object.fromEntries(ds.corpus.spaces.map((s) => [s.space_id, s.space_id.replace(/^space_/, "")])),
    memberNames: Object.fromEntries(ds.corpus.members.map((m) => [m.user_id, m.name]))
  };
}

export function buildOracleRun(ds, gold) {
  const spaces = ds.corpus.spaces.map((s) => s.space_id);
  const names = displayNames(ds);
  const questions = gold.questions.filter((q) => !q.excluded).map((question) => {
    const topics = oracleTopics(ds, question.askedAt, question.space_id);
    const ranked = [...topics.filter((t) => question.expectedTopics.includes(t.id)), ...topics.filter((t) => !question.expectedTopics.includes(t.id))].slice(0, 9);
    return { id: question.id, askedAt: question.askedAt, topic_detail_list: ranked, rendered: renderTemplate3({ topics: ranked, now: question.askedAt, ...names }), answer: question.goldAnswer };
  });
  return {
    runVersion: 2,
    kind: "oracle",
    spaceMap: Object.fromEntries(spaces.map((s) => [s, s])),
    final: Object.fromEntries(spaces.map((s) => [s, oracleTopics(ds, "9999", s)])),
    questions,
    apiChecks: gold.apiChecks.map((check) => ({ id: check.id, passed: true, detail: "oracle" })),
    requests: [],
    usage: {}
  };
}

export function buildEmptyRun(ds, gold) {
  const spaces = ds.corpus.spaces.map((s) => s.space_id);
  return {
    runVersion: 2,
    kind: "empty",
    spaceMap: Object.fromEntries(spaces.map((s) => [s, s])),
    final: Object.fromEntries(spaces.map((s) => [s, []])),
    questions: gold.questions.filter((q) => !q.excluded).map((q) => ({ id: q.id, askedAt: q.askedAt, topic_detail_list: [], rendered: "", answer: "" })),
    apiChecks: [],
    requests: [],
    usage: {}
  };
}
