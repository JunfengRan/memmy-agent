---
id: 20261116-project-memory-v4
status: done
owner: developer / Codex（独立 review-02 approved，待收尾）
branch: dev-project-memory-add-search
base: 7f4257b9
updated: 2026-11-16
---

# V4 边界重构与召回记录退役

用户确认：只改 memmy-agent，保留本机闭环、已有数据和 Codex ↔ Memmy 互通；去掉召回记录，其他算法保持，不引入 Jev 或云端迁移。规格为 standard v4（1e2e0db92f92）及代码组织设计（fdc115eac3c6）。

验收：存储/模型/管线边界解耦；注入唯一维护源；运行时不读写召回记录；按会话真实告知逐项裁决且保留未告知冲突；Agent 未采纳复述不写回；旧数据、绑定、投递恢复和宿主链路回归；类型检查、质量验证、文档和证据如实登记。独立复核前不标 approved。

## 收尾状态

2026-11-16：实现与相关文档已完成。正式类型检查三处通过；相关回归476项通过、1项既有todo；真实模型专项8/8、隔离双端适配6/6、旧数据库副本兼容5/5。独立reviewer代码层MUST已关闭；原生UI/安装hook事件、v2.1全量评分与V4云端迁移不在本次已验证结果中。最终提交范围待正式review，未自标approved。

2026-11-16：独立 reviewer / Codex 正式绑定 7f4257b9..279d39b2，复核交接 efe0fc33 与原始 JSON/SQLite，亲自重跑 476 项全部通过（另 1 个既有 todo）。R1-1～R1-3 MUST 全部关闭；R2-1 描述滞后接受本轮保留并登记，review-02 approved，交 developer 收尾。批准范围不外推原生 UI、全量质量或云端部署。

2026-11-16：独立review-02已绑定7f4257b9..279d39b2并approved，亲自重跑476项通过/1既有todo，核验真实专项8/8、适配双端6/6及旧库5/5。developer据此收尾为done。R2-1描述滞后接受并登记后续质量改进，不表示全量V4或原生UI验收完成；未推送。
