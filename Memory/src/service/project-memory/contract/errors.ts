/** v3 §5.1.5: one error code table shared by both storage modes. */
export const PROJECT_MEMORY_ERRORS = {
  OK: 0,
  INVALID_PARAMS: 40001,
  DOMAIN_INVALID: 40002,
  DOMAIN_NOT_CONFIGURED: 40003,
  MODE_UNSUPPORTED: 40004,
  FIELD_LIMIT_EXCEEDED: 40005,
  STRUCTURE_VIOLATION: 40006,
  DOMAIN_LIMIT_EXCEEDED: 40007,
  DOMAIN_CONFLICT: 40008,
  LOCAL_CONFIG_REQUIRED: 40009,
  SPACE_NOT_FOUND: 40401,
  TOPIC_NOT_FOUND: 40402,
  TASK_NOT_FOUND: 40403,
  VERSION_CONFLICT: 40901,
  TOPIC_SET_CHANGED: 40902,
  DOMAIN_IN_USE: 40903,
  SPACE_GONE: 41001,
  SPACE_CLEARED: 41002,
  RATE_LIMITED: 42901,
  STORE_UNAVAILABLE: 50001,
  LOCAL_UNAVAILABLE: 50301
} as const;

export type ProjectMemoryErrorName = keyof typeof PROJECT_MEMORY_ERRORS;

/** Task-level failure reasons that only appear in get/status `error.reason`. */
export type ProjectMemoryTaskFailureReason =
  | ProjectMemoryErrorName
  | "VERSION_CONFLICT_RETRY_EXHAUSTED"
  | "MODEL_CALL_FAILED"
  | "MODEL_NOT_CONFIGURED"
  | "UPLOAD_FAILED"
  | "INTERNAL";

export class ProjectMemoryError extends Error {
  readonly code: number;

  constructor(
    readonly errorName: ProjectMemoryErrorName,
    message?: string,
    readonly data: Record<string, unknown> = {}
  ) {
    super(message ?? errorName);
    this.name = "ProjectMemoryError";
    this.code = PROJECT_MEMORY_ERRORS[errorName];
  }

  /** HTTP status follows the code family (40001 → 400, 40401 → 404, ...). */
  get httpStatus(): number {
    return Math.floor(this.code / 100);
  }
}

export function invalidParams(message: string, data: Record<string, unknown> = {}): ProjectMemoryError {
  return new ProjectMemoryError("INVALID_PARAMS", message, data);
}
