---
item: 20261113-project-memory-desktop
seq: 01
role: developer
app: Codex
model: GPT-6
date: 2026-11-13
branch: dev-project-memory-add-search
base: a32c5fd0
head: 2481e6ae
to: reviewer
status: ready-for-review
---

# 交接 01：release 合并与本机项目记忆应用闭环

## 结论

本地 main 已同步 upstream/main e640129a，release/v1.2.7 跟踪 upstream 同名分支 ffe73628；目标分支从原开发分支创建。baa469c5 完整合入 release，2481e6ae 接通应用。原开发分支仍为 a32c5fd0，无远端推送。

项目看板可显式开启本机记忆、查看主题与来源、选择本项目的 Memmy 历史任务导入、查看失败并重试。后台采集已保存的新轮次，Agent 按当前会话绑定空间，独立任务不继承全局空间。真实 HTTP 与真实面板的浏览器冒烟通过，模型为确定性桩，不声称真实模型质量、Electron 打包或云端成员共享已验证。

## 改动与依据

- merge baa469c5：逐块解决 10 个文本冲突，保留 release 的新调度器、租约 fence、召回候选去重与 memmy_memory 协议更新，以及既有项目记忆算法/注入/时间/向量修补。project_memory_organize 新增预算/策略登记、Space 依赖与租约串行。schema 升 v16，兼容 v10/v15。
- Backend：project-memory-service.ts 维护跨进程锁与原子文件；已保存消息是唯一采集来源，变化文件缓存避免重复解析；投递前保存稳定时间与正文，复用 add/message/get/status；仅在项目启用时采集，历史显式选择。新接口受 runtime token 保护，确认项目/会话/主题归属，通过 OpenMem client 访问 Memory。
- Agent：project-bindings.ts 只读契约文件，hook 按 websocket 会话的 hostProjectId 解析空间；loop 创建当前轮次工具注册表时传宿主项目上下文；工具范围与 recall_log 会话键均由宿主覆盖。绑定在响应后再次检查，关闭后不注入迟到结果。
- Frontend：现有看板入口和设置开关；独立记忆面板显示主题、完整历史/冲突/轨迹、来源任务、整理状态、历史选择与重试。使用现有 Modal 和应用样式，浏览器截图检查后修正通用弹窗样式覆盖。
- 依据：ADR-0010（用户确认的应用接入决策）、Q-03/Q-04/Q-32、v3 §2.2、§3.2–3.4、§4.1、§4.8–4.11。未改提示词或检索算法，未启动 PM-24～27。

## 验证（developer 实际执行）

- npm --prefix Memory run typecheck：通过。
- npm --prefix App/backend run typecheck：通过。
- npm --prefix App/memmy-agent run typecheck：通过。
- npm --prefix App/frontend/desktop run typecheck：通过。四者顺序执行，避免共享契约 dist 重建互相影响。
- cd Memory && npx vitest run tests/service/project-memory tests/service/retrieval/recall-candidates.test.ts tests/storage/token-usage-outbox.test.ts tests/service/worker/job-policy-registry.test.ts tests/cli-command-map.test.ts：25 文件，233 passed、1 todo。
- cd App/memmy-agent && npx vitest run tests/memmy-memory tests/core/agent-runtime/loop-session-workspace.test.ts tests/entrypoints/frontend-bridge/webui-projects.test.ts：12 文件，185 passed。
- cd App/backend && npx vitest run src/services/tests/project-memory-service.test.ts src/adapters/inbound/local-api/tests/projects-routes.test.ts src/services/tests/collab-service.test.ts src/services/tests/project-instructions-service.test.ts src/services/tests/collab-instructions-service.test.ts：5 文件，91 passed。
- cd App/backend && npx vitest run src/services/tests/project-memory-service.test.ts src/adapters/inbound/local-api/tests/projects-routes.test.ts src/adapters/outbound/memory-client/tests/http-memory-client.test.ts：3 文件，45 passed。
- cd App/backend && npx vitest run src/adapters/inbound/local-api/tests/project-memory-routes.test.ts src/services/tests/project-memory-service.test.ts：2 文件，8 passed（含鉴权/参数越界）。
- cd App/frontend/desktop && npx vitest run src/pages/tests/project-memory-panel.interaction.test.tsx src/pages/tests/project-settings-dialog.interaction.test.tsx src/pages/tests/project-board-local.interaction.test.tsx src/pages/tests/project-config-instructions.interaction.test.tsx：4 文件，30 passed。
- 真实 HTTP/Chrome 冒烟及 v10/v15 源码建库再升级：metrics R-20261113-01。独立临时配置/数据库；模型与 embedding 为桩。A 新会话召回 true、B false、关闭后 A false；1 completed/1 topic；浏览器 pageerror=0；来源按钮收到原 websocket 键；同一历史导入不重复投递。生成物在忽略的 runs/20261113-desktop/。
- git diff --check 通过。未运行全量 npm test、付费质量评测、Electron 打包安装。

## 已知边界

- 当前项目记忆的云端 Store、外部宿主以及所有原待决算法语义不改。此前 20261112-project-memory-audit 保持独立待复核，不由本轮批准。
- 关闭前已经受理的 Memory 整理任务可以继续；重新开启不补采关闭期间消息。大历史导入保存在本机投递记录后逐轮处理。
- 创建 Space 后、绑定持久化之前进程被强杀可能遗留未绑定 Space；普通保存失败有补偿删除。详见 ADR-0010。
- 记忆面板来源按钮只打开当前项目任务列表里仍可访问的本机任务；已删除来源不可打开。

## 请 reviewer 重点看

1. Backend project-memory-service.ts：跨进程锁、原子提交、稳定消息去重、开启时间边界与失败恢复。
2. Agent hook.ts/tools.ts/loop.ts：多会话并发项目隔离，工具注册与执行范围一致，关闭后的迟到结果处理。
3. release 合并的调度/预算/Space FIFO；schema v16 兼容原两侧版本。
4. 新 BFF 鉴权、历史导入与主题归属校验，以及 UI 的状态/重试链路。
5. 合成桩冒烟的证据边界，不能当成真实模型效果或 Electron 体验证据。
