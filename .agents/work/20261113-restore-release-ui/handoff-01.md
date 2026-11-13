---
item: 20261113-restore-release-ui
seq: 01
role: developer
app: Codex
model: GPT-6
date: 2026-11-13
branch: dev-project-memory-add-search
base: 7b7f450e
head: 80798cf0
to: reviewer
status: ready-for-review
---

# 恢复原版前端与本机接口接线

## 用户纠正与实现

用户要求：配置 ~/.deepseek.env 的模型；上一轮新增前端不符合需求，恢复 release/v1.2.7 原有前端，只调整必要接口接线，本地默认、上传云端锁死。

6b8f48bf 删除新增项目记忆面板/按钮/开关、CSS、前端 client 与测试；原看板和设置恢复 release，两个 collab CSS 与 upstream 字节一致。前端相对 release 的产品代码仅为共享上传锁定接线（加减共约二十多行）；旧项目和任务交互未改写。PROJECT_CLOUD_UPLOAD_ENABLED=false 同时用于应用装配和后台 transport：原新建/设置不允许开共享，已有任务共享控件禁用，旧草稿意图不上传；Backend 即使有账号也在 fetch 前拒绝非 GET 云请求。

Backend 在应用装配时 autoEnableProjects=true，为未绑定本机项目自动 create/space，沿用原项目/任务入口，保留既有隔离、持久投递、租约、失败重试；旧绑定被显式关闭时不覆盖，启动前历史不自动导入。后续首轮边界修补使用后端启动时刻作为新自动绑定的采集下界，避免首次 3 秒轮询前的新轮次被漏掉。原先任务 history/read/retry API 保留，但不再新增 UI。ADR-0011 取代上一轮 UI 与默认关闭决定。

## 模型实际配置（用户本机，不进 git）

用运行中的 Memmy /api/app/model-config GET/PUT 导入 env 模型，保留原模型，server 生成 preset ID，再选作 BYOK Agent、memorySummary、memoryEvolution 默认。模型为 deepseek-v4.1-flash-1017，正式目录连接测试通过；真实 chat completion HTTP 200、有效回答。Memory health 的 summary/evolution 已加载该模型，embedding 与存储仍为 local。未输出或保存密钥到仓库。

开发版已重启，模型选择仍保持，新 BFF 中云端 POST /api/collab/projects 实测 403 forbidden，未创建项目。最终首轮小修补已重编 Backend，最后一次重启在交付前完成。

## 验证

- Memory、Backend、Frontend typecheck 顺序执行通过（/tmp/pm-restore-*-tc.log）；Backend build 通过（/tmp/pm-restore-backend-build-final.log）。本轮无 Agent 源码改动。
- Backend：project-memory-service、collab-cloud-upload-lock、collab-service、project-memory-routes，4 文件 76 passed。
- Frontend：collab-share-toggle、project-settings-dialog、project-board-local、project-config-instructions、project-create-dialog、home-page、app-frame，7 文件 205 passed。
- 先失败：云端写锁、无需 UI 自动绑定、锁定任务共享均先失败再修正；自动绑定首轮反例 /tmp/pm-autobind-first-turn-before.log 首次失败，最终已通过。
- 真实 DeepSeek 接线冒烟：新临时库、真实 M02/M04、自动本机绑定、1 completed/1 topic、新会话词法召回命中“五次”。没有 embedding 或 M05 调用，无质量评分。见 metrics R-20261113-02，生成物在忽略的 runs/20261113-restore-ui/。
- 浏览器回看真实开发版原有布局，pageerror=0，新增开关/弹窗不存在；浏览器无 Electron preload，不能把此截图外推为原生 Agent WebSocket 连接测试。桌面后台/gateway 启动与模型 health 已检查，未在用户真实任务里发测试消息。
- 工作 diff-check 排除两个还原 CSS 的既有 EOF 空行后通过；两个 CSS 本轮严格恢复为 release 原内容，plain diff-check 的 blank-at-eof 为还原动作引入的既有上游空行，不重新格式化。

## 请 reviewer 重点看

恢复范围是否确实仅沿用 release 原前端；上传锁是否同时覆盖 UI/旧草稿/API；autoEnableProjects 是否漏首轮或导入旧历史；配置改动与验证是否真实且无密钥入 git。此前两个工作项的已批准算法修补不回退、不重新批准旧审计。
