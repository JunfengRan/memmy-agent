import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface GitSnapshot {
  head: string | null;
  branch: string | null;
  dirty: boolean;
}

const cache = new Map<string, { at: number; value: GitSnapshot }>();
const EMPTY: GitSnapshot = { head: null, branch: null, dirty: false };

export function readGitSnapshot(root: string | null | undefined, now = Date.now()): GitSnapshot {
  if (!root || !existsSync(join(root, ".git"))) return EMPTY;
  const cached = cache.get(root);
  if (cached && now - cached.at < 5_000) return cached.value;
  const value = {
    head: git(root, ["rev-parse", "HEAD"]),
    branch: git(root, ["branch", "--show-current"]),
    dirty: Boolean(git(root, ["status", "--porcelain"]))
  };
  cache.set(root, { at: now, value });
  return value;
}

export function clearGitSnapshotCache(): void {
  cache.clear();
}

function git(root: string, args: string[]): string | null {
  try {
    const output = execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      timeout: 2_000,
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    return output || null;
  } catch {
    return null;
  }
}
