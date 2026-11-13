import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { JEV_NEW_TOPIC, JEV_NO_TOPIC, type TopicBrief } from "../../../Memory/src/service/project-memory/decisions/topic-choice.js";

export interface AddTopicCase {
  id: string;
  spaceId: string;
  query: string;
  answer: string;
  topics: TopicBrief[];
  /** Existing topic id, `new` on the first turn of a topic, or `none` for unrelated chat. */
  expected: string;
}

export interface SearchTopicCase {
  id: string;
  kind: string;
  spaceId: string;
  query: string;
  topics: TopicBrief[];
  expectedTopics: string[];
}

export interface SkippedTrace {
  id: string;
  reason: string;
}

export interface JevTopicCases {
  add: AddTopicCase[];
  search: SearchTopicCase[];
  skipped: SkippedTrace[];
}

interface CorpusTrace {
  id: string;
  conversation: string;
  chat_time: string;
  query: string;
  answer: string;
}

interface LabelTopic {
  id: string;
  space_id: string;
  domain: string;
  topic_name: string;
  summaryKeyPoints: string[];
  descriptionKeyPoints: string[];
}

interface GoldEntry {
  topic: string;
  content: string;
  sources?: string[];
}

interface Dataset {
  corpus: {
    conversations: Array<{ id: string; space_id: string }>;
    traces: CorpusTrace[];
  };
  labels: {
    topics: LabelTopic[];
    entries: Record<string, { topic: string }>;
    traces: Record<string, { ops?: Array<{ entry?: string }>; dropped?: Array<{ reason?: string }> }>;
  };
  gold: { entries: GoldEntry[] };
  questions: {
    questions: Array<{
      id: string;
      askedAt: string;
      space_id: string;
      kind: string;
      question: string;
      excluded?: boolean;
      expect: { topics: string[] };
    }>;
  };
}

export function loadTopicDataset(dir = join(dirname(fileURLToPath(import.meta.url)), "../gold-add-memory/dataset")): Dataset {
  const read = <T>(name: string) => JSON.parse(readFileSync(join(dir, name), "utf8")) as T;
  return {
    corpus: read("corpus.json"),
    labels: read("labels.json"),
    gold: read("gold.json"),
    questions: read("questions.json")
  };
}

function writtenTopic(dataset: Dataset, traceId: string): string | null {
  const ops = dataset.labels.traces[traceId]?.ops ?? [];
  const topics = [...new Set(ops.map((op) => (op.entry ? dataset.labels.entries[op.entry]?.topic : undefined)).filter((id): id is string => Boolean(id)))];
  if (topics.length > 1) throw new Error(`trace ${traceId} writes more than one topic`);
  return topics[0] ?? null;
}

/**
 * Add cases walk the corpus in time order. A topic becomes a candidate only after
 * an earlier trace in the same space has written it. Those cards include entries
 * already written. Search cases use topics that exist in the space at `askedAt`,
 * and the card is only the name, summary, and description — not the entry text.
 */
