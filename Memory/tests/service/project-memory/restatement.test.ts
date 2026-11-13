import { describe, expect, it } from "vitest";
import { stripInjectedContext } from "../../../src/service/project-memory/organize/collect.js";
import {
  RESTATEMENT_RECALL_LIMIT,
  RESTATEMENT_TEXT_LIMIT,
  clampRecalled,
  filterRestatements,
  type RecalledEntry,
  type RestatementDraft,
  type RestatementTurn
} from "../../../src/service/project-memory/organize/restatement.js";

const RETRY = "推送服务失败后按指数退避重试三次";
const RETRY_SPACED = "推送服务 失败后按指数退避重试三次。";
const RETRY_PARAPHRASE = "推送服务失败后按指数退避重试三次，并告知用户B";
const OWNER = "推送服务保持可用";
const OWNERS = "推送服务由用户A负责，用户B协助";
const HALF = "推送 幂等";
const BELOW = "推送 幂等 扩容";

const recalled: RecalledEntry[] = [
  { ref: "dec_retry", text: RETRY },
  { ref: "dec_owner", text: OWNER },
  { ref: "dec_owners", text: OWNERS }
];

const turns: RestatementTurn[] = [
  { role: "assistant" },
  { role: "user" }
];

function draft(fields: RestatementDraft): RestatementDraft {
  return fields;
}

describe("stripInjectedContext", () => {
  it("removes bare and attributed memos_context blocks and keeps the surrounding text", () => {
    const bare = "前文<memos_context>旧的推送结论</memos_context>后文";
    expect(stripInjectedContext(bare)).toBe("前文后文");

    const attributed = [
      "用户A：推送服务要保持幂等。",
      "<memos_context v=\"1\" kind=\"tool\">",
      "已召回：重试三次",
      "</memos_context>",
      "用户B：同意。"
    ].join("\n");
    expect(stripInjectedContext(attributed)).toBe("用户A：推送服务要保持幂等。\n\n用户B：同意。");

    const both = "甲<memos_context>一</memos_context>乙<memos_context v=\"1\" kind=\"turn\">二</memos_context>丙";
    expect(stripInjectedContext(both)).toBe("甲乙丙");

    const leading = "<memos_context v=\"1\" kind=\"session\">索引</memos_context>\n用户A：推送服务";
    expect(stripInjectedContext(leading)).toBe("用户A：推送服务");

    const open = "用户A 开始 <memos_context v=\"1\" kind=\"tool\"> 没有结束";
    expect(stripInjectedContext(open)).toBe(open);
  });
});

