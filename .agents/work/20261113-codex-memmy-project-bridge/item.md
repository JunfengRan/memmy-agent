---
id: 20261113-codex-memmy-project-bridge
status: ready-for-review
owner: developer / Codex
roadmap: PM-30
branch: dev-project-memory-add-search
updated: 2026-11-13
---

# Codex 与 Memmy 的 chat 本机项目记忆互通

## 目标与范围

按用户明确要求，让 /Users/junfengran/chat 的 Codex 和 Memmy 项目共用既有本机 Space。补外部宿主 prompt recall / Stop capture 和按工作目录的 CLI 查询；复用 BFF 鉴权、项目归属、持久化投递与 OpenMem。保留 release 前端和云端写锁，不改项目记忆算法、模型提示词、云端 Store。

## 规格出处

v3 §2.2.1–2.2.2、§3.1–3.4；ADR-0011。本次用户明确授权扩展 Codex 本机宿主与 subagent 实验。

## 验收标准

- [x] chat 双端绑定同一 Space，跨项目/关闭后不召回或写入。
- [x] Codex 原生完成轮次入队，真实整理后 Memmy 新会话回答。
- [x] Memmy 原生完成轮次入队，真实整理后 Codex 新会话回答。
- [ ] 重复 Stop 幂等，失败/取消轮次不写入；独立 reviewer 复核。

## 状态记录

| 日期 | 状态 | 由谁 | 文件 |
| --- | --- | --- | --- |
| 2026-11-13 | in-progress | developer / Codex | item.md |

| 2026-11-13 | ready-for-review | developer / Codex | handoff-01.md、validation-01.md |
