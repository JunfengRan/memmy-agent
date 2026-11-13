import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PROJECT_MEMORY_BINDINGS_FILE, ProjectMemoryBindingsSchema, type ProjectMemoryBindings } from "@memmy/local-api-contracts";
import { getConfigPath } from "../config/paths.js";

/** Desktop owns this file; the Agent always fails closed and never creates a binding. */
export function readProjectMemoryBindings(): ProjectMemoryBindings {
  try { return ProjectMemoryBindingsSchema.parse(JSON.parse(readFileSync(join(dirname(getConfigPath()), PROJECT_MEMORY_BINDINGS_FILE), "utf8"))); }
  catch { return { version: 1, projects: {} }; }
}