describe("filterRestatements", () => {
  it("drops an assistant draft whose normalized text equals a recalled entry", () => {
    const item = draft({ content: RETRY_SPACED, role: "assistant" });
    const result = filterRestatements([item], turns, recalled);
    expect(result.kept).toEqual([]);
    expect(result.dropped).toEqual([{ content: RETRY_SPACED, reason: "restatement" }]);
  });

  it("drops an assistant draft that restates a recalled ref at overlap 0.5 or higher", () => {
    const paraphrase = draft({ content: RETRY_PARAPHRASE, role: "assistant", restates: "dec_retry" });
    const half = draft({ content: HALF, role: "assistant", restates: "dec_owner" });
    const result = filterRestatements([paraphrase, half], turns, recalled);
    expect(result.kept).toEqual([]);
    expect(result.dropped).toEqual([
      { content: RETRY_PARAPHRASE, reason: "restatement" },
      { content: HALF, reason: "restatement" }
    ]);
  });

  it("checks every recalled entry that shares the restates ref", () => {
    const item = draft({ content: RETRY_PARAPHRASE, role: "assistant", restates: "dec_retry" });
    const result = filterRestatements([item], turns, [
      { ref: "dec_retry", text: "队列超时由用户A设定" },
      { ref: "dec_retry", text: RETRY }
    ]);
    expect(result.dropped).toEqual([{ content: RETRY_PARAPHRASE, reason: "restatement" }]);
  });

  it("keeps an assistant draft that overlaps recalled text but does not set restates", () => {
    const item = draft({ content: RETRY_PARAPHRASE, role: "assistant", restates: null });
    const result = filterRestatements([item], turns, recalled);
    expect(result.kept).toEqual([item]);
    expect(result.dropped).toEqual([]);
    expect(result.kept[0]).toBe(item);
  });

  it("keeps a user draft even when the text matches recalled text", () => {
    const item = draft({ content: `${OWNERS}。`, role: "user", restates: "dec_owners" });
    const result = filterRestatements([item], turns, recalled);
    expect(result.kept).toEqual([item]);
    expect(result.dropped).toEqual([]);
  });

  it("keeps an assistant draft whose restates ref is not in the recalled set", () => {
    const item = draft({ content: RETRY_PARAPHRASE, role: "assistant", restates: "dec_missing" });
    const result = filterRestatements([item], turns, recalled);
    expect(result.kept).toEqual([item]);
    expect(result.dropped).toEqual([]);
  });

  it("keeps an assistant draft when overlap with the restated ref is below 0.5", () => {
    const item = draft({ content: BELOW, role: "assistant", restates: "dec_owner" });
    const result = filterRestatements([item], turns, recalled);
    expect(result.kept).toEqual([item]);
    expect(result.dropped).toEqual([]);
  });

  it("returns the drafts unchanged when the recalled set is empty", () => {
    const dropping = draft({ content: RETRY, role: "assistant", restates: "dec_retry" });
    const user = draft({ content: OWNERS, role: "user" });
    const result = filterRestatements([dropping, user], turns, []);
    expect(result.kept).toEqual([dropping, user]);
    expect(result.kept[0]).toBe(dropping);
    expect(result.kept[1]).toBe(user);
    expect(result.dropped).toEqual([]);
  });

  it("keeps a matching assistant draft that carries an approval signal", () => {
    const item = draft({
      content: RETRY_SPACED,
      role: "assistant",
      signals: [{ type: "approval" }]
    });
    const result = filterRestatements([item], turns, recalled);
    expect(result.kept).toEqual([item]);
    expect(result.dropped).toEqual([]);
  });

  it("keeps a restating assistant draft that carries a resolve signal", () => {
    const item = draft({
      content: RETRY_PARAPHRASE,
      role: "assistant",
      restates: "dec_retry",
      signals: [{ type: "resolve" }]
    });
    const result = filterRestatements([item], turns, recalled);
    expect(result.kept).toEqual([item]);
    expect(result.dropped).toEqual([]);
  });

  it("still drops a matching assistant draft when the only signal is informed", () => {
    const item = draft({
      content: RETRY,
      role: "assistant",
      signals: [{ type: "informed" }]
    });
    const result = filterRestatements([item], turns, recalled);
    expect(result.dropped).toEqual([{ content: RETRY, reason: "restatement" }]);
  });

  it("drops a backfill draft with no source role only on an exact match", () => {
    const exact = draft({ content: RETRY_SPACED, role: "unknown", restates: "dec_retry" });
    const overlapOnly = draft({ content: RETRY_PARAPHRASE, role: "unknown", restates: "dec_retry" });
    const result = filterRestatements([exact, overlapOnly], turns, recalled);
    expect(result.dropped).toEqual([{ content: RETRY_SPACED, reason: "restatement" }]);
    expect(result.kept).toEqual([overlapOnly]);
    expect(result.kept[0]).toBe(overlapOnly);
  });

  it("keeps and drops in input order", () => {
    const exact = draft({ content: RETRY, role: "assistant" });
    const user = draft({ content: RETRY, role: "user" });
    const overlap = draft({ content: HALF, role: "assistant", restates: "dec_owner" });
    const result = filterRestatements([exact, user, overlap], turns, recalled);
    expect(result.kept).toEqual([user]);
    expect(result.dropped.map((item) => item.content)).toEqual([RETRY, HALF]);
  });

  it("compares the recalled text it is given, including text past the clamp limit", () => {
    const long = `推送服务${"甲".repeat(RESTATEMENT_TEXT_LIMIT)}`;
    const item = draft({ content: long, role: "assistant" });
    const result = filterRestatements([item], turns, [{ ref: "dec_long", text: long }]);
    expect(long.length).toBeGreaterThan(RESTATEMENT_TEXT_LIMIT);
    expect(result.dropped).toEqual([{ content: long, reason: "restatement" }]);
  });
});

describe("clampRecalled", () => {
  it("keeps 40 entries and 200 characters of each text", () => {
    expect(RESTATEMENT_RECALL_LIMIT).toBe(40);
    expect(RESTATEMENT_TEXT_LIMIT).toBe(200);

    const body = "甲".repeat(RESTATEMENT_TEXT_LIMIT);
    const entries = Array.from({ length: RESTATEMENT_RECALL_LIMIT + 1 }, (_, index) => ({
      ref: `dec_${index}`,
      text: index === 0 ? `  ${body}乙` : `推送服务条目${index}`
    }));
    const original = entries[0]!.text;
    const clamped = clampRecalled(entries);

    expect(clamped).toHaveLength(RESTATEMENT_RECALL_LIMIT);
    expect(clamped[0]).toEqual({ ref: "dec_0", text: body });
    expect(clamped[39]).toEqual({ ref: "dec_39", text: "推送服务条目39" });
    expect(entries[0]!.text).toBe(original);
    expect(clamped.some((entry) => entry.ref === "dec_40")).toBe(false);
  });
});
