// Chooses the evaluation models from the local profile files and checks that each one answers.
// Profiles: ~/.deepseek.env (preferred), ~/.openai.env, ~/.claude.env, each with MODEL,
// OPENAI_API_BASE and OPENAI_API_KEY. When a profile's model does not answer, the next profile is
// used; an older model from the same profile is never substituted.
//   node harness/model-env.mjs --out <run>/models.json [--pin] [-- <command> [args...]]
// --pin reuses the roles already in models.json without probing (resuming a run).
// The command runs with MEMMY_EVAL_{READER,JUDGE}_* and MEMMY_EVAL_SUT_* set. models.json never
// contains keys.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { modelFamily, omitsTemperature } from "../llm.mjs";

export const PROFILES = ["deepseek", "openai", "claude"];
// The judge must not share the system under test's family, so it skips that profile.
export const ROLES = { sut: PROFILES, reader: PROFILES, judge: PROFILES };

export function parseEnvFile(text) {
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!match || line.trim().startsWith("#")) continue;
    values[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return values;
}

export function loadProfile(name, home = homedir()) {
  const path = join(home, `.${name}.env`);
  if (!existsSync(path)) return null;
  const values = parseEnvFile(readFileSync(path, "utf8"));
  const { MODEL: model, OPENAI_API_BASE: baseUrl, OPENAI_API_KEY: apiKey } = values;
  if (!model || !baseUrl || !apiKey) return null;
  return { profile: name, path, provider: "openai", model, baseUrl: baseUrl.replace(/\/+$/, ""), apiKey, family: modelFamily(model) };
}

export async function probe(config, { timeoutMs = 30_000, fetchImpl = fetch } = {}) {
  const started = performance.now();
  try {
    const response = await fetchImpl(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({
        model: config.model,
        ...(/^gpt-6/.test(config.model) ? { max_completion_tokens: 16 } : { max_tokens: 16 }),
        ...(omitsTemperature(config.model) ? {} : { temperature: 0 }),
        messages: [{ role: "user", content: "Reply with OK." }]
      })
    });
    const body = await response.json().catch(() => ({}));
    const ok = response.ok && typeof body.choices?.[0]?.message?.content === "string";
    return { ok, status: response.status, ms: performance.now() - started, ...(ok ? {} : { error: JSON.stringify(body).slice(0, 200) }) };
  } catch (error) {
    return { ok: false, status: 0, ms: performance.now() - started, error: String(error.message ?? error).slice(0, 200) };
  }
}

// Picks one model per role. Probes each profile once and reuses the result across roles.
export async function chooseModels({ home = homedir(), probeImpl = probe } = {}) {
  const checks = {};
  const attempts = [];
  const check = async (profile) => {
    if (!(profile in checks)) {
      const config = loadProfile(profile, home);
      checks[profile] = config ? { config, result: await probeImpl(config) } : { config: null, result: { ok: false, error: "profile missing or incomplete" } };
      attempts.push({ profile, model: config?.model ?? null, ...checks[profile].result });
    }
    return checks[profile];
  };
  const chosen = {};
  for (const role of ["sut", "reader", "judge"]) {
    for (const profile of ROLES[role]) {
      const { config, result } = await check(profile);
      if (!config || !result.ok) continue;
      if (role === "judge" && config.family === chosen.sut.family) continue;
      chosen[role] = config;
      break;
    }
    if (!chosen[role]) throw new Error(`No working model for ${role}: ${JSON.stringify(attempts)}`);
  }
  return { chosen, attempts };
}

export function modelEnv(chosen) {
  const env = { MEMMY_EVAL_SUT_MODEL: chosen.sut.model, MEMMY_EVAL_SUT_PROFILE: chosen.sut.profile };
  for (const [role, prefix] of [["reader", "MEMMY_EVAL_READER"], ["judge", "MEMMY_EVAL_JUDGE"]]) {
    const config = chosen[role];
    Object.assign(env, { [`${prefix}_PROVIDER`]: config.provider, [`${prefix}_MODEL`]: config.model, [`${prefix}_BASE_URL`]: config.baseUrl, [`${prefix}_API_KEY`]: config.apiKey });
  }
  return env;
}

