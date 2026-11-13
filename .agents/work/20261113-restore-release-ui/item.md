---
id: 20261113-restore-release-ui
status: done
owner: developer / 已收尾
branch: dev-project-memory-add-search
updated: 2026-11-13
---

# 恢复 release 原有前端，仅保留本机接口接线

用户纠正：上一轮新增界面不符合要求，恢复 release/v1.2.7 的原有项目/任务前端；仅调整接口接线，本地为默认，锁定上传云端。并通过 Memmy 正式模型配置接口配置 ~/.deepseek.env 的模型，真实验证；不记录密钥。

验收：撤掉新增记忆弹窗/按钮/开关及样式，原看板和设置布局恢复；新建本机项目由后端自动绑定记忆；云端上传在 UI 与服务端均锁定；原项目、任务和对话功能回归通过；模型目录与真实推理校验通过。

既有 20261113-project-memory-desktop 的记录保留，以本次修正替代其中新增 UI 与默认关闭的体验决定；核心算法、已修补租约/重试/隔离不回退。

2026-11-13：独立 reviewer / Codex 完成 review-01：1 MUST（协助 transport 漏上传锁），前端恢复与自动绑定边界通过复核，交 developer 修补。

2026-11-13：developer 修复 R1-1，共用锁定 transport（56e37160），交 handoff-02 复核。

2026-11-13：独立 reviewer / Codex 完成 review-02：唯一 MUST R1-1 已关闭，统一 transport 云写锁与 120 项相关回归通过；工作项 approved，交 developer 最终重启和收尾。

2026-11-13：review-02 独立批准 56e37160；developer 收尾。原始前端与样式恢复，本机接口接线与上传锁生效；真实模型配置不进 git。
