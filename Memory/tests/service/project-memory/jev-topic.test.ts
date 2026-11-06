import { describe, expect, it } from "vitest";
import {
  DecisionTopicClient,
  createDecisionTopicRouter,
  decisionTopicEnabled,
  resolveDecisionCredentials
} from "../../../src/service/project-memory/decisions/client.js";
import {
  JEV_NEW_TOPIC,
  JEV_NO_TOPIC,
  buildAddTopicRequest,
  buildSearchTopicRequest,
  narrowAddCandidates,
  orderSearchByJev,
  parseTopicChoice,
  rankTopicIds,
  topicRecallAt,
  type ParsedTopicChoice
} from "../../../src/service/project-memory/decisions/topic-choice.js";

function choice(id: string, probabilities: Record<string, number> = {}): ParsedTopicChoice {
  return { choice: id, confidence: probabilities[id] ?? 1, probabilities, model: "gpt-6-luna", inputTokens: 3, outputTokens: 1 };
}

const topics = [
  { topicId: "topic_a", name: "a" },
  { topicId: "topic_b", name: "b" },
  { topicId: "topic_c", name: "c" }
];

const envFile = [
  "MODEL=gpt-6-luna",
  "OPENAI_API_KEY=test-key",
  "OPENAI_API_BASE=https://gateway.example/v1"
].join("\n");

