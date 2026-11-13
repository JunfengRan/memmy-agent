import type { DesktopProjectMemoryService } from "../../../../services/project-memory-service.js";
import { ExternalProjectTurnSchema } from "../../../../services/project-memory-service.js";
/** Local project utilities: the managed folder a project without a chosen directory runs in, and project instructions. */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { withErrorEnvelope } from "../../../../services/error-envelope.js";
import { MAX_PROJECT_INSTRUCTIONS_CHARS } from "@memmy/local-api-contracts";
import type { ProjectDirectoryService } from "../../../../services/project-directory-service.js";
import type { ProjectInstructionsService } from "../../../../services/project-instructions-service.js";

export interface RegisterProjectRoutesOptions {
  /** 按名称创建项目时用的托管目录；未提供时只注册项目指令接口。 */
  projectDirectory?: ProjectDirectoryService;
  projectMemory?: DesktopProjectMemoryService;
  /** 本机项目的项目指令：只属于这台电脑上的文件夹，协作项目有自己的一套接口。 */
  projectInstructions?: ProjectInstructionsService;
  authenticateRuntimeToken: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
}

const PrepareDirectorySchema = z.object({
  name: z.string().trim().min(1, "请填写项目名称").max(60, "项目名称过长")
}).strict();
/** 目录是项目任务所在位置：绝对路径，且长度与各平台路径上限一致。 */
const DirectorySchema = z.string().trim().min(1).max(4_096).refine((value) => value.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(value), "项目目录需为绝对路径");
const ReadInstructionsSchema = z.object({ directory: DirectorySchema }).strict();
const SaveInstructionsSchema = z.object({
  directory: DirectorySchema,
  text: z.string().max(MAX_PROJECT_INSTRUCTIONS_CHARS * 4).default("")
}).strict();

/** Registers the local project routes. */
export function registerProjectRoutes(app: FastifyInstance, options: RegisterProjectRoutesOptions): void {
  if (options.projectMemory) {
    const service = options.projectMemory;
    const params = z.object({ projectId: z.string().uuid() });
    const prefix = "/api/projects/:projectId/memory";
    const auth = { preHandler: options.authenticateRuntimeToken };
    app.post("/api/project-memory/recall", auth, withErrorEnvelope(async request => {
      const input = z.object({ workspace: DirectorySchema, query: z.string().trim().min(1).max(100_000), conversationId: z.string().min(1).max(512).optional(), recallVia: z.enum(["turn_start", "tool"]).default("turn_start"), domains: z.array(z.string().trim().min(1).max(100)).min(1).max(20).optional(), memoryLimit: z.number().int().min(1).max(100).default(5) }).strict().parse(request.body);
      return service.recallWorkspace(input.workspace, input.query, input.conversationId, input.recallVia, input.domains, input.memoryLimit);
    }));
    app.post("/api/project-memory/capture", auth, withErrorEnvelope(async request => {
      const input = z.object({ workspace: DirectorySchema, turn: ExternalProjectTurnSchema }).strict().parse(request.body);
      return service.captureWorkspace(input.workspace, input.turn);
    }));
    app.get(prefix, auth, withErrorEnvelope(async request => service.view(params.parse(request.params).projectId)));
    app.put(prefix, auth, withErrorEnvelope(async request => service.configure(params.parse(request.params).projectId, z.object({ enabled: z.boolean() }).strict().parse(request.body).enabled)));
    app.get(`${prefix}/topics`, auth, withErrorEnvelope(async request => service.listTopics(params.parse(request.params).projectId, z.object({ page: z.coerce.number().int().min(1).default(1) }).parse(request.query).page)));
    app.get(`${prefix}/topics/:topicId`, auth, withErrorEnvelope(async request => { const input = params.extend({ topicId: z.string().regex(/^[A-Za-z0-9_-]+$/) }).parse(request.params); return service.topic(input.projectId, input.topicId); }));
    app.get(`${prefix}/sessions`, auth, withErrorEnvelope(async request => service.listSessions(params.parse(request.params).projectId)));
    app.post(`${prefix}/import`, auth, withErrorEnvelope(async request => service.importSessions(params.parse(request.params).projectId, z.object({ conversationIds: z.array(z.string().min(1)).min(1).max(100) }).strict().parse(request.body).conversationIds)));
    app.post(`${prefix}/retry`, auth, withErrorEnvelope(async request => service.retry(params.parse(request.params).projectId)));
  }
  // A project created by name alone still needs a working directory: this is where it gets one.
  if (options.projectDirectory) {
    app.post("/api/projects/working-directory", { preHandler: options.authenticateRuntimeToken }, withErrorEnvelope(async (request, reply) => {
      const input = PrepareDirectorySchema.parse(request.body ?? {});
      return reply.send(await options.projectDirectory!.prepareManagedDirectory(input.name));
    }));
  }

  if (!options.projectInstructions) return;
  // 看板打开项目配置时读当前生效的指令；协作项目的指令由云端同步到同一份存储。
  app.get("/api/projects/instructions", { preHandler: options.authenticateRuntimeToken }, withErrorEnvelope(async (request, reply) => {
    const input = ReadInstructionsSchema.parse(request.query ?? {});
    return reply.send(await options.projectInstructions!.read(input.directory));
  }));
  // 只有本机项目在这里保存；协作项目走云端的项目接口，再由后端同步到本机。
  app.put("/api/projects/instructions", { preHandler: options.authenticateRuntimeToken }, withErrorEnvelope(async (request, reply) => {
    const input = SaveInstructionsSchema.parse(request.body ?? {});
    if ([...input.text.trim()].length > MAX_PROJECT_INSTRUCTIONS_CHARS) {
      return reply.status(400).send({ error: { code: "invalid_argument", message: `背景与规范不超过 ${MAX_PROJECT_INSTRUCTIONS_CHARS} 字` } });
    }
    return reply.send(await options.projectInstructions!.saveLocal(input.directory, input.text));
  }));
}
