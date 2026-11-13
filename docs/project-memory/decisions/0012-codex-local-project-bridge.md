# ADR-0012：Codex 与 Memmy 共用本机项目绑定

- 日期：2026-11-13
- 状态：已采纳（用户明确要求 chat 双端互通）
- 依据：v3 §2.2.1–2.2.2、§3.1–3.4，ADR-0011；补充 Q-32 的本机目录绑定。

## 决定

Codex 的 UserPromptSubmit 与 Stop 使用现有本机 Backend runtime token 访问项目 recall/capture 接口。Backend 根据真实工作目录与有效本机项目目录的祖先关系选择最长匹配；重复目录歧义、目录不存在、未绑定或已禁用时关闭访问。禁用的更具体项目不能回落到父项目。项目 Space 和 owner 只由 Backend 取得，不接受外部宿主提供 Space/user 参数。

读取沿用 OpenMem search/memory 与已有 M10 模板；只检索 project 视图，不将个人 L1 和 L3 世界模型当作项目记忆。完成轮次来自原生 SourceTurn，保留消息时间，使用 codex:<native conversation id> 与 agent_id=codex。只投递成功且有真实问答的轮次；同一 Space/会话/原始消息的重复提交在持久化 journal 去重，然后复用既有后台整理与失败重试。采集故障不阻塞宿主完成，个人记忆和项目记忆独立提交。

CLI project search 未显式指定 Space 时按 --cwd 或当前目录调用同一 Backend；显式 --space-id/MEMMY_PROJECT_SPACE_IDS 能力保留。不开启全局 Space 环境变量，避免不同项目串记忆。服务必须运行在本机；本轮只接 Codex，不声称其他外部宿主已支持。

## 边界

不修改 release 前端、云端上传锁、整理提示词或算法。不自动回填历史 Codex 会话。此桥接需要 Memmy 桌面 Backend 与 Memory 服务运行；hook 失败会降级继续聊天，不能将服务离线时的未投递轮次声称为已保存。已入 Backend journal 的任务沿用现有持久化恢复与重试机制。
