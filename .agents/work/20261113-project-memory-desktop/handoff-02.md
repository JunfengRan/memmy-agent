---
item: 20261113-project-memory-desktop
seq: 02
role: developer
app: Codex
model: GPT-6
date: 2026-11-13
branch: dev-project-memory-add-search
base: 2481e6ae
head: 32b789ec
to: reviewer
status: ready-for-review
---

# 交接 02：回应独立评审

## 结论与改动

32b789ec 修复两项 MUST，收回锁内网络等待的 SHOULD。配置补齐后原批次可新建任务；失败/中断回复不整理。投递请求保留稳定时间与内容，网络在锁外，短事务认领/回写以 lease token 围栏保护，单轮最多 4 个任务，单次 HTTP 最多 60 秒。关闭不再排在整个 backlog 后；已经开始的请求可以完成，回写不覆盖开关。后台停止会等待当前采集结束。

## 评审回应

| 意见 | developer 回应 |
| --- | --- |
| R1-1 MUST | 已修复（32b789ec）。识别真实 assistant.model_error 与恢复占位文本并丢弃整轮，回归覆盖普通失败、中断以及此前已有工具步骤。 |
| R1-2 MUST | 已修复（32b789ec）。MODEL_NOT_CONFIGURED 加入可重提原因，Space/domain 不可重试语义不变；不伪造新时间。真实 MemoryService 先因未配置失败，再恢复同一个 LLM 的配置，同消息拿到新 task 并完成。先失败证据 /tmp/pm-model-config-retry-before.log（second===first），修后 /tmp/pm-model-config-retry-after.log 13/13 passed。 |
| R1-3 SHOULD | 已修复（32b789ec）。HTTP 移到全局配置锁外；每轮至多 4 个任务，逐个持久化 5 分钟认领租约，避免双后端重复投递。回写只更新 token 仍匹配的任务。悬挂 add 请求时 peer.tick 不重复认领、peer.configure(false) 可及时完成；迟到响应后仍保持 disabled。 |
| R1-4 SHOULD | 本轮不改文件布局：避免在已验证接线末尾引入跨文件一致性与旧投递记录迁移。已在 Roadmap 记录大历史规模未验收；同步读完整 journal 的限制保留。建议后续拆出只读小绑定投影或独立 journal，并验证规模与延迟。此限制不作为已解决声明。 |

## 验证

- Memory 与 Backend typecheck 在本轮修补时通过（/tmp/pm-final-fixes-memory-tc.log、/tmp/pm-final-fixes-backend-tc.log）；随后只补 shutdown 等待 activeTick、第三种失败格式回归及文档，请 reviewer 重跑最终类型检查。
- Memory task-resubmit：1 文件，13 passed（原 12 项 + 配置恢复）。
- Backend project-memory-service、project-memory-routes、http-memory-client：3 文件，44 passed（/tmp/pm-final-fixes-backend-tests2.log）。新增失败格式和慢请求期间关闭/双后端认领回归。
- 其余交接 01 的 Agent 185、Frontend 30 和 release 合并验证保持不变，本轮没有改 Agent/Frontend。
- git diff --check 通过。没有提示词/算法质量变化，无付费评测；HTTP/Chrome 与迁移证据仍见 R-20261113-01。

## 请 reviewer 重点复核

关闭与在途请求：只允许开始的投递完成，下一次认领必须见到 enabled；回写不复活删除绑定或覆盖关闭开关。跨后端认领由持久 lease token 保护，进程崩溃后租约到期重试仍提交原消息。请逐条关闭 R1-1/R1-2，确认 R1-3 修补无新竞态；R1-4 已按建议明确保留边界，不自行标 approved。
