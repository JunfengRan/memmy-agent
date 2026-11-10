import { describe, expect, it } from "vitest";
import {
  OpenMemCloudClient,
  type OpenMemFetch,
  openMemAddMessageFromTurnComplete,
  openMemFeedbackFromFeedback
} from "../../src/index.js";

describe("OpenMem cloud REST client contract", () => {
  it("maps Memmy lifecycle DTOs to the documented OpenMem memories REST operations", async () => {
    const calls: Array<{
      url: string;
      authorization: string | null;
      body: Record<string, unknown>;
    }> = [];
    const fetchImpl: OpenMemFetch = async (input, init) => {
      const headers = new Headers(init?.headers);
      calls.push({
        url: String(input),
        authorization: headers.get("authorization"),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>
      });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    };
    const client = new OpenMemCloudClient({
      endpoint: "https://memos.memtensor.cn/api/openmem/v1/",
      apiKey: "cloud-key",
      fetchImpl
    });

    const addMessage = openMemAddMessageFromTurnComplete({
      userId: "user-1",
      conversationId: "session-1",
      turnId: "turn-1",
      agentId: "memmy-agent",
      appId: "memmy-app",
      spaceIds: ["space_memos_cloud"],
      domains: ["代码开发"],
      allowMemoryView: ["project"],
      tags: ["agent"],
      allowKnowledgebaseIds: ["kb-local"],
      request: {
        sessionId: "session-1",
        episodeId: "episode-1",
        query: "remember this",
        answer: "stored as an L1 trace",
        tags: ["memory"],
        toolCalls: [{ id: "call-shell", name: "shell", input: { cmd: "npm test" } }],
        toolResults: [{ tool_call_id: "call-shell", content: "tests passed" }],
        sourceMemoryIds: ["mem-1"]
      }
    });
    expect(addMessage).toMatchObject({
      user_id: "user-1",
      conversation_id: "session-1",
      agent_id: "memmy-agent",
      app_id: "memmy-app",
      tags: ["agent", "memory"],
      allow_knowledgebase_ids: ["kb-local"],
      space_ids: ["space_memos_cloud"],
      domains: ["代码开发"],
      allow_memory_view: ["project"],
      info: {
        memory_layer: "L1",
        turn_id: "turn-1",
        episode_id: "episode-1",
        source_memory_ids: ["mem-1"]
      }
    });
    expect(addMessage.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool"]);
    expect(addMessage.messages[1]).toMatchObject({
      role: "assistant",
      tool_calls: [{
        id: "call-shell",
        type: "function",
        function: {
          name: "shell",
          arguments: "{\"cmd\":\"npm test\"}"
        }
      }]
    });
    expect(addMessage.messages[2]).toMatchObject({
      role: "tool",
      tool_call_id: "call-shell",
      content: "tests passed"
    });

    const feedback = openMemFeedbackFromFeedback({
      userId: "user-1",
      conversationId: "session-1",
      agentId: "memmy-agent",
      appId: "memmy-app",
      feedbackTime: "2026-05-30T08:00:00.000Z",
      allowKnowledgebaseIds: ["kb-1"],
      request: {
        sessionId: "session-1",
        episodeId: "episode-1",
        channel: "explicit",
        polarity: "negative",
        magnitude: 0.9,
        rationale: "The memory should prefer SQLite locally.",
        l1MemoryId: "mem-1"
      }
    });
    expect(feedback).toMatchObject({
      user_id: "user-1",
      conversation_id: "session-1",
      feedback_content: "The memory should prefer SQLite locally.",
      agent_id: "memmy-agent",
      app_id: "memmy-app",
      feedback_time: "2026-05-30T08:00:00.000Z",
      allow_knowledgebase_ids: ["kb-1"],
      info: {
        memory_layer: "feedback",
        episode_id: "episode-1",
        l1_memory_id: "mem-1",
        channel: "explicit",
        polarity: "negative",
        magnitude: 0.9
      }
    });

    await client.addMessage(addMessage);
    await client.searchMemory({
      user_id: "user-1",
      query: "项目记忆接口当前状态？",
      conversation_id: "session-1",
      space_ids: "space_memos_cloud",
      domains: "代码开发",
      include_memory_view: ["project"],
      memory_limit_number: 3,
      recall_via: "tool"
    });
    await client.addFeedback(feedback);

    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
      "/api/openmem/v1/add/message",
      "/api/openmem/v1/search/memory",
      "/api/openmem/v1/add/feedback"
    ]);
    expect(calls.map((call) => call.authorization)).toEqual([
      "Token cloud-key",
      "Token cloud-key",
      "Token cloud-key"
    ]);
    expect(calls[0]!.body).toMatchObject({ user_id: "user-1", messages: addMessage.messages });
    expect(calls[1]!.body).toMatchObject({
      user_id: "user-1",
      query: "项目记忆接口当前状态？",
      space_ids: "space_memos_cloud",
      domains: "代码开发",
      include_memory_view: ["project"],
      memory_limit_number: 3
    });
    expect(calls[1]!.body).not.toHaveProperty("recall_via");
    expect(calls[2]!.body).toMatchObject({ feedback_content: "The memory should prefer SQLite locally." });
  });

  it("requires an explicit non-empty project space for project memory", async () => {
    const client = new OpenMemCloudClient({
      endpoint: "https://memos.memtensor.cn/api/openmem/v1",
      fetchImpl: async () => new Response("{}", { status: 200 })
    });
    expect(() => client.searchMemory({
      user_id: "user-1",
      query: "项目当前状态",
      include_memory_view: ["project"]
    })).toThrow("space_ids");
  });

  it("rejects standard project scope and search limit violations before HTTP", () => {
    const client = new OpenMemCloudClient({
      endpoint: "https://memos.memtensor.cn/api/openmem/v1",
      fetchImpl: async () => new Response("{}", { status: 200 })
    });
    expect(() => client.addMessage({
      user_id: "user-1",
      messages: [{ role: "user", content: "hello" }],
      allow_memory_view: ["project"],
      space_ids: Array.from({ length: 21 }, (_, index) => `space-${index}`)
    })).toThrow("at most 20 space_ids");
    expect(() => client.searchMemory({
      user_id: "user-1",
      query: "项目当前状态",
      include_memory_view: ["project"],
      space_ids: "space-1",
      domains: []
    })).toThrow("domains");
    expect(() => client.searchMemory({
      user_id: "user-1",
      query: "项目当前状态",
      include_memory_view: ["project"],
      space_ids: "space-1",
      memory_limit_number: 26
    })).toThrow("memory_limit_number");
  });
});
