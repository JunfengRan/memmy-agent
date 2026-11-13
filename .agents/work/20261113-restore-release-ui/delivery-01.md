---
item: 20261113-restore-release-ui
role: developer
app: Codex
model: GPT-6
date: 2026-11-13
branch: dev-project-memory-add-search
head: 56e37160
status: done
---

# 交付：原前端恢复，本地接口接线与 DeepSeek 配置

新增独立记忆面板、按钮、开关、前端 client 和样式全部撤回。release 原看板/任务/设置布局保留，两份 CSS 与 release 字节一致。产品前端仅剩原入口的本地默认/云端上传锁接线与文案。

后端自动为未绑定的本机项目接入 Space，轮询前的第一轮不会漏采；不回填启动前历史。用户指定 DeepSeek 模型经 Memmy 正式接口保存为 Agent/摘要/演化默认；旧模型保留，存储与 embedding 为本地。目录连接、真实 chat completion、独立真实 M02/M04 整理及新会话检索通过，无密钥进 git。详见 metrics R-20261113-02。

独立评审 review-02 approved。Memory/Backend/Frontend 类型检查通过；自动绑定/协作回归 76、最终协作/协助锁回归 120、前端原交互回归 205 项通过。云端创建实测 403，写锁同时覆盖协助请求、进度和 promptContext。不是质量 benchmark，不外推完整模型质量。

最终开发版以 npm run dev:desktop 重启，保留用户配置与数据库。未推送远端。以前工作项记录保留为历史，其新增 UI 和默认关闭决定以 ADR-0011 及本交付替代；旧项目记忆审计状态不改。
