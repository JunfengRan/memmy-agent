import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadEvalSet, renderSession, sessionFile } from "./load-eval-set.mjs";

const set = loadEvalSet();
const projects = new Map(set.corpus.projects.map((project) => [project.id, project]));
for (const session of set.corpus.sessions) {
  const file = sessionFile(session, projects);
  if (!file) continue;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, renderSession(session, set.corpus.traces));
}
process.stdout.write("sessions written\n");
