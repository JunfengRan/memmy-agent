---
id: 20261113-project-memory-desktop
status: in-progress
owner: developer / Codex
roadmap: PM-28
branch: dev-project-memory-add-search
updated: 2026-11-13
---

# release v1.2.7 与桌面本机项目记忆闭环

## 目标与范围

从 dev-project-memory-add-search-dev 创建 dev-project-memory-add-search，合入完整 upstream/release/v1.2.7。
项目内显式开启本机项目记忆，自动整理新轮次、手动导入本机 Memmy 历史、按项目召回、查看主题与来源。
不做成员共享记忆、云端 Store、外部宿主适配或算法/提示词变更。不修改原分支或远端 main。

## 规格出处

v3 §2.2.1–2.2.2、§3.2–3.4、§4.1、§4.8–4.11；ADR-0002、0003、0005、0008。
standard SHA 与 spec-snapshots 一致；用户已确认本机闭环、项目内开启、手动历史导入及实施计划。

## 验收标准

- [x] 同步本地 main、release，并在目标分支保留两边历史。
- [x] 同一项目并发开启只绑定一个 MemOS 生成的 Space；关闭和重启保留绑定。
- [x] 新轮次异步写入，历史导入去重，失败可见可重试。
- [x] 会话/工具按当前项目绑定检索；项目隔离，关闭后不注入。
- [x] 应用能查看主题与来源，导入本机历史任务并查看进度。
- [x] 类型检查、相关测试、独立配置端到端验证有实际证据。
- [x] 文档、ADR 与交接同步，等待独立 reviewer，不自标 approved。

## 相关工作项

20261112-project-memory-audit 保持 ready-for-review，本轮不替代其独立复核。

## 状态记录

2026-11-13：developer / Codex 完成合并基线、应用接入、类型与回归、独立 HTTP/浏览器冒烟；准备交独立 reviewer。此前审计复核状态不变。
