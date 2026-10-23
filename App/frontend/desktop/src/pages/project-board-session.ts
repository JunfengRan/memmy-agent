import { useSyncExternalStore } from "react";

export interface ProjectBoardSession {
  projectId: string | null;
  topicId: string | null;
}

let session: ProjectBoardSession = { projectId: null, topicId: null };
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function openProjectBoard(projectId: string, topicId: string | null = null): void {
  session = { projectId, topicId };
  emit();
}

export function closeProjectBoard(): void {
  if (!session.projectId && !session.topicId) return;
  session = { projectId: null, topicId: null };
  emit();
}

export function useProjectBoardSession(): ProjectBoardSession {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => session,
    () => session
  );
}
