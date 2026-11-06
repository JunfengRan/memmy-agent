/**
 * Isolated topic-routing eval. It does not start the memory server and does not
 * turn MEMMY_DECISION_TOPIC on. Credentials come from ~/.openai.env.
 * `--self-check` scores a lexical control only.
 *
 *   cd Memory && npx tsx ../eval/project-memory/jev-topic/run-jev-topic-eval.ts --self-check
 *   cd Memory && npx tsx ../eval/project-memory/jev-topic/run-jev-topic-eval.ts
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DecisionTopicClient, openAIEnvPath, resolveDecisionCredentials } from "../../../Memory/src/service/project-memory/decisions/client.js";
import {
  JEV_NEW_TOPIC,
  JEV_NO_TOPIC,
  JEV_TOPIC_DECISION_VERSION,
  buildAddTopicRequest,
  buildSearchTopicRequest,
  rankTopicIds,
  topicRecallAt,
  type ParsedTopicChoice,
  type TopicBrief
} from "../../../Memory/src/service/project-memory/decisions/topic-choice.js";
import { tokenOverlap, uniqueTokens } from "../../../Memory/src/service/project-memory/text.js";
import { assertJevTopicCases, buildJevTopicCases, loadTopicDataset, type AddTopicCase, type SearchTopicCase } from "./cases.js";

const selfCheck = process.argv.includes("--self-check");
const credentials = resolveDecisionCredentials();

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index] ?? null;
}

function cardText(topic: TopicBrief): string {
  return `${topic.name}\n${topic.summary}\n${topic.description}`;
}

function lexicalRank(text: string, topics: TopicBrief[]): string[] {
  const tokens = uniqueTokens(text);
  return [...topics].sort((left, right) => tokenOverlap(tokens, cardText(right)) - tokenOverlap(tokens, cardText(left)) || left.id.localeCompare(right.id))
    .map((topic) => topic.id);
}

function lexicalAddChoice(item: AddTopicCase): string {
  if (item.topics.length === 0) return JEV_NEW_TOPIC;
  const text = `${item.query}\n${item.answer}`;
  const [top] = lexicalRank(text, item.topics);
  if (!top) return JEV_NEW_TOPIC;
  const topic = item.topics.find((candidate) => candidate.id === top);
  return topic && tokenOverlap(uniqueTokens(text), cardText(topic)) > 0 ? top : JEV_NEW_TOPIC;
}

function bucket(expected: string): "existing" | "new" | "none" {
  if (expected === JEV_NEW_TOPIC) return "new";
  if (expected === JEV_NO_TOPIC) return "none";
  return "existing";
}

function accuracy(rows: Array<{ expected: string; predicted: string }>, kind?: "existing" | "new" | "none"): number | null {
  const picked = kind ? rows.filter((row) => bucket(row.expected) === kind) : rows;
  return mean(picked.map((row) => (row.predicted === row.expected ? 1 : 0)));
}

function recall(rows: Array<{ ranked: string[]; expectedTopics: string[] }>, k: number): number | null {
  return mean(rows.map((row) => topicRecallAt(row.ranked, row.expectedTopics, k)));
}

function round(value: number | null): number | null {
  return value === null ? null : Math.round(value * 1000) / 1000;
}

async function decideAll(
  client: DecisionTopicClient,
  cases: { add: AddTopicCase[]; search: SearchTopicCase[] }
): Promise<{ add: ParsedTopicChoice[]; search: ParsedTopicChoice[]; latencies: number[]; errors: string[] }> {
  const add: ParsedTopicChoice[] = [];
  const search: ParsedTopicChoice[] = [];
  const latencies: number[] = [];
  const errors: string[] = [];
  const run = async (label: string, request: ReturnType<typeof buildAddTopicRequest>) => {
    const started = Date.now();
    try {
      const choice = await client.decide(request);
      latencies.push(Date.now() - started);
      return choice;
    } catch (error) {
      errors.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  };
  for (const item of cases.add) {
    const choice = await run(item.id, buildAddTopicRequest(item));
    if (!choice) break;
    add.push(choice);
  }
  if (errors.length === 0) {
    for (const item of cases.search) {
      const choice = await run(item.id, buildSearchTopicRequest(item));
      if (!choice) break;
      search.push(choice);
    }
  }
  return { add, search, latencies, errors };
}

function reportOf(
  cases: ReturnType<typeof buildJevTopicCases>,
  jev: { add: ParsedTopicChoice[]; search: ParsedTopicChoice[] } | null,
  meta: Record<string, unknown>
) {
  const lexicalAdd = cases.add.map((item) => ({ expected: item.expected, predicted: lexicalAddChoice(item) }));
  const lexicalSearch = cases.search.map((item) => ({ ranked: lexicalRank(item.query, item.topics), expectedTopics: item.expectedTopics }));
  const jevAdd = jev ? cases.add.slice(0, jev.add.length).map((item, index) => ({ expected: item.expected, predicted: jev.add[index]!.choice })) : null;
  const jevSearch = jev ? cases.search.slice(0, jev.search.length).map((item, index) => {
    const choice = jev.search[index]!;
    const picked = choice.choice === JEV_NEW_TOPIC || choice.choice === JEV_NO_TOPIC ? [] : [choice.choice];
    return {
      ranked: rankTopicIds(choice),
      picked,
      expectedTopics: item.expectedTopics,
      kind: item.kind
    };
  }) : null;
  const byKind = (rows: Array<{ ranked: string[]; expectedTopics: string[]; kind: string }>) => Object.fromEntries(
    [...new Set(rows.map((row) => row.kind))].sort().map((kind) => {
      const group = rows.filter((row) => row.kind === kind);
      return [kind, { n: group.length, recallAt1: round(recall(group, 1)) }];
    })
  );
  return {
    ...meta,
    decisionVersion: JEV_TOPIC_DECISION_VERSION,
    counts: {
      add: cases.add.length,
      addExisting: cases.add.filter((item) => bucket(item.expected) === "existing").length,
      addNew: cases.add.filter((item) => bucket(item.expected) === "new").length,
      addNone: cases.add.filter((item) => bucket(item.expected) === "none").length,
      skipped: cases.skipped,
      search: cases.search.length
    },
    lexical: {
      addAccuracy: round(accuracy(lexicalAdd)),
      addAccuracyExisting: round(accuracy(lexicalAdd, "existing")),
      addAccuracyNew: round(accuracy(lexicalAdd, "new")),
      addAccuracyNone: round(accuracy(lexicalAdd, "none")),
      searchRecallAt1: round(recall(lexicalSearch, 1)),
      searchRecallAt3: round(recall(lexicalSearch, 3)),
      searchRecallAt9: round(recall(lexicalSearch, 9))
    },
    jev: jevAdd && jevSearch ? {
      calls: jevAdd.length + jevSearch.length,
      addAccuracy: round(accuracy(jevAdd)),
      addAccuracyExisting: round(accuracy(jevAdd, "existing")),
      addAccuracyNew: round(accuracy(jevAdd, "new")),
      addAccuracyNone: round(accuracy(jevAdd, "none")),
      searchSelectionRecallAt1: round(recall(jevSearch.map((row) => ({ ranked: row.picked, expectedTopics: row.expectedTopics })), 1)),
      searchRecallAt1: round(recall(jevSearch, 1)),
      searchRecallAt3: round(recall(jevSearch, 3)),
      searchRecallAt9: round(recall(jevSearch, 9)),
      searchByKind: byKind(jevSearch.map((row) => ({ ranked: row.picked, expectedTopics: row.expectedTopics, kind: row.kind })))
    } : null
  };
}

const cases = buildJevTopicCases(loadTopicDataset());
assertJevTopicCases(cases);

const outDir = join(dirname(fileURLToPath(import.meta.url)), "../runs", `${new Date().toISOString().slice(0, 10)}-jev-topic`);
mkdirSync(outDir, { recursive: true });

if (selfCheck) {
  const report = reportOf(cases, null, { mode: "self-check", model: null });
  writeFileSync(join(outDir, "lexical-only.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

if (!credentials) {
  const path = openAIEnvPath();
  const reason = existsSync(path) ? `${path} is missing OPENAI_API_KEY or OPENAI_API_BASE` : `${path} does not exist`;
  console.error(`${reason}. Use the same fields as ~/.claude.env: MODEL, OPENAI_API_KEY, OPENAI_API_BASE. The product flag MEMMY_DECISION_TOPIC stays off.`);
  process.exit(2);
}

const client = new DecisionTopicClient(credentials);
const started = Date.now();
const live = await decideAll(client, cases);
const report = reportOf(cases, { add: live.add, search: live.search }, {
  mode: "gpt-6-luna-chat-choice",
  model: credentials.model,
  baseUrl: credentials.baseUrl,
  wallclockMs: Date.now() - started,
  latencyMs: { p50: percentile(live.latencies, 0.5), p95: percentile(live.latencies, 0.95) },
  usage: {
    inputTokens: [...live.add, ...live.search].reduce((sum, item) => sum + item.inputTokens, 0),
    outputTokens: [...live.add, ...live.search].reduce((sum, item) => sum + item.outputTokens, 0)
  },
  errors: live.errors
});
writeFileSync(join(outDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
if (live.errors.length > 0) process.exit(1);