export function buildJevTopicCases(dataset: Dataset): JevTopicCases {
  const traces = [...dataset.corpus.traces].sort((left, right) => left.chat_time.localeCompare(right.chat_time) || left.id.localeCompare(right.id));
  const spaceOf = new Map(dataset.corpus.conversations.map((item) => [item.id, item.space_id]));
  const topicById = new Map(dataset.labels.topics.map((topic) => [topic.id, topic]));
  const traceTime = new Map(traces.map((trace) => [trace.id, trace.chat_time]));
  const birth = new Map<string, string>();
  for (const trace of traces) {
    const topicId = writtenTopic(dataset, trace.id);
    if (!topicId) continue;
    const previous = birth.get(topicId);
    if (!previous || trace.chat_time < previous) birth.set(topicId, trace.chat_time);
  }

  const contents = (topicId: string, time: string, inclusive: boolean) => dataset.gold.entries
    .filter((entry) => entry.topic === topicId)
    .filter((entry) => {
      const at = (entry.sources ?? []).map((id) => traceTime.get(id)).filter((value): value is string => Boolean(value)).sort()[0];
      if (!at) return false;
      return inclusive ? at <= time : at < time;
    })
    .map((entry) => entry.content);

  const card = (topicId: string, time: string, mode: "add" | "search"): TopicBrief => {
    const topic = topicById.get(topicId);
    if (!topic) throw new Error(`missing topic ${topicId}`);
    return {
      id: topic.id,
      name: topic.topic_name,
      summary: topic.summaryKeyPoints.join("；"),
      description: mode === "add" ? contents(topicId, time, false).join("\n") : topic.descriptionKeyPoints.join("；"),
      domain: topic.domain
    };
  };

  const known = new Map<string, Set<string>>();
  const add: AddTopicCase[] = [];
  const skipped: SkippedTrace[] = [];
  for (const trace of traces) {
    const spaceId = spaceOf.get(trace.conversation);
    const label = dataset.labels.traces[trace.id];
    if (!spaceId || !label) throw new Error(`trace ${trace.id} has no space or label`);
    const topicId = writtenTopic(dataset, trace.id);
    const drops = label.dropped ?? [];
    let expected: string | null = null;
    let reason = "no_topic_label";
    if (topicId) expected = known.get(spaceId)?.has(topicId) ? topicId : JEV_NEW_TOPIC;
    else if (drops.length > 0 && drops.every((item) => item.reason === "unrelated")) {
      expected = JEV_NO_TOPIC;
      reason = "";
    }
    if (expected) {
      const ids = [...(known.get(spaceId) ?? [])].sort();
      add.push({
        id: trace.id,
        spaceId,
        query: trace.query,
        answer: trace.answer,
        topics: ids.map((id) => card(id, trace.chat_time, "add")),
        expected
      });
    } else skipped.push({ id: trace.id, reason });
    if (topicId) {
      const set = known.get(spaceId) ?? new Set<string>();
      set.add(topicId);
      known.set(spaceId, set);
    }
  }

  const search: SearchTopicCase[] = dataset.questions.questions.filter((question) => !question.excluded).map((question) => ({
    id: question.id,
    kind: question.kind,
    spaceId: question.space_id,
    query: question.question,
    topics: dataset.labels.topics
      .filter((topic) => topic.space_id === question.space_id && (birth.get(topic.id) ?? "\uffff") <= question.askedAt)
      .map((topic) => card(topic.id, question.askedAt, "search")),
    expectedTopics: question.expect.topics
  }));
  return { add, search, skipped };
}

export function assertJevTopicCases(cases: JevTopicCases): void {
  if (cases.add.length + cases.skipped.length !== 35) {
    throw new Error(`expected 35 traces, got ${cases.add.length} scored and ${cases.skipped.length} skipped`);
  }
  if (cases.search.length !== 23) throw new Error(`expected 23 search questions, got ${cases.search.length}`);
  for (const item of cases.add) {
    const ids = new Set(item.topics.map((topic) => topic.id));
    if (item.expected === JEV_NEW_TOPIC || item.expected === JEV_NO_TOPIC) {
      if (item.expected === JEV_NEW_TOPIC && ids.has(item.expected)) throw new Error(`${item.id} marks an existing topic as new`);
      continue;
    }
    if (!ids.has(item.expected)) throw new Error(`${item.id} expects ${item.expected} which is not a candidate`);
  }
  for (const item of cases.search) {
    if (item.expectedTopics.length !== 1) throw new Error(`${item.id} should expect one topic`);
    const ids = new Set(item.topics.map((topic) => topic.id));
    for (const topicId of item.expectedTopics) {
      if (!ids.has(topicId)) throw new Error(`${item.id} expects ${topicId} before that topic exists`);
    }
  }
}
