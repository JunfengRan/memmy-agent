import { z } from "zod";

export const PROJECT_MEMORY_BINDINGS_FILE = "project-memory-bindings.json";
export const ProjectMemoryBindingSchema = z.object({
  spaceId: z.string().min(1), enabled: z.boolean(), enabledAt: z.string().datetime(),
  projectName: z.string(), directory: z.string(), instructions: z.string().default("")
});
export const ProjectMemoryBindingsSchema = z.object({ version: z.literal(1), projects: z.record(z.string(), ProjectMemoryBindingSchema) });
export type ProjectMemoryBinding = z.infer<typeof ProjectMemoryBindingSchema>;
export type ProjectMemoryBindings = z.infer<typeof ProjectMemoryBindingsSchema>;
const AuthoredSchema = z.object({ content: z.string(), time: z.string(), user_ids: z.array(z.string()).default([]) }).passthrough();
const EntrySchema = AuthoredSchema.extend({ id: z.string().optional(), history: z.array(AuthoredSchema).default([]), conflicts: z.array(AuthoredSchema).default([]) }).passthrough();
export const ProjectMemoryTopicSchema = z.object({
  id: z.string(), space_id: z.string(), domain: z.string(), topic_name: z.string(), topic_summary: z.string(),
  topic_description: z.string(), decisions: z.array(EntrySchema), experiences: z.array(EntrySchema), timeline: z.array(AuthoredSchema),
  sources: z.array(z.object({ conversation_id: z.string().nullable(), user_id: z.union([z.string(), z.array(z.string())]).optional(), agent_id: z.string().nullable().optional() }).passthrough()).default([]),
  update_time: z.string().optional()
}).passthrough();
export type ProjectMemoryTopic = z.infer<typeof ProjectMemoryTopicSchema>;
export const ProjectMemoryJobSchema = z.object({
  id: z.string(), conversationId: z.string(), title: z.string(), taskId: z.string().nullable(),
  status: z.enum(["pending", "running", "completed", "failed"]), error: z.string().nullable()
});
export const ProjectMemoryViewSchema = z.object({ binding: ProjectMemoryBindingSchema.nullable(), jobs: z.array(ProjectMemoryJobSchema), error: z.string().nullable() });
export type ProjectMemoryView = z.infer<typeof ProjectMemoryViewSchema>;
export const ProjectMemorySessionSchema = z.object({ conversationId: z.string(), title: z.string(), turnCount: z.number(), updatedAt: z.string() });
