import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { API_ROUTES, createMemoryHttpServer } from "../../../src/server/http.js";
import { createProjectMemoryHarness, emptyReply, stubModel } from "./helpers.js";

const realFetch = globalThis.fetch;
const harness = createProjectMemoryHarness();
const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await harness.cleanup();
});

async function startServer() {
  const { service } = harness.createService();
  const server = createMemoryHttpServer({ service });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected TCP address");
  const base = `http://127.0.0.1:${address.port}/api/openmem/v1`;
  return async (route: string, body: Record<string, unknown>) => {
    const response = await realFetch(`${base}/${route}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-memos-tz": "Asia/Shanghai" },
      body: JSON.stringify(body)
    });
    return { status: response.status, body: await response.json() as { code: number; message: string; data: any } };
  };
}

async function waitForTask(post: Awaited<ReturnType<typeof startServer>>, taskId: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const status = await post("get/status", { task_id: taskId });
    if (status.body.data.status === "completed" || status.body.data.status === "failed") return status.body.data;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("task did not finish");
}

describe("openmem HTTP contract", () => {
  it("lists every openmem route in the advertised API routes", () => {
    const paths = API_ROUTES.map((route) => (typeof route === "string" ? route : JSON.stringify(route)));
    for (const route of [
      "add/message", "search/memory", "get/status", "get/memory", "delete/memory",
      "create/space", "get/space", "update/space", "delete/space",
      "create/domains", "list/domains", "update/domains", "delete/domains"
    ]) {
      expect(paths.some((path) => path.includes(`/api/openmem/v1/${route}`)), route).toBe(true);
    }
  });

  it("runs create_space → create_domains → add_message → get/status → search/memory", async () => {
    stubModel((payload) => ({
      ...emptyReply(),
      drafts: [{ kind: "decision", content: "推送失败后指数退避重试三次。", message_idx: 0, user_ids: [payload.messages[0]!.user_id], topic: { new_topic: "n1" } }],
      new_topics: [{ ref: "n1", topic_name: "推送服务重试", topic_summary: "推送失败后的重试策略", topic_description: "" }]
    }));
    const post = await startServer();

    const space = await post("create/space", { space_name: "推送服务", instructions: "只记录工程决策" });
    expect(space.status).toBe(200);
    expect(space.body).toMatchObject({ code: 0, message: "ok" });
    const spaceId = space.body.data.space_id as string;
    expect(spaceId).toMatch(/^space_[0-9a-f]+$/);

    const domains = await post("create/domains", { space_id: spaceId, domains: [{ domain: "代码开发", description: "编码与架构" }] });
    expect(domains.body.data).toEqual({ space_id: spaceId, domains: [{ domain: "代码开发", description: "编码与架构" }] });

    const accepted = await post("add/message", {
      user_id: "user_a",
      agent_id: "codex",
      conversation_id: "conv_1",
      space_ids: [spaceId],
      allow_memory_view: ["project"],
      messages: [{ role: "user", chat_time: "2026-10-29 10:00:00", content: "推送失败就指数退避重试三次。" }]
    });
    expect(accepted.body).toMatchObject({ code: 0, data: { success: true, status: "running" } });

    const finished = await waitForTask(post, accepted.body.data.task_id);
    expect(finished).toMatchObject({ status: "completed", memory_views: { added: 1, project: { deferred_count: 0 } } });

    const searched = await post("search/memory", {
      user_id: "user_a",
      query: "推送失败怎么重试",
      space_ids: spaceId,
      include_memory_view: ["project"],
      memory_limit_number: 3
    });
    expect(searched.status).toBe(200);
    expect(searched.body.data.topic_detail_list).toEqual([expect.objectContaining({
      space_id: spaceId,
      domain: "代码开发",
      topic_name: "推送服务重试",
      decisions: [{ content: "推送失败后指数退避重试三次。", time: "2026-10-29T10:00:00+08:00", user_ids: ["user_a"] }],
      relativity: expect.any(Number)
    })]);

    const inUse = await post("delete/domains", { space_id: spaceId, domains: ["代码开发"] });
    expect(inUse.status).toBe(409);
    expect(inUse.body).toMatchObject({ code: 40903, message: "DOMAIN_IN_USE" });
  });

  it("maps errors to the v3 envelope and HTTP status", async () => {
    stubModel(() => emptyReply());
    const post = await startServer();

    const missing = await post("get/space", { space_id: "space_missing" });
    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({ code: 40401, message: "SPACE_NOT_FOUND" });

    const space = await post("create/space", { space_id: "space_a", domains: [{ domain: "代码开发", description: "" }] });
    expect(space.body.code).toBe(0);

    const multiUser = await post("add/message", {
      user_id: ["user_a", "user_b"],
      agent_id: "codex",
      space_ids: ["space_a"],
      allow_memory_view: ["project"],
      messages: [{ role: "user", content: "hi" }]
    });
    expect(multiUser.status).toBe(400);
    expect(multiUser.body).toMatchObject({ code: 40004, message: "MODE_UNSUPPORTED" });

    const badDomain = await post("add/message", {
      user_id: "user_a",
      agent_id: "codex",
      space_ids: ["space_a"],
      allow_memory_view: ["project"],
      domains: ["运维"],
      messages: [{ role: "user", content: "hi" }]
    });
    expect(badDomain.body).toMatchObject({ code: 40002, message: "DOMAIN_INVALID" });

    const unknownTask = await post("get/status", { task_id: "task_missing" });
    expect(unknownTask.status).toBe(404);
    expect(unknownTask.body.code).toBe(40403);
  });
});
