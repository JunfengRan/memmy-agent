import type { MemoryRow } from "../../types.js";
import { assignTopic, buildTopicView } from "./topic.js";

export interface ProjectTopicText {
  id: string;
  text: string;
  agent?: string;
  time?: string;
}

export interface ProjectTopicRead {
  id: string;
  name: string;
  updatedAt: string;
  summary: string;
  description: string;
  decisions: ProjectTopicText[];
  experiences: ProjectTopicText[];
  events: ProjectTopicText[];
  conflicts: ProjectTopicText[];
  sourceSessionIds: string[];
  agents: string[];
  memoryIds: string[];
}

/** Groups stored project notes into the topic view the board renders. */
export function readProjectTopics(input: {
  notes: readonly MemoryRow[];
  activity: readonly MemoryRow[];
}): ProjectTopicRead[] {
  const groups = new Map<string, MemoryRow[]>();
  for (const note of input.notes) {
    const name = noteTopicName(note);
    if (!name) continue;
    const rows = groups.get(name) ?? [];
    rows.push(note);
    groups.set(name, rows);
  }
  const topics: ProjectTopicRead[] = [];
  for (const [name, notes] of groups) {
    const updatedAt = notes.map((note) => note.updatedAt).sort().at(-1) ?? notes[0]!.updatedAt;
    const decisions = fieldTexts(notes, "current_decision");
    const checkpoints = fieldTexts(notes, "checkpoint_summary");
    const experiences = fieldTexts(notes, "experience");
    const conflicts = fieldTexts(notes, "conflict");
    const summary = fieldTexts(notes, "summary")[0] || checkpoints[0] || firstLine(notes[0]?.memoryValue ?? "");
    const description = fieldTexts(notes, "description")[0]
      || notes.map((note) => note.memoryValue.trim()).filter(Boolean).join("\n");
    const namedActivity = input.activity.filter((row) => textValue(row.info.topic_name) === name);
    const view = buildTopicView({
      summary,
      description,
      decisions: decisions.map((text, index) => ({
        id: `${name}:decision:${index}`,
        text,
        agent: notes[index]?.agentId,
        time: notes[index]?.updatedAt
      })),
      experiences: experiences.map((text, index) => ({ id: `${name}:experience:${index}`, text })),
      events: [
        ...checkpoints.map((text, index) => ({ id: `${name}:checkpoint:${index}`, text })),
        ...namedActivity.map((row) => ({
          id: row.id,
          text: activityLine(row),
          agent: row.agentId,
          time: row.updatedAt
        }))
      ],
      conflicts: conflicts.map((text, index) => ({ id: `${name}:conflict:${index}`, text }))
    });
    const assigned = assignTopic({
      unitId: name,
      name,
      existing: topics.map((topic) => ({ id: topic.id, name: topic.name }))
    });
    topics.push({
      id: assigned.topicId,
      name,
      updatedAt,
      summary: stringField(view.summary),
      description: stringField(view.description),
      decisions: textItems(view.decisions),
      experiences: textItems(view.experiences),
      events: textItems(view.events),
      conflicts: textItems(view.conflicts),
      sourceSessionIds: unique(notes.map((note) => note.sessionId).filter((id): id is string => Boolean(id))),
      agents: unique([
        ...notes.map((note) => note.agentId),
        ...namedActivity.map((row) => row.agentId)
      ].filter((id): id is string => Boolean(id))),
      memoryIds: unique(notes.map((note) => note.id))
    });
  }
  topics.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.name.localeCompare(right.name));
  attachUnnamedActivity(topics, input.activity);
  return topics;
}

function attachUnnamedActivity(topics: ProjectTopicRead[], activity: readonly MemoryRow[]): void {
  const latest = topics[0];
  if (!latest) return;
  const unnamed = activity.filter((row) => !textValue(row.info.topic_name));
  if (unnamed.length === 0) return;
  const view = buildTopicView({
    summary: latest.summary,
    description: latest.description,
    decisions: latest.decisions,
    experiences: latest.experiences,
    events: [
      ...latest.events,
      ...unnamed.map((row) => ({
        id: row.id,
        text: activityLine(row),
        agent: row.agentId,
        time: row.updatedAt
      }))
    ],
    conflicts: latest.conflicts
  });
  latest.events = textItems(view.events);
  latest.sourceSessionIds = unique([
    ...latest.sourceSessionIds,
    ...unnamed.map((row) => row.sessionId).filter((id): id is string => Boolean(id))
  ]);
  latest.agents = unique([
    ...latest.agents,
    ...unnamed.map((row) => row.agentId).filter((id): id is string => Boolean(id))
  ]);
  latest.memoryIds = unique([...latest.memoryIds, ...unnamed.map((row) => row.id)]);
}

function noteTopicName(memory: MemoryRow): string {
  return textValue(memory.info.topic_name)
    || textValue(memory.info.current_decision)
    || textValue(memory.info.checkpoint_summary);
}

function fieldTexts(memories: readonly MemoryRow[], key: string): string[] {
  const values: string[] = [];
  for (const memory of memories) {
    const value = textValue(memory.info[key]);
    if (value && !values.includes(value)) values.push(value);
  }
  return values;
}

function textValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function firstLine(value: string): string {
  return value.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
}

function activityLine(memory: MemoryRow): string {
  return textValue(memory.info.summary) || firstLine(memory.memoryValue) || "更新了项目";
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function textItems(value: unknown): ProjectTopicText[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    const text = textValue(record.text);
    const id = textValue(record.id);
    if (!text || !id) return [];
    const agent = textValue(record.agent);
    const time = textValue(record.time);
    return [{ id, text, ...(agent ? { agent } : {}), ...(time ? { time } : {}) }];
  });
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
