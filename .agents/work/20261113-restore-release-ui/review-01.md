---
item: 20261113-restore-release-ui
seq: 01
role: reviewer
app: Codex / independent sub-agent
model: GPT-6
date: 2026-11-13
reviewed: handoff-01.md
range: 7b7f450e..80798cf0
verdict: changes-requested
---

# 评审 01：前端恢复与自动绑定符合修正范围，云端写锁漏一处生产装配

## 独立复核

- 对比前端与 `upstream/release/v1.2.7`：新增记忆按钮/弹窗/开关/client/CSS 已删除。产品源码只剩 app-frame、collab-page、collab-share-toggle、home-page 的上传锁接线，以及本地化说明；原看板与任务布局没有重写。两份还原 CSS 与 release 字节一致，保留其既有 EOF 空行是正确范围控制。
- Memory、Backend、Frontend 类型检查按顺序独立执行，均 exit 0。
- Backend 交接所列 4 个文件：76 passed。
- Frontend 共享控件、设置、看板、指令、新建项目 5 文件：42 passed；home-page、app-frame 2 文件：163 passed；合计 7 文件、205 passed。
- 复核默认本机自动绑定：只绑定缺少记录的项目；显式关闭的旧绑定保留；新自动绑定的 enabledAt 为后端构造时刻，因此首轮发生在首次轮询之前也会采集；启动前历史不自动导入。该边界有独立回归支持。
- 模型配置与真实推理证据见 metrics R-20261113-02；本 reviewer 未读取 env 密钥或用户配置正文，未独立重发真实模型请求，不将开发者真实冒烟外推为质量评测。

## 意见

| 编号 | 级别 | 位置 | 问题、要求与依据 | 验证 |
| --- | --- | --- | --- | --- |
| R1-1 | MUST | App/backend/src/index.ts:365 | `collab` 实例传了 `allowCloudWrites=false`，但 `collabAssist` 另建的 `createCollabCloudRequest` 未传该选项，默认允许写。旧协作项目的协助入口与后台执行仍能 POST 成员请求/附件、执行 transcript、promptContext 到云端（collab-assist-service.ts:903、1669、1742）。这直接违背用户“上传云端锁死”和 ADR-0011 的“所有非 GET 在 fetch 前拒绝”。必须覆盖所有生产 Collab transport 装配，不能只锁项目列表服务。 | 用真实生产装配选项或防漏装配回归验证：共享请求和协助请求/进度上报均 forbidden 且 fetch 不执行；已有 GET 读取保持可用。现有单测只显式传 false，无法发现本次漏传。 |

## 验收结论

前端恢复最小范围、本机默认绑定和首轮/历史时间边界符合当前用户修正；缺少协助 transport 的写锁，尚不能声称云端上传已全面锁死。需关闭 R1-1 后复核。

原 `20261113-project-memory-desktop` 已批准的核心修补不回退；本结论不批准此前 `20261112-project-memory-audit`。无新增设计裁决需求。
