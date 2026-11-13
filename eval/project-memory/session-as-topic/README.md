# 旧 session-as-topic 实验的隔离入口

2026-11-13 整理。源分支 `feat/superagent-session-as-topic`，固定快照 `65e61c7e5dd50f0e8c99097e6ce79eb947b85e56`，基线 `25ff3fff`。该提交已成为整合分支的祖先，克隆整合分支的完整历史后不依赖旧分支名称或原 worktree。

这条实验基于 v0.1：router 的 session 直接作为 topic，锁定组织目标；Search 直接选择 session，替换确定性召回。它与当前 M02/M04/M05、三路融合无法直接叠加。因此仅合并提交历史，当前运行目录保留新版实现，旧版通过固定快照隔离恢复。旧产品代码没有移植到 v2.1，也没有新增开关。

- [旧 ADR 原文](legacy-adr.md)：实验偏离 v3 的位置和模型失败语义。
- [旧评测记录](legacy-metrics.md)：v2 单次回放，不能作为整合分支当前效果。
- [整体整理说明](../../../docs/project-memory/experiment-consolidation.md)。

在仓库根运行（不调用模型）：

```sh
node eval/project-memory/session-as-topic/prepare-legacy.mjs --check
node eval/project-memory/session-as-topic/prepare-legacy.mjs --create /tmp/memmy-session-topic-v01
```

创建命令要求一个不存在的路径，不切换当前 checkout，不复制密钥、不安装依赖、不启动服务。恢复后的 worktree 带原实现、测试和 v2 数据（35 traces、23 道计分题）。安装依赖后按该 worktree 的 `docs/project-memory/metrics.md` 中 R-20261106-01 配置服务及回放；模型名和凭据须另行核对，历史记录不保证当前网关可用。

需要检查源码时：

```sh
git show 65e61c7e:Memory/src/service/project-memory/route/router.ts
git show 65e61c7e:Memory/src/service/project-memory/retrieve/search.ts
```

新数据集只在整合分支的当前路径使用。不要把 v2.1 拷入旧版后沿用历史分数。对旧版做 v2.1 对照、统一回答/裁判口径以及独立评审，均是后续工作。
