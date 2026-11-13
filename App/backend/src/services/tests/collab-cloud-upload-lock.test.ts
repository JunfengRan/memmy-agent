import { createCollabAssistService } from "../collab-assist-service.js";
import { describe, expect, it, vi } from "vitest";
import { createCollabCloudRequest, createCollabService } from "../collab-service.js";
describe("local project cloud upload lock", () => {
  it("shares the locked transport between project creation and member assistance", async () => {
    const fetcher = vi.fn();
    const options = { cloudBaseUrl: "https://cloud.test.invalid", getAccount: () => ({ accountId: "user", credential: "test" }), allowCloudWrites: false, fetcher };
    const cloud = createCollabCloudRequest(options);
    const projects = createCollabService({ ...options, cloudRequest: cloud, localSessions: null });
    const assist = createCollabAssistService({ cloud, userMode: () => "account", projectDirectory: async () => null, agents: async () => [], runner: { run: vi.fn() } });
    await expect(projects.createProject("local project")).rejects.toThrow("本地");
    await expect(assist.createRequest({ project: "project-123", member: "member", title: "private question", items: ["private dialogue"] })).rejects.toThrow("本地");
    for (const suffix of ["progress", "execution", "reply"]) await expect(cloud(`/projects/project-123/assist/request/${suffix}`, { method: "POST", body: { promptContext: "private dialogue" } })).rejects.toThrow("本地");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("blocks every cloud mutation before network access even with a signed-in account", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ code: 0, data: { projects: [] } }), { status: 200 }));
    const cloud = createCollabCloudRequest({ cloudBaseUrl: "https://cloud.test.invalid", getAccount: () => ({ accountId: "user", credential: "test" }), allowCloudWrites: false, fetcher });
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) await expect(cloud("/projects/p/sessions", { method, body: {} })).rejects.toThrow("本地");
    expect(fetcher).not.toHaveBeenCalled();
    await expect(cloud("/projects")).resolves.toEqual({ projects: [] });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
