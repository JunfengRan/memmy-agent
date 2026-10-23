import { deriveWorkspaceHostId, type WorkspaceHostId } from "../../contracts/memory-workspace-identity.js";
import { getOrCreateInstallationId } from "../../cli/analytics.js";

const FALLBACK_INSTALLATION_ID = "memmy-project-memory-local";

/** Host id shared by hook and scan on this machine. Falls back if the home directory is not writable. */
export function defaultWorkspaceHostId(): WorkspaceHostId {
  try {
    return deriveWorkspaceHostId(getOrCreateInstallationId());
  } catch {
    return deriveWorkspaceHostId(FALLBACK_INSTALLATION_ID);
  }
}
