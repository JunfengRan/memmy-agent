# AGENTS.md

本文件对所有编码 Agent（Claude Code、Codex、Cursor）生效。`CLAUDE.md` 通过 `@AGENTS.md` 引用本文件，规则只在这里维护。

## 多 Agent 协作（必读）

本项目由不同应用里的多个 Agent 以 designer / developer / reviewer 角色接力完成，彼此只通过仓库文件交接。**开工前先读 [.agents/README.md](.agents/README.md)**，按 [.agents/protocol.md](.agents/protocol.md) 在 `.agents/work/<id>/` 读写交接记录：developer 用 `agent-handoff` 技能交给 reviewer 或下一个 developer，reviewer 用 `agent-review` 技能给出 MUST / SHOULD / NIT 意见，designer 通过架构文档、ADR 或 `design-NN.md` 裁决。

## 全仓约定

- 改完代码先跑相关检查：`npm --prefix Memory run typecheck`，再用 `npx vitest run <path>` 跑受影响的测试。全量测试是 `npm test`。
- 提交信息用英文 Conventional Commits（`feat:`、`fix:`、`docs:`、`test:`），可带 scope，如 `feat(project-memory): ...`。小写祈使句，正文写为什么。
- 不提交密钥、`.env`、本地数据库和评测生成物。
- 工作说明、计划和评审稿写中文；代码、标识符和提交信息写英文。

## 项目记忆开发（`Memory/src/service/project-memory/`）

细则见 [docs/project-memory/DEVELOPMENT.md](docs/project-memory/DEVELOPMENT.md)，计划见 [docs/project-memory/ROADMAP.md](docs/project-memory/ROADMAP.md)。

### 权威顺序

1. `design-docs/standard/` 中最新版的架构文档（当前是《项目记忆：端云协同架构与模块设计（v3）》）。
2. 《MemOS SDK接口规格》。
3. 《MemOS 项目记忆PRD》。

冲突时按上面的顺序取舍，并在 [docs/project-memory/spec-alignment.md](docs/project-memory/spec-alignment.md) 登记差异，不能私自选择。`design-docs/` 不进 git，其中 `standard/` 是钉钉文档的本地镜像；代码对齐的是哪个版本，以 [spec-snapshots.md](docs/project-memory/spec-snapshots.md) 为准。规格有变化时先跑 `pm-spec-sync` 技能。`standard/` 里的《MemOS 3.0 项目记忆研发计划》只定范围和排期，不参加上面的取舍。

**规格只有 `design-docs/standard/` 这一个来源。** `design-docs/` 下的其他目录都不是事实源，目录说明见 `design-docs/README.md`：

- `alpha/`、`claude/`、`codex/` 是 v3 之前的历史方案，已被取代。其中现行规格没有采纳的设计不算缺口，例如项目目录下的 `.memos/`、DB 与文件同步、`search` / `get` / `expand`、`ProjectSnapshot`。
- `review/` 是对 `standard/` 的评审意见，答复写进 `standard/` 或 ADR 之前不算已定。
- 判断实现缺口、写对齐表、open-questions 和评审意见时只引用 `standard/` 与 ADR。只有用户明确要求时才读历史方案，引用时写明「历史方案」，不要和 `standard/` 并列成几套事实源。

### 模块边界

- 项目记忆代码只放在 `Memory/src/service/project-memory/`，按 v3 模块分目录：`contract/`、`store/`、`organize/`、`merge/`、`pipeline/`、`retrieve/`、`inject/`、`prompts/`。另有 `decisions/`，放默认关闭的主题选择实验（ADR-0006），不属于 v3 模块。
- `memory-service.ts` 和 `server/http.ts` 只做薄委托，不写项目记忆逻辑。
- 不复用 `memories` 表和 `work_memory` kind。项目记忆有自己的表（v3 §5.3）。
- 存储一律经过 `ProjectMemoryStore`，按 `capabilities()` 分支，不写 `if (mode === ...)`（v3 §5.1）。
- 新接口挂在 `/api/openmem/v1/` 下，路径与云端同名（v3 §1.6）。

### 算法红线（v3）

- 不做模型重排；排序只用确定性信号，同样输入必须得到同样输出（§6.1 #9）。
- 模型调用只出现在 M02、M04、M05；存储层和云端不调模型。唯一例外是 `decisions/` 的实验，只在 `MEMMY_DECISION_TOPIC=1` 时调用，不能设为默认。
- 归类失败不保守新建主题（§2.2.7）；原因只取自会话，不推断。
- `domain` 由调用方指定，MemOS 不判定领域（§6.1 #12）。
- 延迟提交的内容不得改写时间更晚的决策；非作者且未经认可的不同结论只能进 `conflicts`（§2.2.9）。
- `history` 只追加；清空 `conflicts` 必须在同一事务里写 `history`。
- OCC 冲突后重新合并，不重放旧 ChangeSet，最多 3 次（§2.2.10、§2.3.1）。

### 提示词与技能

- 共享技能只维护一份，放在 `.agents/skills/`（`agent-handoff`、`agent-review`、`pm-spec-sync`、`pm-dev-loop`、`pm-eval`、`pm-weekly-review`）。`.cursor/skills/`、`.claude/skills/`、`.codex/skills/` 是指向它的符号链接，不要在那里直接改。
- 产品提示词放在 `project-memory/prompts/`，每个文件导出版本号。改提示词必须升版本，并在 [metrics.md](docs/project-memory/metrics.md) 追加一次评测。
- 示例不得取自评测集的领域（ledger、catalog 等），避免泄漏金标。

### 评测卫生

- 产品契约里不加评测专用字段（如 trace id、`generate_answer`）。
- 评测生成物写到 `eval/project-memory/runs/`（已忽略），只把指标摘要写进 `metrics.md`。
- 评委模型与被测模型不同家族，温度 0。
- `dev-project-memory-search-gold-baseline` 是同事在用的数据集分支，未经用户确认不要推送或改写。

### 测试

- 单测放在 `Memory/tests/service/project-memory/`。v3 和 PRD 里的逐轮示例表要做成 golden 用例。
- LLM 用 `vi.stubGlobal("fetch")` 打桩，参照 `Memory/tests/fixtures/memory-service-fixture.ts`。

### 文档随代码

- 改变行为的提交同步更新 `spec-alignment.md` 和 `ROADMAP.md` 的条目状态。
- 改契约、表结构或已定决策时写 ADR（`docs/project-memory/decisions/`），ADR 只追加。
- 每周五跑 `pm-weekly-review` 技能，产出周报并修订 Roadmap。

### 云端测试

只通过 ssh 别名（如 `jump`）连接测试机，凭据和地址细节不写进仓库。
