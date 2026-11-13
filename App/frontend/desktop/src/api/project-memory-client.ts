import { ProjectMemoryViewSchema, ProjectMemoryTopicSchema, ProjectMemorySessionSchema, type RuntimeConfig } from "@memmy/local-api-contracts";
import { z } from "zod";
import { requestJson } from "./http.js";
export function createProjectMemoryClient(config: RuntimeConfig, projectId: string) {
  const path = `/api/projects/${encodeURIComponent(projectId)}/memory`;
  const topicsSchema = z.object({ topic_detail_list: z.array(ProjectMemoryTopicSchema), total: z.number() });
  return {
    view: () => requestJson({ config, path, schema: ProjectMemoryViewSchema }),
    configure: (enabled: boolean) => requestJson({ config, path, schema: ProjectMemoryViewSchema, init: { method: "PUT" }, body: { enabled } }),
    topics: (page: number) => requestJson({ config, path: `${path}/topics?page=${page}`, schema: topicsSchema }),
    topic: (id: string) => requestJson({ config, path: `${path}/topics/${encodeURIComponent(id)}`, schema: z.object({ topic_detail_list: z.array(ProjectMemoryTopicSchema) }) }),
    sessions: () => requestJson({ config, path: `${path}/sessions`, schema: z.object({ sessions: z.array(ProjectMemorySessionSchema) }) }),
    importSessions: (conversationIds: string[]) => requestJson({ config, path: `${path}/import`, schema: ProjectMemoryViewSchema, body: { conversationIds } }),
    retry: () => requestJson({ config, path: `${path}/retry`, schema: ProjectMemoryViewSchema, body: {} })
  };
}
