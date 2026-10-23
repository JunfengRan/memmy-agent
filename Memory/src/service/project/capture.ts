export const CURSOR_TURN_INJECTION_LIMIT = 8000;

export function cursorTurnInjection(
  markdown: string | null | undefined,
  envValue: string | undefined
): { continue: true } | { additional_context: string } {
  if (envValue === "0") return { continue: true };
  const text = markdown?.trim() ?? "";
  if (!text) return { continue: true };
  return { additional_context: text.slice(0, CURSOR_TURN_INJECTION_LIMIT) };
}

export function projectCaptureSource(projectId: string): string {
  return `project:${projectId}`;
}
