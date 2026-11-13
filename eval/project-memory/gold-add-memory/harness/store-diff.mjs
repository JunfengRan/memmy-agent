// Read-only export of one space from a project-memory sqlite, and a row diff between two exports.
// Used by the live eval tracer. It never writes the server database.

export const TABLE_KEYS = {
  pm_topics: ["id"],
  pm_decisions: ["id"],
  pm_decision_history: ["decision_id", "seq"],
  pm_decision_conflicts: ["decision_id", "seq"],
  pm_experiences: ["id"],
  pm_experience_history: ["experience_id", "seq"],
  pm_timeline: ["id"],
  pm_deferred_segments: ["id"]
};

const TOPIC_COLUMNS = "id, space_id, domain, topic_name, topic_summary, topic_description, revision, domain_seq, create_time, update_time";
const DECISION_COLUMNS = "id, topic_id, content, time, user_ids_json";
const HISTORY_COLUMNS = "decision_id, seq, content, time, user_ids_json, reason, recorded_at";
const CONFLICT_COLUMNS = "decision_id, seq, content, time, user_ids_json";
const EXPERIENCE_COLUMNS = "id, topic_id, content, time, user_ids_json";
const EXPERIENCE_HISTORY_COLUMNS = "experience_id, seq, content, time, user_ids_json, reason, recorded_at";
const TIMELINE_COLUMNS = "id, topic_id, content, time, user_ids_json, fingerprint";
const DEFERRED_COLUMNS = "id, conversation_id, space_id, task_id, segment, reason, created_at";

function byTopic(table, columns) {
  return `SELECT ${columns} FROM ${table} WHERE topic_id IN (SELECT id FROM pm_topics WHERE space_id = ?) ORDER BY 1, 2`;
}

const QUERIES = {
  pm_topics: `SELECT ${TOPIC_COLUMNS} FROM pm_topics WHERE space_id = ? ORDER BY id`,
  pm_decisions: byTopic("pm_decisions", DECISION_COLUMNS),
  pm_decision_history: `SELECT ${HISTORY_COLUMNS} FROM pm_decision_history WHERE decision_id IN (SELECT id FROM pm_decisions WHERE topic_id IN (SELECT id FROM pm_topics WHERE space_id = ?)) ORDER BY decision_id, seq`,
  pm_decision_conflicts: `SELECT ${CONFLICT_COLUMNS} FROM pm_decision_conflicts WHERE decision_id IN (SELECT id FROM pm_decisions WHERE topic_id IN (SELECT id FROM pm_topics WHERE space_id = ?)) ORDER BY decision_id, seq`,
  pm_experiences: byTopic("pm_experiences", EXPERIENCE_COLUMNS),
  pm_experience_history: `SELECT ${EXPERIENCE_HISTORY_COLUMNS} FROM pm_experience_history WHERE experience_id IN (SELECT id FROM pm_experiences WHERE topic_id IN (SELECT id FROM pm_topics WHERE space_id = ?)) ORDER BY experience_id, seq`,
  pm_timeline: byTopic("pm_timeline", TIMELINE_COLUMNS),
  pm_deferred_segments: `SELECT ${DEFERRED_COLUMNS} FROM pm_deferred_segments WHERE space_id = ? ORDER BY id`
};

export function rowKey(table, row) {
  const keys = TABLE_KEYS[table];
  if (!keys) throw new Error(`unknown table ${table}`);
  return keys.map((key) => String(row[key])).join("\0");
}

export function diffTables(before, after) {
  const names = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])].sort();
  const diff = {};
  for (const table of names) {
    const prev = new Map((before?.[table] ?? []).map((row) => [rowKey(table, row), row]));
    const next = new Map((after?.[table] ?? []).map((row) => [rowKey(table, row), row]));
    const added = [];
    const updated = [];
    const deleted = [];
    for (const [key, row] of next) {
      const prior = prev.get(key);
      if (!prior) added.push(row);
      else if (JSON.stringify(prior) !== JSON.stringify(row)) updated.push({ before: prior, after: row });
    }
    for (const [key, row] of prev) if (!next.has(key)) deleted.push(row);
    if (added.length || updated.length || deleted.length) diff[table] = { added, updated, deleted };
  }
  return diff;
}

export function exportSpace(db, serverSpaceId) {
  const tables = {};
  for (const [table, sql] of Object.entries(QUERIES)) {
    tables[table] = db.prepare(sql).all(serverSpaceId);
  }
  return tables;
}

export function readTaskProgress(db, taskId) {
  const row = db.prepare("SELECT progress_json FROM pm_tasks WHERE task_id = ?").get(taskId);
  if (!row?.progress_json) return null;
  try { return JSON.parse(row.progress_json); } catch { return { raw: row.progress_json }; }
}
