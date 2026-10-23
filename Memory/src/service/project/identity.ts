import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sha256Hex } from "../../contracts/memory-canonical-json.js";
import {
  normalizeWorkspaceUri,
  type WorkspaceHostId,
  type WorkspaceUri
} from "../../contracts/memory-workspace-identity.js";

export interface ProjectRoot {
  rootPath: string;
  kind: "git" | "directory";
  workspaceUri: WorkspaceUri;
}

export interface ProjectIdentity {
  workspaceUri: WorkspaceUri | null;
  workspaceHostId: WorkspaceHostId | null;
  workspaceId: string | null;
  projectId: string | null;
  rootPath: string | null;
  kind: ProjectRoot["kind"] | null;
}

export function pathFromWorkspaceUri(workspaceUri: string | null | undefined): string | null {
  if (!workspaceUri?.startsWith("file:")) return null;
  try {
    return fileURLToPath(workspaceUri);
  } catch {
    return null;
  }
}

export function fileWorkspaceUri(path: string): WorkspaceUri {
  return normalizeWorkspaceUri(pathToFileURL(path).href) as WorkspaceUri;
}

/**
 * realpath, then the nearest directory that contains `.git`.
 * A worktree stops at its own `.git` file. A missing path returns null.
 */
export function resolveProjectRoot(start: string): ProjectRoot | null {
  if (!start.trim()) return null;
  const absolute = isAbsolute(start) ? start : resolve(start);
  let real: string;
  try {
    real = realpathSync(absolute);
  } catch {
    return null;
  }
  let current = real;
  while (true) {
    if (existsSync(join(current, ".git"))) {
      return { rootPath: current, kind: "git", workspaceUri: fileWorkspaceUri(current) };
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return { rootPath: real, kind: "directory", workspaceUri: fileWorkspaceUri(real) };
}

export function projectIdentityForLocation(
  userId: string,
  workspaceHostId: WorkspaceHostId,
  location: string
): ProjectIdentity | null {
  const root = resolveProjectRoot(location);
  if (!root) return null;
  const workspaceId = sha256Hex(`${userId}\0local\0${workspaceHostId}\0${root.workspaceUri}`);
  return {
    workspaceUri: root.workspaceUri,
    workspaceHostId,
    workspaceId,
    projectId: `ws_${workspaceId}`,
    rootPath: root.rootPath,
    kind: root.kind
  };
}

/** Rewrite a file URI to the project root when that path exists. Other URIs stay as given. */
export function canonicalFileWorkspace(workspaceUri: string | null | undefined): ProjectRoot | null {
  const path = pathFromWorkspaceUri(workspaceUri);
  if (!path) return null;
  return resolveProjectRoot(path);
}
