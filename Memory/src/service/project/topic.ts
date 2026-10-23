export interface TopicCandidate {
  id: string;
  name: string;
  listId?: string;
}

const LIMITS = { decisions: 8, experiences: 5, events: 10, conflicts: 5 };

export function assignTopic(input: {
  unitId: string;
  name: string;
  listId?: string;
  existing: readonly TopicCandidate[];
  assigned?: Readonly<Record<string, string>>;
}): { topicId: string; created: boolean } {
  const previous = input.assigned?.[input.unitId];
  if (previous) return { topicId: previous, created: false };
  const byList = input.listId ? input.existing.find((topic) => topic.listId === input.listId) : undefined;
  if (byList) return { topicId: byList.id, created: false };
  const byName = input.existing.find((topic) => topic.name === input.name);
  if (byName) return { topicId: byName.id, created: false };
  return { topicId: `topic_${hashName(input.name)}`, created: true };
}

export function buildTopicView(input: {
  summary: string;
  description: string;
  decisions: readonly { id: string; text: string; agent?: string; time?: string }[];
  experiences: readonly { id: string; text: string }[];
  events: readonly { id: string; text: string }[];
  conflicts: readonly { id: string; text: string }[];
}): Record<string, unknown> {
  return {
    summary: input.summary.slice(0, 100),
    description: input.description.slice(0, 1500),
    decisions: input.decisions.slice(0, LIMITS.decisions).map((item) => ({ ...item, text: item.text.slice(0, 80) })),
    experiences: input.experiences.slice(0, LIMITS.experiences).map((item) => ({ ...item, text: item.text.slice(0, 80) })),
    events: input.events.slice(0, LIMITS.events).map((item) => ({ ...item, text: item.text.slice(0, 60) })),
    conflicts: input.conflicts.slice(0, LIMITS.conflicts).map((item) => ({ ...item, text: item.text.slice(0, 80) }))
  };
}

export function topicRowBytes(view: Record<string, unknown>): number {
  return Buffer.byteLength(JSON.stringify(view), "utf8");
}

function hashName(value: string): string {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) hash = ((hash << 5) + hash + value.charCodeAt(index)) | 0;
  return (hash >>> 0).toString(16);
}
