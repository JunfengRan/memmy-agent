import { useSyncExternalStore } from "react";

export interface ProjectBoardSession {
  projectId: string | null;
  topicId: string | null;
}

let session: ProjectBoardSession = { projectId: null, topicId: null };
let citationPanelOpen = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function openProjectBoard(projectId: string, topicId: string | null = null): void {
  citationPanelOpen = false;
  session = { projectId, topicId };
  emit();
}

export function closeProjectBoard(): void {
  if (!session.projectId && !session.topicId) return;
  session = { projectId: null, topicId: null };
  emit();
}

export function openCitationPanel(): void {
  if (citationPanelOpen) return;
  citationPanelOpen = true;
  emit();
}

export function closeCitationPanel(): void {
  if (!citationPanelOpen) return;
  citationPanelOpen = false;
  emit();
}

export function useProjectBoardSession(): ProjectBoardSession {
  return useSyncExternalStore(subscribe, () => session, () => session);
}

export function useCitationPanelOpen(): boolean {
  return useSyncExternalStore(subscribe, () => citationPanelOpen, () => citationPanelOpen);
}