describe("OpenAI decision topic choice", () => {
  it("stays off unless the experiment flag is set, and reads the openai env file shape", () => {
    expect(decisionTopicEnabled({})).toBe(false);
    expect(decisionTopicEnabled({ MEMMY_DECISION_TOPIC: "true" })).toBe(false);
    expect(decisionTopicEnabled({ VITEST: "true", MEMMY_DECISION_TOPIC: "1" })).toBe(false);
    expect(decisionTopicEnabled({ VITEST: "true", MEMMY_DECISION_TOPIC: "1", MEMMY_DECISION_TOPIC_IN_TEST: "1" })).toBe(true);
    expect(createDecisionTopicRouter({ MEMMY_DECISION_TOPIC: "1", MEMMY_DECISION_TOPIC_IN_TEST: "1" }, "")).toBeNull();
    expect(createDecisionTopicRouter({})).toBeNull();
    expect(resolveDecisionCredentials({ MODEL: "deepseek-x" }, envFile)).toEqual({
      apiKey: "test-key",
      baseUrl: "https://gateway.example/v1",
      model: "gpt-6-luna"
    });
    const overridden = resolveDecisionCredentials({ OPENAI_DECISION_MODEL: "gpt-6-luna" }, "MODEL=other\nOPENAI_API_KEY=k\nOPENAI_API_BASE=https://gateway.example/v1\n");
    expect(overridden?.model).toBe("gpt-6-luna");
  });

  it("asks which topic a query and answer belong to, or which topic search should select", () => {
    const add = buildAddTopicRequest({
      query: "月报金额放哪",
      answer: "继续写在 journal 正文",
      topics: [{ id: "tp_report", name: "月报", summary: "按客户汇总", description: "金额在正文", domain: "代码开发" }]
    });
    expect(add.questions.topic.criteria.tp_report).toContain("月报");
    expect(add.questions.topic.criteria[JEV_NEW_TOPIC]).toBeTruthy();
    expect(add.questions.topic.criteria[JEV_NO_TOPIC]).toBeTruthy();
    expect(add.state).toContain("USER QUERY:");
    expect(add.state).toContain("ASSISTANT ANSWER:");

    const search = buildSearchTopicRequest({
      query: "金额从哪取",
      topics: [{ id: "tp_report", name: "月报", summary: "按客户汇总", description: "" }]
    });
    expect(search.questions.topic.criteria[JEV_NO_TOPIC]).toBeTruthy();
    expect(search.questions.topic.criteria[JEV_NEW_TOPIC]).toBeUndefined();
    expect(() => buildAddTopicRequest({ query: "q", answer: "a", topics: [{ id: "new", name: "n", summary: "", description: "" }] })).toThrow(/topic id/);
  });

  it("narrows add candidates and promotes the search topic without dropping the rest", () => {
    expect(narrowAddCandidates(topics, choice("topic_b"), (item) => item.topicId).map((item) => item.topicId)).toEqual(["topic_b"]);
    expect(narrowAddCandidates(topics, choice(JEV_NEW_TOPIC), (item) => item.topicId)).toEqual([]);
    expect(narrowAddCandidates(topics, choice(JEV_NO_TOPIC), (item) => item.topicId)).toEqual(topics);
    expect(narrowAddCandidates(topics, choice("missing"), (item) => item.topicId)).toEqual(topics);
    expect(narrowAddCandidates(topics, null, (item) => item.topicId)).toEqual(topics);

    const ordered = orderSearchByJev(topics.slice(0, 2), topics, choice("topic_c"), 2, (item) => item.topicId);
    expect(ordered.map((item) => item.topicId)).toEqual(["topic_c", "topic_a"]);
    expect(orderSearchByJev(topics, topics, choice(JEV_NO_TOPIC), 3, (item) => item.topicId).map((item) => item.topicId)).toEqual(["topic_a", "topic_b", "topic_c"]);
  });

  it("ranks topic probabilities and scores recall the same way as the v2 scorer", () => {
    const parsed = choice("topic_b", { topic_b: 0.2, topic_a: 0.7, none: 0.1 });
    expect(rankTopicIds(parsed)).toEqual(["topic_a", "topic_b"]);
    expect(topicRecallAt(rankTopicIds(parsed), ["topic_b"], 1)).toBe(0);
    expect(topicRecallAt(rankTopicIds(parsed), ["topic_b"], 3)).toBe(1);
    expect(topicRecallAt(["topic_b"], ["topic_b"], 1)).toBe(1);
  });

  it("posts an OpenAI Decisions choice and retries only retryable failures", async () => {
    const bodies: unknown[] = [];
    const responses = [
      new Response("busy", { status: 503 }),
      new Response(JSON.stringify({
        model: "gpt-6-luna-2026-09-22",
        choices: [{ message: { content: JSON.stringify({ choice: "tp_report", probabilities: { tp_report: 0.91, new: 0.0, none: 0.09 } }) } }],
        usage: { prompt_tokens: 12, completion_tokens: 4 }
      }), { status: 200 })
    ];
    const client = new DecisionTopicClient({
      baseUrl: "https://gateway.example/v1",
      apiKey: "test-key",
      model: "gpt-6-luna",
      sleep: async () => {},
      fetchImpl: async (url, init) => {
        bodies.push({ url, body: JSON.parse(String(init?.body)), authorization: new Headers(init?.headers).get("authorization") });
        const next = responses.shift();
        if (!next) throw new Error("no response left");
        return next;
      }
    });
    const request = buildAddTopicRequest({ query: "q", answer: "a", topics: [{ id: "tp_report", name: "月报", summary: "汇总", description: "" }] });
    const parsed = await client.decide(request);
    expect(parsed).toMatchObject({ choice: "tp_report", confidence: 0.91, model: "gpt-6-luna-2026-09-22", inputTokens: 12, outputTokens: 4 });
    expect(parsed.probabilities).toEqual({ tp_report: 0.91, new: 0, none: 0.09 });
    expect(bodies).toHaveLength(2);
    const sent = bodies[0] as { url: string; authorization: string; body: { model: string; temperature?: number; messages: Array<{ role: string }>; response_format: { type: string } } };
    expect(sent.url).toBe("https://gateway.example/v1/chat/completions");
    expect(sent.authorization).toBe("Bearer test-key");
    expect(sent.body.model).toBe("gpt-6-luna");
    expect(sent.body.temperature).toBeUndefined();
    expect(sent.body.messages[0]?.role).toBe("system");
    expect(sent.body.messages[1]?.role).toBe("user");
    expect(sent.body.response_format.type).toBe("json_schema");

    let calls = 0;
    const rejected = new DecisionTopicClient({
      baseUrl: "https://gateway.example/v1",
      apiKey: "test-key",
      model: "gpt-6-luna",
      fetchImpl: async () => {
        calls += 1;
        return new Response("bad", { status: 400 });
      }
    });
    await expect(rejected.decide(request)).rejects.toThrow(/HTTP 400/);
    expect(calls).toBe(1);
    expect(() => parseTopicChoice({ answers: [{ name: "topic", type: "choice", choice: "other" }] }, ["tp_report"])).toThrow(/listed choice/);
  });
});
