---
id: PM-12-split-organize
status: done
owner: reviewer
roadmap: PM-12
branch: dev-project-memory-add-search-dev
updated: 2026-11-10
---

# 拆开 M02 / M04 / M05 三次模型调用

## 目标

把 add 的一次 organize 调用拆成抽取、按草稿召回、归属、全量读、判断，再进入既有的确定性合并。

## 范围

- 包含：`prompts/extract.ts`、`prompts/assign.ts`、`prompts/merge-judge.ts`；`organize/extract.ts`、`organize/assign.ts`、`organize/candidates.ts`；`merge/judge.ts`；任务详情里的 basis / dropped / degraded；ADR-0007
- 不包含：提交与交接；推迟回填；`split`；复述与 `recall_log` 的比对

## 规格出处

- 架构文档 §2.2.5、§2.2.6、§2.2.7、§2.2.8、§2.2.9、§2.3.1、§2.3.2
- ADR-0007（收回 ADR-0005 #2、#5）

## 验收标准

- [x] `npm --prefix Memory run typecheck` 通过
- [x] `cd Memory && npx vitest run tests/service/project-memory` 通过（8 个文件，36 个测试）
- [x] 三个提示词带版本号，旧 `prompts/organize.ts` 已删除
- [x] 每个任务只抽取一次；`TOPIC_SET_CHANGED` 不重抽；`VERSION_CONFLICT` 不重抽、不重归类
- [x] `get/status` 不返回 `details`
- [x] 默认路径不调用决策模型
- [ ] 数据集 v2 复测：2026-11-10 阅读模型 `claude-haiku-5-5` 网关返回 503 `model_not_found`，回放中止，没有新指标。G-02、G-03、G-04、G-08、G-09 保持打开

## 相关工作项

PM-13、PM-14、PM-15

## 状态记录

| 日期 | 状态 | 由谁 | 文件 |
| --- | --- | --- | --- |
| 2026-11-10 | in-progress | developer / Cursor | item.md |
| 2026-11-10 | ready-for-review | developer / Cursor | handoff-01.md（018c169a） |
| 2026-11-10 | done | reviewer / Cursor | review-01.md |
