import fs from "node:fs";
import path from "node:path";
import { WebuiProjectError } from "./projects.js";

const MAX_INSTRUCTION_LENGTH = 4_000;
const MAX_IDS = 64;
const MAX_ID_LENGTH = 200;
const MAX_CITATIONS = 200;
const MAX_SESSION_KEY_LENGTH = 200;

export interface ProjectBoardCitation {
  fromSessionKey: string;
  toSessionKey: string;
}

export interface ProjectBoardRecord {
  instruction: string;
  knowledgeBaseIds: string[];
  skillIds: string[];
  citations: ProjectBoardCitation[];
}

export const EMPTY_PROJECT_BOARD: ProjectBoardRecord = {
  instruction: "",
  knowledgeBaseIds: [],
  skillIds: [],
  citations: []
};

type StoredBoards = Record<string, ProjectBoardRecord>;

/** Local project board config, stored beside projects.json so the project registry stays strict. */
export class ProjectBoardStore {
  readonly filePath: string;
  private boards: StoredBoards = {};

  constructor(options: { filePath: string }) {
    this.filePath = path.resolve(options.filePath);
    this.load();
  }

  get(projectId: string): ProjectBoardRecord {
    return cloneBoard(this.boards[projectId] ?? EMPTY_PROJECT_BOARD);
  }

  save(projectId: string, input: unknown): ProjectBoardRecord {
    const board = parseBoard(input);
    this.boards[projectId] = board;
    this.persist();
    return cloneBoard(board);
  }

  private load(): void {
    if (!fs.existsSync(this.filePath)) {
      this.boards = {};
      return;
    }
    const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new WebuiProjectError("project_board_corrupt", 503);
    }
    const raw = parsed as Record<string, unknown>;
    if (Object.keys(raw).some((key) => key !== "boards") || !raw.boards || typeof raw.boards !== "object" || Array.isArray(raw.boards)) {
      throw new WebuiProjectError("project_board_corrupt", 503);
    }
    const boards: StoredBoards = {};
    for (const [projectId, value] of Object.entries(raw.boards as Record<string, unknown>)) {
      boards[projectId] = parseBoard(value);
    }
    this.boards = boards;
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ boards: this.boards }, null, 2));
    fs.renameSync(temporary, this.filePath);
  }
}

function parseBoard(value: unknown): ProjectBoardRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WebuiProjectError("project_request_invalid", 400);
  }
  const raw = value as Record<string, unknown>;
  const allowed = new Set(["instruction", "knowledgeBaseIds", "skillIds", "citations"]);
  if (Object.keys(raw).some((key) => !allowed.has(key))) {
    throw new WebuiProjectError("project_request_invalid", 400);
  }
  if (typeof raw.instruction !== "string" || raw.instruction.length > MAX_INSTRUCTION_LENGTH) {
    throw new WebuiProjectError("project_request_invalid", 400);
  }
  return {
    instruction: raw.instruction,
    knowledgeBaseIds: parseIds(raw.knowledgeBaseIds),
    skillIds: parseIds(raw.skillIds),
    citations: parseCitations(raw.citations)
  };
}

function parseIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_IDS) {
    throw new WebuiProjectError("project_request_invalid", 400);
  }
  return value.map((item) => {
    if (typeof item !== "string" || item.length < 1 || item.length > MAX_ID_LENGTH) {
      throw new WebuiProjectError("project_request_invalid", 400);
    }
    return item;
  });
}

function parseCitations(value: unknown): ProjectBoardCitation[] {
  if (!Array.isArray(value) || value.length > MAX_CITATIONS) {
    throw new WebuiProjectError("project_request_invalid", 400);
  }
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new WebuiProjectError("project_request_invalid", 400);
    }
    const raw = item as Record<string, unknown>;
    if (Object.keys(raw).some((key) => key !== "fromSessionKey" && key !== "toSessionKey")) {
      throw new WebuiProjectError("project_request_invalid", 400);
    }
    return {
      fromSessionKey: parseSessionKey(raw.fromSessionKey),
      toSessionKey: parseSessionKey(raw.toSessionKey)
    };
  });
}

function parseSessionKey(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > MAX_SESSION_KEY_LENGTH) {
    throw new WebuiProjectError("project_request_invalid", 400);
  }
  return value;
}

function cloneBoard(board: ProjectBoardRecord): ProjectBoardRecord {
  return {
    instruction: board.instruction,
    knowledgeBaseIds: [...board.knowledgeBaseIds],
    skillIds: [...board.skillIds],
    citations: board.citations.map((citation) => ({ ...citation }))
  };
}
