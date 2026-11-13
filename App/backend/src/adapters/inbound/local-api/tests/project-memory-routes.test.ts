import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerProjectRoutes } from "../routes/projects.js";
import type { DesktopProjectMemoryService } from "../../../../services/project-memory-service.js";
const id = "22222222-2222-4222-8222-222222222222";
const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });
function fixture() {
  const app = Fastify(); apps.push(app);
  const service = { view: vi.fn(async () => ({ binding: null, jobs: [], error: null })), configure: vi.fn(async () => ({ binding: null, jobs: [], error: null })), importSessions: vi.fn(async () => ({})) };
  registerProjectRoutes(app, { projectMemory: service as unknown as DesktopProjectMemoryService, authenticateRuntimeToken: async (request, reply) => { if (request.headers["x-memmy-local-token"] !== "test-token") return reply.code(401).send({ error: { code: "unauthorized" } }); } });
  return { app, service };
}
describe("project memory BFF routes", () => {
  it("protects reads and writes with the existing runtime token", async () => {
    const { app, service } = fixture();
    for (const method of ["GET", "PUT"] as const) expect((await app.inject({ method, url: `/api/projects/${id}/memory`, ...(method === "PUT" ? { payload: { enabled: true } } : {}) })).statusCode).toBe(401);
    expect(service.view).not.toHaveBeenCalled(); expect(service.configure).not.toHaveBeenCalled();
    const response = await app.inject({ method: "PUT", url: `/api/projects/${id}/memory`, headers: { "x-memmy-local-token": "test-token" }, payload: { enabled: true } });
    expect(response.statusCode).toBe(200); expect(service.configure).toHaveBeenCalledWith(id, true);
  });
  it("rejects invalid project IDs and imported Space/model-controlled fields", async () => {
    const { app, service } = fixture();
    const headers = { "x-memmy-local-token": "test-token" };
    expect((await app.inject({ method: "GET", url: "/api/projects/foreign/memory", headers })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: `/api/projects/${id}/memory/import`, headers, payload: { conversationIds: ["websocket:a"], spaceIds: ["foreign"] } })).statusCode).toBe(400);
    expect(service.importSessions).not.toHaveBeenCalled();
  });
});
