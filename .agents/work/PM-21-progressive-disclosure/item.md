---
id: PM-21-progressive-disclosure
status: done
owner: reviewer
roadmap: PM-21
branch: dev-project-memory-add-search-dev
updated: 2026-11-10
---

# PM-21 渐进式披露

## 目标

工具检索写 `via=tool` 且不调用 `/turns/start`。宿主用 `search_project_memory` / `memmy-memory project search` 查项目记忆。不提交。

## 范围

- 包含：本机字段 `recall_via`；`inject/tool.ts`；CLI `project search`；宿主技能两份模板；Memmy Agent 工具 `search_project_memory`；`get/memory/:id` 现有信封的契约测试
- 不包含：提交与交接；`start_conversation`；注入模板 1–3 的正文（PM-22）；改 `user_memory` / `agent_memory` 列表名（Q-29）；改检索算法去凑 30%；评测集与 history；实况模型评测

## 规格出处

- 架构文档 §3.1–3.3、§4.3
- ADR-0008；ADR-0005 #9 的工具一半；open-questions Q-17、Q-31、Q-32

## 验收标准

- [x] `recall_via=tool` 的每一行 `via=tool`；缺省 `turn_start`；非法值 400 且不写日志；缺 `conversation_id` 不写
- [x] 模型带来的 `space_ids` / `user_id` / `conversation_id` 被宿主覆盖；默认 limit 3；外层 `kind="tool"`
- [x] `via=tool` 不调用 `/turns/start`；工具行仍进入 `recalledIds` / 已告知
- [x] CLI 打到 `/api/openmem/v1/search/memory`，`withApiPrefix` 不再给 `/api/` 加前缀；没有 space 不打 `/memory/search`
- [x] `get/memory/:id` 的 GET 与 POST 保持现有 `{ topic_detail_list: [topic] }` 信封
- [x] 未绑定 space 不注册 `search_project_memory`；绑定时请求体含 `recall_via: tool`
- [x] 30% 比例未在实况回放上测量（Q-31）
- [ ] 交接（本轮不写 handoff，代码未提交）

## 相关工作项

PM-20、PM-22

## 状态记录

| 日期 | 状态 | 由谁 | 文件 |
| --- | --- | --- | --- |
| 2026-11-10 | in-progress | developer / Cursor | item.md |
| 2026-11-10 | ready-for-review | developer / Cursor | handoff-01.md（eaefb0cc） |
| 2026-11-10 | done | reviewer / Cursor | review-01.md |
