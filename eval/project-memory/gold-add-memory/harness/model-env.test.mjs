import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pinnedModels } from "./model-env.mjs";

function home() {
  const dir = mkdtempSync(join(tmpdir(), "model-env-"));
  for (const [profile, model] of [["deepseek", "deepseek-v4.1-flash-1017"], ["openai", "gpt-6-luna"], ["claude", "claude-haiku-5-5"]]) {
    writeFileSync(join(dir, `.${profile}.env`), `MODEL=${model}\nOPENAI_API_BASE=https://gateway/v1\nOPENAI_API_KEY=key\n`);
  }
  return dir;
}
const record = { roles: {
  sut: { profile: "deepseek", model: "deepseek-v4.1-flash-1017" },
  reader: { profile: "deepseek", model: "deepseek-v4.1-flash-1017" },
  judge: { profile: "openai", model: "gpt-6-luna" }
} };
const reachable = (...down) => async (config) => ({ ok: !down.includes(config.profile), error: down.includes(config.profile) ? "429" : undefined });

test("pinned models are reused unchanged while every profile answers", async () => {
  const { chosen, switches } = await pinnedModels(record, { home: home(), probeImpl: reachable() });
  assert.deepEqual(switches, []);
  assert.equal(chosen.reader.model, "deepseek-v4.1-flash-1017");
  assert.equal(chosen.judge.model, "gpt-6-luna");
});

test("a rate-limited deepseek reader falls back to the next profile and records the switch", async () => {
  const { chosen, switches } = await pinnedModels(record, { home: home(), probeImpl: reachable("deepseek") });
  assert.equal(chosen.reader.model, "gpt-6-luna");
  assert.equal(switches.length, 1);
  assert.equal(switches[0].role, "reader");
});

test("the fallback judge never shares the SUT's family", async () => {
  const { chosen } = await pinnedModels(record, { home: home(), probeImpl: reachable("deepseek"), sutProfile: "openai" });
  assert.equal(chosen.sut.model, "gpt-6-luna");
  assert.equal(chosen.judge.model, "claude-haiku-5-5");
});
