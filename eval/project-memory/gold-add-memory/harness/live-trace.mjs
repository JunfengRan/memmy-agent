// Eval-only trace writer. Opens the server sqlite read-only. Never writes it.
import { appendFileSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync, backup } from "node:sqlite";
import { diffTables, exportSpace, readTaskProgress } from "./store-diff.mjs";

export function createLiveTrace({ dbPath, traceDir, proxyBase, warn }) {
  if (!dbPath) return null;
  mkdirSync(join(traceDir, "db"), { recursive: true });
  const previous = new Map();
  const note = (message) => warn?.(message);

  async function context(body) {
    if (!proxyBase) return;
    try {
      const response = await fetch(`${proxyBase.replace(/\/+$/, "")}/__eval/context`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
      if (!response.ok) note(`eval context HTTP ${response.status}`);
    } catch (error) {
      note(`eval context: ${error.message ?? error}`);
    }
  }

  function openRead() {
    return new DatabaseSync(dbPath, { readOnly: true });
  }

  function noteSnapshot(record) {
    appendFileSync(join(traceDir, "snapshots.jsonl"), `${JSON.stringify(record)}\n`);
    return record;
  }

  async function beforeQuestion(questionId) {
    const dest = join(traceDir, "db", `before-${questionId}.sqlite`);
    mkdirSync(dirname(dest), { recursive: true });
    const db = openRead();
    try {
      await backup(db, dest);
      return noteSnapshot({ questionId, path: dest, method: "backup" });
    } catch (error) {
      note(`sqlite backup ${questionId}: ${error.message ?? error}`);
    } finally {
      db.close();
    }
    copyFileSync(dbPath, dest);
    for (const suffix of ["-wal", "-shm"]) {
      if (existsSync(dbPath + suffix)) copyFileSync(dbPath + suffix, dest + suffix);
    }
    return noteSnapshot({ questionId, path: dest, method: "copy" });
  }

  function afterAdd({ trace, taskId, datasetSpaceId, serverSpaceId, messages }) {
    const db = openRead();
    try {
      const tables = exportSpace(db, serverSpaceId);
      const progress = readTaskProgress(db, taskId);
      const diff = diffTables(previous.get(serverSpaceId) ?? {}, tables);
      previous.set(serverSpaceId, tables);
      const line = {
        at: new Date().toISOString(),
        trace,
        task_id: taskId,
        datasetSpaceId,
        serverSpaceId,
        messages,
        progress,
        diff
      };
      appendFileSync(join(traceDir, "add-steps.jsonl"), `${JSON.stringify(line)}\n`);
      return line;
    } finally {
      db.close();
    }
  }

  function reader(record) {
    appendFileSync(join(traceDir, "reader-calls.jsonl"), `${JSON.stringify(record)}\n`);
  }

  return { context, beforeQuestion, afterAdd, reader, traceDir };
}
