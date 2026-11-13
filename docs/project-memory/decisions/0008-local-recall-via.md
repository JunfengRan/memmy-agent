# ADR-0008：本机检索字段 recall_via

- 日期：2026-11-10
- 状态：已采纳
- 规格出处：v3 §3.3.5、§6.5 #12；open-questions Q-17

## 背景

v3 要求工具检索写 `via=tool`，并且不算本轮开始。`search_memory` 的公开入参没有入口字段。ADR-0005 #9 把 recall_log 收成只有 `turn_start`（`session_start` 按 Q-03 不实现）。2026-11-06 的补记把工具这一半留给 PM-21。

## 决定

- Local 的 `POST /api/openmem/v1/search/memory` 接受本机字段 `recall_via`，取值只有 `turn_start` 或 `tool`，缺省 `turn_start`。其他值返回 `INVALID_PARAMS`，不写 recall_log。
- 该字段不进 SDK 公开参数。云端客户端转发 `search/memory` 时丢掉它。
- 宿主工具处理函数（`bindProjectToolRequest`、Memmy Agent 的 `search_project_memory`、CLI `project search`）填写 `tool`。模型提交的 `user_id`、`space_ids`、`conversation_id` 被宿主覆盖。
- `via=tool` 不调用 `/api/v1/turns/start`。这些行仍进入 `recalledIds`，也仍参与「已告知」读 recall_log 的判定，不按 `via` 排除。
- 这收回 ADR-0005 #9 的工具检索一半。`via=session_start` 仍不实现。

## 影响

- 缺 `conversation_id` 时仍不写 recall_log。
- 直接调 HTTP 且不传 `recall_via` 的检索仍记 `turn_start`。
- 每轮注入相对全量不超过 30% 没有在实况回放上测量（Q-31）。本决定不改检索算法。

## 替代方案

- 把 `via` 放进 SDK 公开参数：云端不需要这个字段，否决。
- 工具检索不写 recall_log：已告知会漏掉工具展示过的分歧，否决。
