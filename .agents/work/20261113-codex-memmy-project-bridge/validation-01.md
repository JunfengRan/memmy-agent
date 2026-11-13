---
item: 20261113-codex-memmy-project-bridge
role: developer
app: Codex
model: GPT-6
date: 2026-11-13
branch: dev-project-memory-add-search
head: b7cb8c56
status: ready-for-review
---

# 真实双端验证完成

## 配置与运行

Codex app list_projects 确认 chat 项目 daf2a9e9-016b-4777-b651-c4d1e683166b 指向 /Users/junfengran/chat；Memmy chat 本机项目 d1cc73f1-46fc-468d-98f8-957781a7689e 同目录，Space space_f641ecf022091925。

通过 App Backend 正式 createCodexSkillTarget().installPlugin 安装hook与核验信任，没有跳过trust。~/.local/bin/memmy-memory 链接当前Memory构建CLI。Memmy沿用DeepSeek Agent/摘要/演化配置；项目存储仍本机，实际云端创建403。

本地embedding root修复并经真实384维向量请求验证。本轮优雅重启Memory，配置MEMMY_EMBEDDING_MODEL_ROOT指向已有 ~/.memmy/eval-models，本地模型/embedding请求并发3；当前Memory PID68063，桌面开发进程保持运行。未更改调度priority、算法、模型提示词、数据库内容或记录状态；后台任务自己领取并完成。服务重启期间journal曾因网络中断变failed，已通过正式retry API恢复，两个验证任务最终completed/error=null。

## Memmy → Codex

- 写入：原生Memmy聊天WS用户协议，websocket:8ee5115d-5734-4140-8f44-56eb6f91e6cf，明确约定「青鹭信标→晨雾七桥」。Agent真实回复，Backend自动采集，无手动add灌库。
- 整理：task_7dab4c4cd983f75f854a / job_60e98f312020f7803397 于06:32:33Z成功，attempt1。
- 主题：topic_fb371750689945a3；get_memory_by_id来源为agent_id=memmy、上述websocket会话。
- 读取：全新原生Codex会话01a1d39b-d09f-7991-b100-712b0c82b57b，工作目录chat，不调用工具或读文件，正确回答「晨雾七桥」。
- 注入证据：该Codex真实rollout的非assistant response_item中含完整 `<memos_context v="1" kind="turn">` 闭合块，400字符，包含青鹭主题及暗号（不是仅检查用户问题里的标签字面量）。pm_recall_log记录该会话via=turn_start、topic_fb371750689945a3。

## Codex → Memmy

- 写入：原生Codex会话01a1d392-7f5e-7962-8027-0bf0162a540f，明确约定「银杉航标→晚星九渡」，真实Stop hook提交。
- 整理：task_c57f758ea546c737dd9c / job_77ba9eb9ffa1726961d7 于06:33:04Z成功，attempt1。
- 主题：topic_1e40631ead3e4352；get_memory_by_id来源为agent_id=codex、codex:01a1d392-7f5e-7962-8027-0bf0162a540f。
- 自动读取：全新Memmy会话websocket:7fc09af1-2a94-4414-a809-dde42bf0cce0正确回答「晚星九渡」，依据项目索引。该轮个人L1召回超时，故未将此轮描述为每轮项目search成功。
- 工具读取：另一个全新Memmy会话websocket:99082023-5956-4a42-9886-01b0df18d5e0真实调用search_project_memory；保存JSONL里role=tool内容含 `<memos_context v="1" kind="tool">` 和银杉决策；后续finish_reason=stop的assistant正确回答「晚星九渡」。pm_recall_log记录该会话via=tool、topic_1e40631ead3e4352。
- 工具回复中模型把Space标签称为主题ID，实际topic ID以OpenMem详情为准；不将模型口述ID当作后端事实。

## 隔离、幂等和边界

- chat验证主题已存在后，对ledger/catalog两个既有项目的BFF project-only同词检索均不含两条验证暗号；未绑定的memmy-agent目录bound=false。
- 通过官方readCodexSourceTurn读取原native完成轮次，再提交capture，返回同一journal ID b5d9147e8691b5e3e0b664c06bfd2751d873fe170e67cdcbd710c49eec9ab5b9，没有新增投递。
- 单测覆盖关闭、子项目覆盖/迟到响应、offset重启、鉴权及拒绝Space/user覆盖。
- 第一轮Memmy跨端答题曾只命中个人L1，本次未计为项目记忆成功；Codex早期实际答「尚未召回」。最终结果以上述主题来源、项目注入块和工具记录为依据。
- 历史队列积压使首次整理等待较久；不能承诺即时整理。Memmy的个人召回若耗尽既有共享交互预算，每轮项目search仍按既有保护跳过；项目索引和显式工具已真实验证。
- Computer use读窗口超时，本轮使用真实宿主聊天协议、原生Codex CLI、原生完成文件与召回日志验证，没有声称完成UI点击验收。
- Backend离线前的capture没有持久outbox；需保持本机服务运行。已入队任务有持久恢复/重试。

实验文件为忽略目录eval/project-memory/runs/20261113-cross-host/；其中source-a/b.json、codex-injection-evidence.json、memmy-tool-evidence.json可交叉核对。配置说明已写 /Users/junfengran/chat/docs/memmy-project-memory-setup.md。无密钥或用户完整聊天写入git。
