---
item: 20261113-codex-memmy-project-bridge
role: developer
app: Codex
model: GPT-6
date: 2026-11-13
branch: dev-project-memory-add-search
base: a42c1443
head: b7cb8c56
to: reviewer
---

# 代码交接；真实双端实验仍在进行

## 结论

Codex 原生 hook 已通过 Backend 项目绑定向 chat 同一 Space 入队；每轮 recall 与 CLI 查询按真实目录解析范围。Memmy 原前端和云端写锁未修改。真实双端读取尚待后台任务整理，因此此交接不宣称最终验收通过。

## 改动

Backend project-memory-service 增加 workspace recall/capture：canonical realpath最长祖先匹配，歧义/禁用/缺失关闭访问；完整owner/Space迟到检查。外部轮次原始时间、source=codex、成功问答经持久化journal去重与既有OpenMem队列。新增BFF接口保持runtime token鉴权、严格字段白名单。HTTP Memory client允许search/memory。

两份hook/runtime追加项目记忆，个人L1与项目提交相互独立；修复原App模板中项目指令的提前返回。使用现有M10 renderer（Backend副本有源一致性检查）。CLI未给Space时按cwd走BFF，tool/turn_start分别记录。设计见ADR-0012。

## 验证

- npm --prefix Memory run typecheck：通过（两轮，包括新增bridge）。
- npm --prefix App/backend run typecheck：通过（最终记录 /tmp/pm-cross-backend-final-check.log）。
- cd Memory && npx vitest run tests/local-project-bridge.test.ts tests/cli-command-map.test.ts：46通过。
- cd App/backend && npx vitest run src/services/tests/project-memory-service.test.ts src/adapters/inbound/local-api/tests/project-memory-routes.test.ts src/adapters/outbound/memory-client/tests/http-memory-client.test.ts src/adapters/outbound/skill-writer/templates/tests/memmy-resume-hook.test.ts：66通过。
- git diff --check通过。未改产品提示词/算法，未跑质量benchmark。

## 预审回应

| 意见 | 回应 |
| --- | --- |
| 慢搜索后owner映射可能改变 | 完整比较重新解析的owner.id/spaceId；新增父搜索期间注册子项目的回归；capture进入mutate后也重新解析 |
| offset时间破坏持久journal校验 | MessageSchema允许offset，新增capture→新服务实例view/tick回归，保留原字符串 |
| CLI fallback错误登记turn_start | BFF受限recallVia，CLI tool，hook turn_start；CLI领域/数量转发回归 |

## 本机实验当前证据

chat目录 /Users/junfengran/chat，本机项目 d1cc73f1-46fc-468d-98f8-957781a7689e，Space space_f641ecf022091925。

Memmy通过真实WS正常用户消息协议（webui target project + client_request_id）生成完整回复，session websocket:8ee5115d-5734-4140-8f44-56eb6f91e6cf，journal a7a0580afe2982bd69eb8411eee4e6ac59468d10562baef9cc5276e179b0ca7e，task_7dab4c4cd983f75f854a。验证约定青鹭信标→晨雾七桥。

Codex exec -C /Users/junfengran/chat实际新会话 01a1d392-7f5e-7962-8027-0bf0162a540f，真实原生Stop提交，journal b5d9147e8691b5e3e0b664c06bfd2751d873fe170e67cdcbd710c49eec9ab5b9，task_c57f758ea546c737dd9c。验证约定银杉航标→晚星九渡。两者目前等待真实后台整理，稍后追加delivery记录，不能据此认定跨端召回成功。

已修本机embedding环境：进程显式模型root原目录不存在，将node_modules/electron/dist/Electron.app/Contents/Resources/embedding-models指向 ~/.memmy/eval-models 同款现存离线模型。真实向量API200、384维finite；未更改模型、数据库或调度priority。缓存修复后积压旧workmemory正在消化。

## 边界与重点复核

Backend入队前的网络失败只记录错误，没有hook持久outbox；需桌面Backend和Memory运行。入队后的持久重试沿用现有服务。没有自动导入历史Codex会话。临时实验脚本及结果在忽略目录eval/project-memory/runs/20261113-cross-host/，凭据不进git。

请复核workspace隔离、hook生命周期/失败、时间和幂等，以及实际双端证据追加后是否达成验收。
