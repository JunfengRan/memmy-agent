/**
 * Codex's own Cursor import writes a normal rollout at the import time.
 * The rollout has no import marker. Memmy's Codex scanner reads that file
 * and captures it again.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCodexSourceAdapter } from "../src/agent-source/adapters/codex/index.js";
import { createCursorSourceAdapter } from "../src/agent-source/adapters/cursor/index.js";
import { createSourceRegistry } from "../src/agent-source/adapters/source-registry.js";
import { createAgentSourceExecutor } from "../src/agent-source/runtime.js";
import { DEFAULT_MEMMY_CONFIG, type MemoryDb } from "../src/index.js";
import { memoryCaptureQaHash } from "../src/utils/memory-capture-claim.js";
import {
  createBatchReflectionLlm,
  createMemoryServiceFixture,
  runWorkerRounds
} from "./fixtures/memory-service-fixture.js";

const fixture = createMemoryServiceFixture();
afterEach(() => {
  vi.restoreAllMocks();
  fixture.cleanup();
});

const USER_ID = "recapture-owner";
const QUERY = "我喜欢吃甜食";
const ANSWER = "好的，我会记住你喜欢甜食。";
const CURSOR_AT = "2020-06-01T09:04:35.000Z";
const WATERMARK_AT = "2098-01-01T00:00:00.000Z";
const IMPORT_AT = "2099-06-01T08:00:00.000Z";
const IMPORTED_SESSION = "imported-thread-1";

describe("Codex imports a Cursor chat into a new session", () => {
  it("captures the imported session again when the extracted question and answer match", async () => {
    const calls: Array<{ messages: Array<{ role: string; content: string }>; options: { operation: string } }> = [];
    const { service, db, root } = fixture.createTestService({
      config: { ...DEFAULT_MEMMY_CONFIG, userId: USER_ID },
      llm: createBatchReflectionLlm(calls)
    });
    const history = createHistory(root);
    writeCursorDatabase(history.stateDbPath, QUERY, ANSWER, CURSOR_AT);
    writeImportLedger(history.ledgerPath, IMPORTED_SESSION);
    writeFileSync(
      join(history.sessionsRoot, "rollout-imported-same-text.jsonl"),
      importedRollout(IMPORTED_SESSION, [{
        turnId: "imported-turn-1",
        userTexts: [QUERY],
        answer: ANSWER
      }], IMPORT_AT)
    );
    const executor = openExecutor(service, root, history);
    try {
      await scan(executor, "cursor", "full");
      expect(activeL1Count(db)).toBe(1);

      await scan(executor, "codex", "full");
      expect(snapshot(db)).toMatchObject({
        l1: 2,
        claims: 0,
        traceSummaries: 2,
        captures: [
          { source: "codex", conversationId: IMPORTED_SESSION, turnId: "imported-turn-1" },
          { source: "cursor", conversationId: "cursor-composer-1", turnId: "cursor-user-1" }
        ]
      });
      const hashes = captureContentHashes(db);
      expect(hashes).toEqual([hashes[0], hashes[0]]);
      expect(qaHashes(db)).toEqual([
        memoryCaptureQaHash(QUERY, ANSWER),
        memoryCaptureQaHash(QUERY, ANSWER)
      ]);
      expect(decisionFlags(db)).toEqual([1, 1]);

      await scan(executor, "codex", "full");
      expect(activeL1Count(db)).toBe(2);
      expect(snapshot(db).traceSummaries).toBe(2);

      await runWorkerRounds(service, 6);
      const decisions = calls.filter((call) =>
        call.options.operation === "capture.summarize" &&
        call.messages.some((message) => message.content.includes("Judge L1 and User Memory"))
      );
      expect(decisions).toHaveLength(2);
      expect(traceSummaryErrors(db)).toEqual([]);
      expect(activeL1Count(db)).toBe(2);
    } finally {
      await executor.dispose();
    }
  });

  it("still captures an import whose timestamp is the import time, after an older Codex watermark", async () => {
    const { service, db, root } = fixture.createTestService({
      config: { ...DEFAULT_MEMMY_CONFIG, userId: USER_ID },
      llm: createBatchReflectionLlm([])
    });
    const history = createHistory(root);
    writeCursorDatabase(history.stateDbPath, QUERY, ANSWER, CURSOR_AT);
    writeFileSync(
      join(history.sessionsRoot, "rollout-watermark.jsonl"),
      importedRollout("codex-native-session", [{
        turnId: "codex-native-turn",
        userTexts: ["先记下一条更早的 Codex 会话。"],
        answer: "水位线停在这里。"
      }], WATERMARK_AT)
    );
    const executor = openExecutor(service, root, history);
    try {
      await scan(executor, "cursor", "full");
      await scan(executor, "codex", "incremental");
      expect(activeL1Count(db)).toBe(2);
      expect(watermark(root)).toBe(WATERMARK_AT);

      writeImportLedger(history.ledgerPath, IMPORTED_SESSION);
      writeFileSync(
        join(history.sessionsRoot, "rollout-imported-later.jsonl"),
        importedRollout(IMPORTED_SESSION, [{
          turnId: "imported-turn-1",
          userTexts: [QUERY],
          answer: ANSWER
        }], IMPORT_AT)
      );
      expect(Date.parse(IMPORT_AT)).toBeGreaterThan(Date.parse(WATERMARK_AT));
      expect(Date.parse(IMPORT_AT)).toBeGreaterThan(Date.parse(activationAt(db)));

      await scan(executor, "codex", "incremental");
      expect(activeL1Count(db)).toBe(3);
      expect(snapshot(db).captures.map((capture) => capture.turnId).sort()).toEqual([
        "codex-native-turn",
        "cursor-user-1",
        "imported-turn-1"
      ]);
      expect(snapshot(db).traceSummaries).toBe(3);
      expect(watermark(root)).toBe(IMPORT_AT);
    } finally {
      await executor.dispose();
    }
  });

  it("captures again when the imported user message also contains unlabeled extra text", async () => {
    const { service, db, root } = fixture.createTestService({
      config: { ...DEFAULT_MEMMY_CONFIG, userId: USER_ID },
      llm: createBatchReflectionLlm([])
    });
    const history = createHistory(root);
    writeCursorDatabase(history.stateDbPath, QUERY, ANSWER, CURSOR_AT);
    const extra = "以下是从 Cursor 复制的会话。";
    writeFileSync(
      join(history.sessionsRoot, "rollout-imported-extra.jsonl"),
      importedRollout(IMPORTED_SESSION, [{
        turnId: "imported-turn-1",
        userTexts: [extra, QUERY],
        answer: ANSWER
      }], IMPORT_AT)
    );
    const executor = openExecutor(service, root, history);
    try {
      await scan(executor, "cursor", "full");
      await scan(executor, "codex", "full");
      expect(activeL1Count(db)).toBe(2);
      expect(new Set(qaHashes(db)).size).toBe(2);
      expect(qaHashes(db)).toContain(memoryCaptureQaHash(QUERY, ANSWER));
      expect(qaHashes(db)).toContain(memoryCaptureQaHash(`${extra}\n${QUERY}`, ANSWER));
    } finally {
      await executor.dispose();
    }
  });

  it("stores one L1 per completed turn when one Cursor chat is imported as two Codex turns", async () => {
    const { service, db, root } = fixture.createTestService({
      config: { ...DEFAULT_MEMMY_CONFIG, userId: USER_ID },
      llm: createBatchReflectionLlm([])
    });
    const history = createHistory(root);
    writeCursorDatabase(history.stateDbPath, QUERY, ANSWER, CURSOR_AT);
    writeFileSync(
      join(history.sessionsRoot, "rollout-imported-two-turns.jsonl"),
      importedRollout(IMPORTED_SESSION, [
        { turnId: "imported-turn-1", userTexts: [QUERY], answer: ANSWER },
        { turnId: "imported-turn-2", userTexts: ["那甜食里我更喜欢蛋糕。"], answer: "好的，记下你更喜欢蛋糕。" }
      ], IMPORT_AT)
    );
    const executor = openExecutor(service, root, history);
    try {
      await scan(executor, "cursor", "full");
      await scan(executor, "codex", "full");
      expect(activeL1Count(db)).toBe(3);
      expect(snapshot(db).captures.map((capture) => `${capture.source}:${capture.turnId}`).sort()).toEqual([
        "codex:imported-turn-1",
        "codex:imported-turn-2",
        "cursor:cursor-user-1"
      ]);
      expect(snapshot(db).traceSummaries).toBe(3);
    } finally {
      await executor.dispose();
    }
  });
});

function createHistory(root: string): {
  storageRoot: string;
  stateDbPath: string;
  sessionsRoot: string;
  ledgerPath: string;
} {
  const storageRoot = join(root, "cursor", "workspaceStorage");
  const globalDir = join(root, "cursor", "globalStorage");
  const sessionsRoot = join(root, "codex", "sessions");
  mkdirSync(storageRoot, { recursive: true });
  mkdirSync(globalDir, { recursive: true });
  mkdirSync(sessionsRoot, { recursive: true });
  return {
    storageRoot,
    stateDbPath: join(globalDir, "state.vscdb"),
    sessionsRoot,
    ledgerPath: join(root, "codex", "external_agent_session_imports.json")
  };
}

function openExecutor(
  service: ReturnType<typeof fixture.createTestService>["service"],
  root: string,
  history: { storageRoot: string; stateDbPath: string; sessionsRoot: string }
) {
  return createAgentSourceExecutor({
    service,
    configPath: join(root, "config.yaml"),
    statePath: join(root, "agent-sources.json"),
    resolveAgentSkillRoot: () => null,
    sourceRegistry: createSourceRegistry([
      createCursorSourceAdapter({
        storageRoot: history.storageRoot,
        globalStateDbPath: history.stateDbPath
      }),
      createCodexSourceAdapter({ sessionsRoot: history.sessionsRoot })
    ])
  });
}

async function scan(
  executor: ReturnType<typeof createAgentSourceExecutor>,
  sourceId: "cursor" | "codex",
  mode: "full" | "incremental"
): Promise<void> {
  await executor.startScan({ sourceId, mode });
  await vi.waitFor(() => expect(executor.scanStatus().running).toBe(false), { timeout: 10_000 });
  expect(executor.scanStatus().error).toBeNull();
}

function writeImportLedger(ledgerPath: string, importedThreadId: string): void {
  writeFileSync(ledgerPath, JSON.stringify({
    records: [{
      source_path: "cursor-transcript.jsonl",
      content_sha256: "abc123",
      imported_thread_id: importedThreadId,
      imported_at: IMPORT_AT,
      title: QUERY
    }]
  }), "utf8");
}

function writeCursorDatabase(stateDbPath: string, query: string, answer: string, at: string): void {
  const bubbles = [
    { bubbleId: "cursor-user-1", type: 1, text: query, createdAt: at, requestId: "generation-1" },
    { bubbleId: "cursor-assistant-1", type: 2, text: answer, createdAt: at }
  ];
  const db = new Database(stateDbPath);
  try {
    db.exec("CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    db.exec("CREATE TABLE composerHeaders (composerId TEXT PRIMARY KEY, isSubagent INTEGER, subagentTypeName TEXT)");
    db.prepare("INSERT INTO composerHeaders (composerId, isSubagent, subagentTypeName) VALUES (?, ?, ?)").run("cursor-composer-1", 0, "");
    db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)").run(
      "composerData:cursor-composer-1",
      JSON.stringify({
        composerId: "cursor-composer-1",
        status: "completed",
        fullConversationHeadersOnly: bubbles.map((bubble) => ({
          bubbleId: bubble.bubbleId,
          type: bubble.type,
          createdAt: bubble.createdAt
        }))
      })
    );
    const insert = db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)");
    for (const bubble of bubbles) {
      insert.run(`bubbleId:cursor-composer-1:${bubble.bubbleId}`, JSON.stringify({ _v: 3, ...bubble }));
    }
  } finally {
    db.close();
  }
}

function importedRollout(
  sessionId: string,
  turns: Array<{ turnId: string; userTexts: string[]; answer: string }>,
  at: string
): string {
  const event = (type: string, payload: Record<string, unknown>) =>
    JSON.stringify({ type, timestamp: at, payload });
  const lines = [
    event("session_meta", {
      id: sessionId,
      session_id: sessionId,
      timestamp: at,
      cwd: "/tmp/workspace",
      originator: "Codex Desktop",
      source: "vscode",
      history_mode: "paginated"
    })
  ];
  for (const turn of turns) {
    lines.push(
      event("event_msg", { type: "task_started", turn_id: turn.turnId }),
      event("response_item", {
        type: "message",
        role: "user",
        content: turn.userTexts.map((text) => ({ text }))
      }),
      event("response_item", {
        type: "message",
        role: "assistant",
        content: [{ text: turn.answer }]
      }),
      event("event_msg", { type: "task_complete", turn_id: turn.turnId, status: "succeeded" })
    );
  }
  return lines.join("\n") + "\n";
}

function snapshot(db: MemoryDb): {
  l1: number;
  captures: Array<{ source: string; conversationId: string; turnId: string }>;
  traceSummaries: number;
  claims: number;
} {
  return {
    l1: activeL1Count(db),
    captures: db.db.prepare(
      `SELECT source, conversation_id AS conversationId, turn_id AS turnId
       FROM source_turn_captures
       ORDER BY source, conversation_id, turn_id`
    ).all() as Array<{ source: string; conversationId: string; turnId: string }>,
    traceSummaries: count(db, `SELECT COUNT(*) AS n FROM evolution_jobs WHERE job_type = 'trace_summary'`),
    claims: count(db, "SELECT COUNT(*) AS n FROM memory_capture_claims")
  };
}

function captureContentHashes(db: MemoryDb): string[] {
  return (db.db.prepare(
    `SELECT content_hash AS contentHash FROM source_turn_captures ORDER BY source`
  ).all() as Array<{ contentHash: string }>).map((row) => row.contentHash);
}

function qaHashes(db: MemoryDb): string[] {
  return (db.db.prepare(
    `SELECT user_text AS userText, assistant_text AS assistantText
     FROM raw_turns
     WHERE deleted_at IS NULL
     ORDER BY created_at, id`
  ).all() as Array<{ userText: string; assistantText: string }>)
    .map((row) => memoryCaptureQaHash(row.userText, row.assistantText));
}

function decisionFlags(db: MemoryDb): number[] {
  return (db.db.prepare(
    `SELECT json_extract(payload_json, '$.decideCapture') AS decideCapture
     FROM evolution_jobs
     WHERE job_type = 'trace_summary'
     ORDER BY created_at, id`
  ).all() as Array<{ decideCapture: number }>).map((row) => row.decideCapture);
}

function traceSummaryErrors(db: MemoryDb): string[] {
  return (db.db.prepare(
    `SELECT COALESCE(last_error, status) AS error
     FROM evolution_jobs
     WHERE job_type = 'trace_summary' AND status != 'succeeded'`
  ).all() as Array<{ error: string }>).map((row) => row.error);
}

function activeL1Count(db: MemoryDb): number {
  return count(db, `SELECT COUNT(*) AS n FROM memories WHERE memory_layer = 'L1' AND deleted_at IS NULL`);
}

function count(db: MemoryDb, sql: string): number {
  return (db.db.prepare(sql).get() as { n: number }).n;
}

function activationAt(db: MemoryDb): string {
  const row = db.db.prepare(
    `SELECT value_json AS value FROM runtime_kv WHERE key = 'source_turn_capture_activated_at'`
  ).get() as { value: string };
  return JSON.parse(row.value) as string;
}

function watermark(root: string): string {
  return JSON.parse(readFileSync(join(root, "agent-sources.json"), "utf8")).sources.codex.latestSeenAt as string;
}
