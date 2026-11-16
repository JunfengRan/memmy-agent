import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const source = "Memory/src/service/project-memory/";
const targets = [
  "App/memmy-agent/src/memmy-memory/",
  "App/backend/src/adapters/outbound/skill-writer/workspace-bridge/",
];

/** Generate package-local, dependency-free injection assets from one source. */
export async function syncInjectionAssets({ root = repositoryRoot, check = false } = {}) {
  const assets = [
    ["inject/render.ts", "project-render.ts"],
    ["prompts/inject.ts", "project-prompts.ts"],
    ["inject/strip.ts", "project-strip.ts"],
  ];
  const stale = [];
  for (const [input, output] of assets) {
    const canonical = await readFile(join(root, source, input), "utf8");
    const body = input === "inject/render.ts"
      ? canonical.replace('"../prompts/inject.js"', '"./project-prompts.js"')
      : canonical;
    const generated = `// Generated from ${source}${input}.\n// Run node scripts/project-memory/sync-injection-assets.mjs; do not edit.\n${body}`;
    for (const target of targets) {
      const path = join(root, target, output);
      const current = await readFile(path, "utf8").catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (current === generated) continue;
      stale.push(`${target}${output}`);
      if (!check) await writeFile(path, generated);
    }
  }
  if (check && stale.length) throw new Error(`Project injection assets are stale:\n${stale.join("\n")}`);
  return stale;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await syncInjectionAssets({ check: process.argv.includes("--check") });
}
