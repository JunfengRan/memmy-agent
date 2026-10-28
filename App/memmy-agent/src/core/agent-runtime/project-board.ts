import { AgentHook, type AgentHookContext, type SystemPromptBuildContext } from "./hook.js";

export const PROJECT_REFS_METADATA_KEY = "project_refs";

const MAX_REFS_PER_KIND = 16;
const MAX_REF_LENGTH = 200;

export type ProjectRefs = {
  knowledge: string[];
  skills: string[];
  sessions: string[];
};

export type ProjectInstructionResolver = (input: { projectId: string | null; workspace: string | null }) => string | null;

/** Adds the project's board instruction to the system prompt of every task bound to that project. */
export class ProjectBoardPromptHook extends AgentHook {
  private readonly projectBySession = new Map<string, string | null>();

  constructor(private readonly instructionFor: ProjectInstructionResolver) {
    super();
  }

  override async beforeBuildSystemPrompt(ctx: AgentHookContext): Promise<void> {
    if (!ctx.sessionKey) return;
    const projectId = ctx.spec?.hostProjectId;
    this.projectBySession.set(ctx.sessionKey, typeof projectId === "string" && projectId ? projectId : null);
  }

  override async sessionEnd(ctx: AgentHookContext): Promise<void> {
    if (ctx.sessionKey) this.projectBySession.delete(ctx.sessionKey);
  }

  override onBuildSystemPrompt(ctx: SystemPromptBuildContext): void {
    const projectId = ctx.sessionKey ? this.projectBySession.get(ctx.sessionKey) ?? null : null;
    let instruction: string | null;
    try {
      instruction = this.instructionFor({ projectId, workspace: ctx.workspace })?.trim() || null;
    } catch {
      instruction = null;
    }
    if (!instruction) return;
    ctx.upsertSection({
      id: "project-instruction",
      source: "project-board",
      content: [
        "# Project Instruction",
        "",
        "The user set this instruction for every task in the current project. Follow it unless the current request says otherwise.",
        "",
        instruction,
      ].join("\n"),
    });
  }
}

/** Validates the `project_refs` field of a WebUI message envelope. */
export function normalizeProjectRefs(value: unknown): ProjectRefs | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const refs: ProjectRefs = {
    knowledge: refList(raw.knowledge),
    skills: refList(raw.skills),
    sessions: refList(raw.sessions),
  };
  return refs.knowledge.length || refs.skills.length || refs.sessions.length ? refs : null;
}

/** Runtime-context lines naming the project references attached to one message. */
export function projectRefRuntimeLines(message: { metadata?: Record<string, any> | null } | null | undefined): string[] {
  const refs = normalizeProjectRefs(message?.metadata?.[PROJECT_REFS_METADATA_KEY]);
  if (!refs) return [];
  const lines: string[] = [];
  if (refs.knowledge.length) lines.push(`Project knowledge bases: ${refs.knowledge.join(", ")}`);
  if (refs.skills.length) lines.push(`Project skills: ${refs.skills.join(", ")}`);
  if (refs.sessions.length) lines.push(`Cited project sessions: ${refs.sessions.join(", ")}`);
  return lines;
}

function refList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") continue;
    const text = item.replace(/\s+/g, " ").trim().slice(0, MAX_REF_LENGTH);
    if (text) seen.add(text);
    if (seen.size >= MAX_REFS_PER_KIND) break;
  }
  return [...seen];
}
