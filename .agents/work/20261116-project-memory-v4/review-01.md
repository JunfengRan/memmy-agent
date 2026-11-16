---
item: 20261116-project-memory-v4
seq: 01
role: reviewer
app: Codex / independent sub-agent
model: GPT-6
date: 2026-11-16
reviewed: item.md、ADR-0013、当前工作区实现与针对性测试
range: 7f4257b9..working-tree
status: pending-final-evidence
code_review: no-open-must
---

# 评审 01：代码层无未关闭 MUST，等待最终交付证据

本 reviewer 未参与实现，只读审查了相对 `7f4257b9` 的工作区改动，并亲自运行下列检查。检查范围包括管线与存储/模型边界、受理原子性、召回记录退役、真实会话告知、部分裁决、Agent 历史复述和模板生成。

当前代码层无未关闭 MUST。代码尚未提交，本记录不是正式 `approved` 交接，也未修改工作项状态。正式结论仍需绑定最终提交范围，并补齐最终真实模型和端到端证据。

## 发现与修复复核

| 编号 | 级别 | 位置 | 发现与依据 | 修复复核 |
| --- | --- | --- | --- | --- |
| R1-1 | MUST，已关闭 | `Memory/src/service/project-memory/merge/judge.ts`、`merge/merge.ts` | M05 原来只能表达与当前/冲突相同，无法表达语义上复述历史版本；非逐字 Agent 历史复述可能进入改写或冲突。违反本轮 V4 历史复述丢弃目标。 | 新增 `same_history_as`，仅绑定目标主题真实历史条目，将内容快照传入合并并核验；`delegated` 复述不会写回，伪造历史引用不能授权。已读修复并重跑对应测试。 |
| R1-2 | MUST，已关闭 | `Memory/src/service/project-memory/merge/merge.ts` | 部分 `resolve target=new` 的作者若属于未告知项，会同时出现在新当前结论和保留冲突中；无来源 split 使用 resolver 时也有同类风险。已直接调用纯应用函数复现，违反单成员单结论规则。 | 生产管线对此安全暂缓，保留用户意图为 `partial_resolution_membership_conflict`，不修改或归档未告知项。已复核分支及正反例。旧内部 ChangeSet 的兼容应用不被当作生产授权入口。 |
| R1-3 | MUST，已关闭 | `Memory/src/service/project-memory/organize/evidence.ts`、`merge/judge.ts`、`merge/merge.ts` | 确定性补齐使用的旧比较器删除所有标点/符号；已实测 `timeout>=30` 与 `timeout<=30` 均变为 `timeout30`，会让相反规则被视为已告知。 | 新 `evidenceText` 仅 trim/归一化空白，保留符号、大小写和标点；处理目标的内容快照以严格相等复核。比较符号反例已通过。 |

开发者真实回放发现的两项后续修复也已独立复核：

- M05 漏标已明确逐字告知的原当前结论：先从真实、时间更早的引文中严格匹配全部当前项，再合并模型语义标签；不把未列出的项加入处理集合。已检查上述 R1-3 的专用比较器及漏标签回归。
- M02 已明确裁决、M05 已绑定 `sameAs`，但遗漏冗余 `resolve` 标签：仅在已有告知、非迟交且无 split 的条件下，使用经过 M05 绑定的 `sameAs` 兜底。不会推断 `new`；没有裁决信号仍按原有加入逻辑处理。最后两文件回归 23 项全部通过。

## 亲自运行的检查

以下测试批次有重叠，不能累计为独立用例总数。

| 命令与工作目录 | 实际结果 |
| --- | --- |
| `cd Memory && MEMMY_LOG_LEVEL=error npx vitest run tests/service/project-memory/conversation-evidence.test.ts tests/service/project-memory/decision-golden.test.ts tests/service/project-memory/accept.test.ts tests/service/project-memory/vector-index.test.ts tests/service/project-memory/v4-merge.test.ts --silent --reporter=dot` | 首次复核：5 文件，43 passed、1 个既有 todo。 |
| 上述命令加 `tests/local-project-bridge.test.ts` | 最终严格比较补丁后：6 文件，52 passed、1 个既有 todo。较早一次运行碰到代码与 fixture 正在更新，1 项失败；fixture 更新后重跑通过，没有将中间失败隐去。 |
| `cd Memory && MEMMY_LOG_LEVEL=error npx vitest run tests/service/project-memory/v4-merge.test.ts tests/service/project-memory/conversation-evidence.test.ts --silent --reporter=dot` | 最后 `sameAs` 裁决兜底补丁后：2 文件，23 passed。 |
| 仓库根 `npx tsc -p Memory/tsconfig.json --noEmit` | 通过；执行于严格比较补丁之后、最后裁决兜底补丁之前。最终提交的全套类型检查由 developer 再记录。 |
| 仓库根 `node scripts/project-memory/sync-injection-assets.mjs --check` | 通过。 |
| 仓库根 `git diff --check` | 多次检查通过，包含最后裁决兜底补丁。 |

另只读核对：运行时代码已无 `appendRecallLog`、`recalledIds`、`conflictedDecisionsShown`、`conflictsShown`、`informedDecisionIds` 引用；旧表留存与原队列 payload 兼容。同步受理中消息、任务和所有 Space 入队处于同一事务；SQLite 索引原语不调用模型，向量化包装层保留内容哈希校验、模型变化检查与词法降级。两份 hook 的模板来自同一源码，生成检查通过。

## 验收边界

- 本记录只对当前工作区和实际运行检查负责，不以其他 Agent 的报告替代亲自验证。
- 独立 reviewer 未运行真实模型评测，也未核验 developer 正在执行的 final3 结果；以最终 metrics、原始生成物和交接为准。
- 本轮专项回归不能外推完整 v2.1 benchmark 达标、所有自动检索都成功，或全部宿主离线补交能力已验收。
- 未进行原生 UI 点击、正式安装/发布或云端部署验收；保留本机过渡部署不等于完成纯云端 V4。
- 最终代码提交、最终类型/回归检查、真实模型及原生双端证据齐备后，应再次核对提交范围，再决定正式批准状态。
