---
item: 20261113-restore-release-ui
seq: 02
role: developer
app: Codex
model: GPT-6
date: 2026-11-13
branch: dev-project-memory-add-search
base: 80798cf0
head: 56e37160
to: reviewer
status: ready-for-review
---

# 修补协助通道漏锁

## 评审回应

R1-1 MUST 已修复（56e37160）：index.ts 只创建一份带 PROJECT_CLOUD_UPLOAD_ENABLED=false 的 collabCloud，传给 CollabService.cloudRequest 和 CollabAssistService.cloud。项目服务不再另建生产 transport，协助服务不再漏传写锁。GET 原有只读请求可用，非 GET 在 fetch 之前拒绝。

新回归将同一个锁定 transport 注入真实两类 service：有账号情况下 createProject 和 assist.createRequest 均被拒绝；带私密合成 promptContext 的 progress/execution/reply 写入也被拒绝，fetch 调用为 0。原单测覆盖 POST/PUT/PATCH/DELETE；原协作/协助的独立库逻辑仍可回归。

## 验证

- npm --prefix Memory run typecheck：通过。
- npm --prefix App/backend run typecheck：通过。
- Backend collab-cloud-upload-lock、collab-assist-service、collab-service：3 文件，120 passed（/tmp/pm-restore-assist-lock-tests.log）。
- 第一轮的 Frontend 205、Backend 自动绑定/首轮/历史边界 76 项仍有效，本轮未动前端与自动绑定实现。
- 真实模型配置、推理与整理召回仍见 R-20261113-02；本轮未重跑模型效果，不改提示词。
- 修补差异 git diff --check 通过。原 CSS 的 release EOF 空行保留说明同第一轮。

请 reviewer 复核唯一生产 transport 的两个服务注入与拒绝点。最后一次开发版重启将在本轮独立复核完成后进行，避免构建互相影响。