export function publicRecord({ chosen, attempts }) {
  const view = ({ profile, path, model, baseUrl, family }) => ({ profile, path, model, baseUrl, family });
  return {
    chosenAt: new Date().toISOString(),
    roles: Object.fromEntries(Object.entries(chosen).map(([role, config]) => [role, view(config)])),
    probes: attempts.map(({ profile, model, ok, status, ms, error }) => ({ profile, model, ok, status, ms: Math.round(ms), ...(error ? { error } : {}) }))
  };
}

// The recorded roles with their keys reloaded from the same profile files. A pinned reader or judge
// that no longer answers falls back in profile order (deepseek, openai, claude); the judge still
// skips the SUT's family. The SUT stays as recorded unless MEMMY_EVAL_SUT_PROFILE names the profile
// the server was restarted on. Every switch is appended to record.switches.
export async function pinnedModels(record, { home = homedir(), probeImpl = probe, sutProfile = process.env.MEMMY_EVAL_SUT_PROFILE_OVERRIDE } = {}) {
  const chosen = {};
  const switches = [];
  const probes = {};
  const works = async (config) => (probes[config.profile] ??= await probeImpl(config)).ok;
  for (const role of ["sut", "reader", "judge"]) {
    const view = record.roles[role];
    const wanted = role === "sut" && sutProfile ? sutProfile : view.profile;
    const pinned = loadProfile(wanted, home);
    if (role === "sut") {
      if (!pinned) throw new Error(`SUT profile ${wanted} is missing`);
      chosen.sut = pinned;
      if (pinned.model !== view.model) switches.push({ role, from: view.model, to: pinned.model, reason: "server restarted on another profile" });
      continue;
    }
    const allowed = (config) => config && !(role === "judge" && config.family === chosen.sut.family);
    if (allowed(pinned) && pinned.model === view.model && await works(pinned)) { chosen[role] = pinned; continue; }
    for (const profile of ROLES[role]) {
      const config = loadProfile(profile, home);
      if (!allowed(config) || !(await works(config))) continue;
      chosen[role] = config;
      switches.push({ role, from: view.model, to: config.model, reason: probes[view.profile]?.error ?? "pinned model unavailable", at: new Date().toISOString() });
      break;
    }
    if (!chosen[role]) throw new Error(`No working fallback for ${role}: ${JSON.stringify(probes)}`);
  }
  return { chosen, switches };
}

async function main() {
  const args = process.argv.slice(2);
  const split = args.indexOf("--");
  const own = split >= 0 ? args.slice(0, split) : args;
  const command = split >= 0 ? args.slice(split + 1) : [];
  const outIndex = own.indexOf("--out");
  const out = outIndex >= 0 ? resolve(own[outIndex + 1]) : null;
  // --pin reuses the roles already recorded in --out (a resumed run must keep its reader and judge;
  // a transient rate limit on re-probing must not switch them).
  if (own.includes("--pin") && out && existsSync(out)) {
    const record = JSON.parse(readFileSync(out, "utf8"));
    const { chosen, switches } = await pinnedModels(record);
    if (switches.length) {
      const view = ({ profile, path, model, baseUrl, family }) => ({ profile, path, model, baseUrl, family });
      record.roles = Object.fromEntries(Object.entries(chosen).map(([role, config]) => [role, view(config)]));
      record.switches = [...record.switches ?? [], ...switches];
      writeFileSync(out, `${JSON.stringify(record, null, 2)}\n`);
      console.error(`model switch: ${JSON.stringify(switches)}`);
    }
    console.error(JSON.stringify(record.roles));
    if (!command.length) return 0;
    const result = spawnSync(command[0], command.slice(1), { stdio: "inherit", env: { ...process.env, ...modelEnv(chosen) } });
    return result.status ?? 1;
  }
  const selection = await chooseModels();
  const record = publicRecord(selection);
  if (out) { mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, `${JSON.stringify(record, null, 2)}\n`); }
  console.error(JSON.stringify(record.roles));
  if (!command.length) { console.log(JSON.stringify(record, null, 2)); return 0; }
  const result = spawnSync(command[0], command.slice(1), { stdio: "inherit", env: { ...process.env, ...modelEnv(selection.chosen) } });
  return result.status ?? 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try { process.exitCode = await main(); }
  catch (error) { console.error(String(error.message ?? error)); process.exitCode = 1; }
}
