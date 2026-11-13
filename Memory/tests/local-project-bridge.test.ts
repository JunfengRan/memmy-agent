import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { captureLocalProjectTurn, recallLocalProjectMemory, requestLocalProjectMemory } from "../src/agent-source/integration/workspace-bridge/project-memory.js";
import { runCommand } from "../src/cli/commands.js";
import type { SourceTurn } from "@memmy/agent-source-core";
const roots: string[] = [];
afterEach(() => { vi.unstubAllGlobals(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(baseUrl = "http://127.0.0.1:12345") {
 const root = mkdtempSync(join(tmpdir(), "memmy-project-bridge-")); roots.push(root);
 const configPath = join(root,"config.yaml"); const configUrl = pathToFileURL(join(root,"hook.json"));
 writeFileSync(configUrl, JSON.stringify({memmy_config_path:configPath}));
 writeFileSync(join(root,"runtime.json"), JSON.stringify({baseUrl,localToken:"fixture-token"}));
 return {configUrl,configPath};
}
const turn: SourceTurn = { source:"codex",conversationId:"chat-a",turnId:"turn-1",startedAt:"2026-11-13T00:00:00.000Z",completedAt:"2026-11-13T00:01:00.000Z",sequence:1,completionEvidence:"task_complete",query:"choose amber",answer:"confirmed amber",status:"succeeded",toolCalls:[],toolResults:[] };
it("delegates workspace scope and preserves native identity/timestamps for retry deduplication", async () => {
 const config=fixture(); const calls: Record<string,unknown>[]=[];
 vi.stubGlobal("fetch",vi.fn(async (_url,options) => {calls.push(JSON.parse(options.body)); return Response.json({bound:true,jobIds:["same-job"]});}));
 await captureLocalProjectTurn({...config,workspace:"/projects/chat",turn});
 await captureLocalProjectTurn({...config,workspace:"/projects/chat",turn});
 expect(calls).toEqual([{workspace:"/projects/chat",turn},{workspace:"/projects/chat",turn}]);
 expect(calls[0]).not.toHaveProperty("spaceId"); expect(calls[0]).not.toHaveProperty("userId");
 await captureLocalProjectTurn({...config,workspace:"/projects/chat",turn:{...turn,status:"failed"}});
 expect(calls).toHaveLength(2);
});
it("renders the standard project context and fails closed when unbound or unavailable", async () => {
 const config=fixture(); let result:unknown={bound:true,data:{topic_detail_list:[{id:"topic-a",topic_name:"palette",decisions:[{content:"amber",time:turn.startedAt}]}]}};
 const fetch = vi.fn(async(_url:unknown,options?:RequestInit)=> { expect(JSON.parse(options!.body as string).recallVia).toBe("turn_start"); return Response.json(result); });
 vi.stubGlobal("fetch", fetch);
 const context=await recallLocalProjectMemory({...config,workspace:"/projects/chat",query:"palette"});
 expect(context).toContain("<memos_context"); expect(context).toContain("amber");
 result={bound:false}; expect(await recallLocalProjectMemory({...config,workspace:"/projects/other",query:"palette"})).toBe("");
 vi.stubGlobal("fetch",vi.fn(async()=>{throw new Error("offline");}));
 expect(await recallLocalProjectMemory({...config,workspace:"/projects/chat",query:"palette"})).toBe("");
});
it("refuses a nonlocal runtime before sending the token", async()=>{
 const config=fixture("https://example.com"); const fetch=vi.fn();
 await expect(requestLocalProjectMemory("recall",{workspace:"/projects/chat"},{...config,fetch})).rejects.toThrow("unavailable");
 expect(fetch).not.toHaveBeenCalled();
});
it("keeps the desktop renderer aligned with the Memory renderer",()=>{
 const memory=readFileSync(new URL("../src/service/project-memory/inject/render.ts",import.meta.url),"utf8");
 const desktop=readFileSync(new URL("../../App/backend/src/adapters/outbound/skill-writer/workspace-bridge/project-render.ts",import.meta.url),"utf8");
 expect(desktop).toBe(memory.replace('"../prompts/inject.js"','"./project-prompts.js"'));
});

it("CLI searches its workspace binding without explicit Space or personal owner", async()=>{
 const config=fixture(); writeFileSync(config.configPath,"{}");
 const previous=process.env.MEMMY_PROJECT_SPACE_IDS; delete process.env.MEMMY_PROJECT_SPACE_IDS;
 try {
   const calls:Record<string,unknown>[]=[];
   const fetch=vi.fn(async(_url:unknown,options?:RequestInit)=>{calls.push(JSON.parse(options!.body as string));return Response.json({bound:true,data:{topic_detail_list:[{id:"topic-a",topic_name:"palette",decisions:[{content:"amber"}]}]}});});
   const result=await runCommand({argv:["project","search","palette","--cwd","/projects/chat","--config",config.configPath],fetch:fetch as typeof globalThis.fetch});
   expect(result).toContain("amber"); expect(result).toContain('kind="tool"');
   expect(calls).toEqual([{workspace:"/projects/chat",query:"palette",recallVia:"tool"}]);
 } finally { if(previous===undefined) delete process.env.MEMMY_PROJECT_SPACE_IDS; else process.env.MEMMY_PROJECT_SPACE_IDS=previous; }
});

it("CLI forwards registered-domain filters and a valid result limit", async()=>{
 const config=fixture(); writeFileSync(config.configPath,"{}");
 const previous=process.env.MEMMY_PROJECT_SPACE_IDS; delete process.env.MEMMY_PROJECT_SPACE_IDS;
 try {
  const fetch=vi.fn(async(_url:unknown,options?:RequestInit)=>{
    expect(JSON.parse(options!.body as string)).toEqual({workspace:"/projects/chat",query:"palette",recallVia:"tool",domains:["通用"],memoryLimit:2});
    return Response.json({bound:true,data:{topic_detail_list:[]}});
  });
  await runCommand({argv:["project","search","palette","--cwd","/projects/chat","--config",config.configPath,"--domains","通用","--limit","2"],fetch:fetch as typeof globalThis.fetch});
  expect(fetch).toHaveBeenCalledOnce();
 } finally { if(previous===undefined) delete process.env.MEMMY_PROJECT_SPACE_IDS; else process.env.MEMMY_PROJECT_SPACE_IDS=previous; }
});
