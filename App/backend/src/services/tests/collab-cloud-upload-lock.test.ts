import { describe, expect, it, vi } from "vitest";
import { createCollabCloudRequest } from "../collab-service.js";
describe("local project cloud upload lock", () => {
  it("blocks every cloud mutation before network access even with a signed-in account", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ code: 0, data: { projects: [] } }), { status: 200 }));
    const cloud = createCollabCloudRequest({ cloudBaseUrl: "https://cloud.test.invalid", getAccount: () => ({ accountId: "user", credential: "test" }), allowCloudWrites: false, fetcher });
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) await expect(cloud("/projects/p/sessions", { method, body: {} })).rejects.toThrow("本地");
    expect(fetcher).not.toHaveBeenCalled();
    await expect(cloud("/projects")).resolves.toEqual({ projects: [] });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
