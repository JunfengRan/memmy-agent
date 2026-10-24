import { realpathSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";

const PATCH_FILE = /^\*\*\* (?:Update|Add|Delete) File:\s+(.+?)\s*$/;
const PATH_TOOLS = new Set([
  "Edit",
  "Write",
  "MultiEdit",
  "apply_patch",
  "file_write",
  "write_file",
  "edit_file"
]);
export const MAX_CHANGED_FILES = 50;

export function changedFilesFromToolCalls(toolCalls: readonly unknown[], projectRoot?: string | null): string[] {
  const found: string[] = [];
  for (const call of toolCalls) {
    if (!call || typeof call !== "object") continue;
    const record = call as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name : "";
    const input = record.input ?? record.arguments ?? record.args;
    if (name === "apply_patch" || name.endsWith(".apply_patch")) {
      const patch = patchText(input);
      for (const line of patch.split(/\r?\n/)) {
        const match = PATCH_FILE.exec(line.trim());
        if (match?.[1]) found.push(stripQuotes(match[1]));
      }
    }
    if (PATH_TOOLS.has(name) || name === "apply_patch") {
      collectPaths(found, input);
    }
  }
  return boundChangedFiles(found, projectRoot);
}

export function boundChangedFiles(paths: readonly string[], projectRoot?: string | null): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of paths) {
    if (typeof raw !== "string") continue;
    const normalized = relativize(raw.trim(), projectRoot);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
    if (out.length >= MAX_CHANGED_FILES) break;
  }
  return out;
}

function collectPaths(found: string[], input: unknown): void {
  if (!input || typeof input !== "object") return;
  const record = input as Record<string, unknown>;
  for (const key of ["file_path", "path", "filePath"]) {
    if (typeof record[key] === "string") found.push(record[key]);
  }
  if (Array.isArray(record.edits)) {
    for (const edit of record.edits) collectPaths(found, edit);
  }
}

function patchText(input: unknown): string {
  if (typeof input === "string") return input;
  if (!input || typeof input !== "object") return "";
  const record = input as Record<string, unknown>;
  for (const key of ["patch", "input", "diff"]) {
    if (typeof record[key] === "string") return record[key];
  }
  return "";
}

function stripQuotes(value: string): string {
  return value.replace(/^["']|["']$/g, "").trim();
}

function relativize(path: string, projectRoot?: string | null): string | null {
  if (!path || path.includes("\0")) return null;
  if (projectRoot && isAbsolute(path)) {
    const rel = insideRoot(projectRoot, path) ?? insideRoot(projectRoot, realPath(path));
    return rel ? rel.split(sep).join("/") : null;
  }
  const portable = path.split(sep).join("/");
  if (portable.startsWith("../") || portable === "..") return null;
  return portable.replace(/^\.\//, "");
}

function insideRoot(projectRoot: string, path: string | null): string | null {
  if (!path) return null;
  const rel = relative(projectRoot, path);
  return !rel || rel.startsWith("..") || isAbsolute(rel) ? null : rel;
}

/** The project root is stored as a realpath; hosts send paths as typed, e.g. /var for /private/var. */
function realPath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}
