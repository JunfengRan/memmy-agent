import type { DesktopProjectDirectorySelection } from "@memmy/desktop-interface";

export type ProjectDirectoryMode = "blank" | "existing";

/**
 * Picks a project folder with the desktop dialog. A browser on the local Vite dev server has no
 * dialog, so it asks for an absolute path instead; any other browser gets null.
 */
export function projectDirectoryPicker(
  mode: ProjectDirectoryMode,
  promptLabel: string
): (() => Promise<DesktopProjectDirectorySelection>) | null {
  if (typeof window === "undefined") return null;
  const bridge = window.memmy;
  if (bridge?.selectProjectDirectory && bridge.selectEmptyProjectDirectory) {
    return mode === "blank" ? () => bridge.selectEmptyProjectDirectory() : () => bridge.selectProjectDirectory();
  }
  if (bridge || !isLocalDevOrigin(window.location)) return null;
  return async () => {
    const path = window.prompt(promptLabel)?.trim() ?? "";
    return path ? { canceled: false, path } : { canceled: true };
  };
}

function isLocalDevOrigin(location: Location): boolean {
  return location.protocol === "http:" && (location.hostname === "127.0.0.1" || location.hostname === "localhost");
}
