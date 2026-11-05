/** Field and request limits from v3 §5.1.5 (FIELD_LIMIT_EXCEEDED) and the SDK spec. */
export const PROJECT_MEMORY_LIMITS = {
  topicName: 20,
  topicSummary: 80,
  topicDescription: 400,
  decision: 100,
  timeline: 100,
  experience: 200,
  instructions: 10_000,
  spacesPerRequest: 20,
  groupUserIds: 20,
  domainsPerSpace: 20,
  domainsPerBatch: 20,
  memoryLimitDefault: 9,
  memoryLimitMax: 25,
  topicK: 10,
  entryK: 5,
  getMemorySizeDefault: 10,
  getMemorySizeMax: 50,
  commitAttempts: 3,
  modelAttempts: 2,
  contextTurns: 6
} as const;
