---
item: 20261113-project-memory-desktop
role: developer
app: Codex
model: GPT-6
date: 2026-11-13
branch: dev-project-memory-add-search
head: 32b789ec
status: done
---

# 本地交付

- 本地 main：upstream/main e640129a；release/v1.2.7：upstream 同名分支 ffe73628。
- 原 dev-project-memory-add-search-dev 保持 a32c5fd0；新 dev-project-memory-add-search 包含完整 release 合并 baa469c5、应用接入 2481e6ae、修补 32b789ec。
- 独立 reviewer 第二轮 approved（review-02）。PM-28 收尾为 done；20261112 审计状态未改。R1-4 原始投递记录与绑定同文件、大历史规模读取性能尚未验收的限制保留。
- 四侧类型检查和相关回归通过；最终 reviewer 重跑 Memory 39 项、Backend 44 项；其余 Agent 185 项、Frontend 30 项见 handoff-01/review-01。
- 32b789ec 真实 Memory HTTP/BFF/Chrome/Agent 集成闭环重新验证通过；截图已视检。模型和向量使用桩，未跑付费质量评测，未打包或安装 Electron。迁移从原始 v10/v15 源码生成的独立数据库升级16通过。见 metrics R-20261113-01。
- 临时 Memory/BFF/Vite/浏览器验证进程与临时 HTML 已清理，生成物留在忽略的 runs 中；未修改日常应用配置和数据库。
- 本次只提交本地分支，没有 push、PR 或改写远端 main。

## 体验入口

在仓库根运行 `npm run dev:desktop`，用开发版项目设置里的“启用本机项目记忆”开启，再从项目看板“项目记忆”打开主题与导入入口。需要 Memory 的整理模型配置可用；未配置会显示失败，配置补齐后可点“重试失败任务”。新轮次按已保存会话后台采集，历史不会自动导入。
