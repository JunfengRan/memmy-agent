import type Database from "better-sqlite3";
import type { WorkspaceHostId } from "../../contracts/index.js";
import { fileWorkspaceUri, pathFromWorkspaceUri, projectIdentityForLocation } from "./identity.js";

export interface MergeSubdirsMove {
  fromProjectId: string;
  toProjectId: string;
  rootPath: string;
  sessions: number;
  episodes: number;
  memories: number;
  scopes: number;
}

export interface MergeSubdirsReport {
  dryRun: boolean;
  moves: MergeSubdirsMove[];
}

export function mergeSubdirProjects(
  db: Database.Database,
  input: { userId: string; workspaceHostId: WorkspaceHostId; dryRun?: boolean }
): MergeSubdirsReport {
  const dryRun = input.dryRun !== false;
  const sessions = db.prepare(
    `SELECT id, project_id AS projectId, workspace_path AS workspacePath, meta_json AS metaJson
     FROM sessions WHERE user_id = ?`
  ).all(input.userId) as Array<{ id: string; projectId: string | null; workspacePath: string | null; metaJson: string }>;
  const grouped = new Map<string, { toProjectId: string; toWorkspaceId: string; rootPath: string; sessionIds: string[] }>();
  for (const session of sessions) {
    const location = sessionLocation(session);
    if (!location || !session.projectId) continue;
    const identity = projectIdentityForLocation(input.userId, input.workspaceHostId, location);
    if (!identity?.projectId || !identity.workspaceId || !identity.rootPath || identity.projectId === session.projectId) continue;
    const key = `${session.projectId}\0${identity.projectId}`;
    const group = grouped.get(key) ?? {
      toProjectId: identity.projectId,
      toWorkspaceId: identity.workspaceId,
      rootPath: identity.rootPath,
      sessionIds: []
    };
    group.sessionIds.push(session.id);
    grouped.set(key, group);
  }

  const moves: MergeSubdirsMove[] = [];
  const apply = () => {
    for (const [key, group] of grouped) {
      const fromProjectId = key.split("\0")[0]!;
      const sessionsCount = group.sessionIds.length;
      const episodes = count(db, "SELECT COUNT(*) AS n FROM episodes WHERE user_id = ? AND project_id = ?", input.userId, fromProjectId);
      const memories = count(db, `SELECT COUNT(*) AS n FROM memories WHERE user_id = ? AND json_extract(info_json, '$.project_id') = ?`, input.userId, fromProjectId);
      const scopes = count(db, "SELECT COUNT(*) AS n FROM l3_world_model_scopes WHERE user_id = ? AND project_id = ?", input.userId, fromProjectId);
      moves.push({
        fromProjectId,
        toProjectId: group.toProjectId,
        rootPath: group.rootPath,
        sessions: sessionsCount,
        episodes,
        memories,
        scopes
      });
      if (dryRun) continue;
      const sessionPlaceholders = group.sessionIds.map(() => "?").join(", ");
      db.prepare(
        `UPDATE sessions
         SET project_id = ?, workspace_id = ?, workspace_path = ?, updated_at = ?
         WHERE id IN (${sessionPlaceholders})`
      ).run(group.toProjectId, group.toWorkspaceId, group.rootPath, new Date().toISOString(), ...group.sessionIds);
      db.prepare(
        `UPDATE episodes SET project_id = ? WHERE user_id = ? AND project_id = ?`
      ).run(group.toProjectId, input.userId, fromProjectId);
      db.prepare(
        `UPDATE memories
         SET info_json = json_set(info_json, '$.project_id', ?, '$.memory_scope', 'project'),
             properties_json = json_set(properties_json, '$.info.project_id', ?, '$.info.memory_scope', 'project')
         WHERE user_id = ? AND json_extract(info_json, '$.project_id') = ?`
      ).run(group.toProjectId, group.toProjectId, input.userId, fromProjectId);
      const destination = db.prepare(
        `SELECT scope_key FROM l3_world_model_scopes WHERE user_id = ? AND project_id = ?`
      ).get(input.userId, group.toProjectId);
      if (destination) {
        db.prepare(
          `DELETE FROM l3_world_model_scopes WHERE user_id = ? AND project_id = ?`
        ).run(input.userId, fromProjectId);
      } else {
        db.prepare(
          `UPDATE l3_world_model_scopes
           SET project_id = ?, workspace_uri = ?, updated_at = ?
           WHERE user_id = ? AND project_id = ?`
        ).run(group.toProjectId, fileWorkspaceUri(group.rootPath), new Date().toISOString(), input.userId, fromProjectId);
      }
    }
  };
  if (dryRun) apply();
  else db.transaction(apply)();
  return { dryRun, moves };
}

function sessionLocation(session: { workspacePath: string | null; metaJson: string }): string | null {
  if (session.workspacePath) return session.workspacePath;
  try {
    const meta = JSON.parse(session.metaJson) as { workspace_uri?: unknown };
    return typeof meta.workspace_uri === "string" ? pathFromWorkspaceUri(meta.workspace_uri) : null;
  } catch {
    return null;
  }
}

function count(db: Database.Database, sql: string, ...params: string[]): number {
  return (db.prepare(sql).get(...params) as { n: number }).n;
}
