/** Host-only error adapter. Renderers and copy are generated from Memory. */
export * from "./project-render.js";
export * from "./project-prompts.js";
import { renderToolResult } from "./project-render.js";

/** Tool HTTP errors only. A normal search body is not an error. */
export function renderDomainInvalidError(error: unknown): string | null {
  const body = error && typeof error === "object" && "body" in error
    ? (error as { body?: unknown }).body
    : null;
  if (!body || typeof body !== "object") return null;
  const root = body as Record<string, unknown>;
  if (root.message !== "DOMAIN_INVALID" && root.code !== 40002) return null;
  return renderToolResult(body);
}
