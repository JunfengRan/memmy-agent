# Jev 可能性探索交付记录

- 角色：designer；应用：Codex；精确模型型号不可见。
- 日期：2026-11-16。
- 交付：`design-docs/research/2026-11-16-Jev在项目记忆中的可能性.html`（用户指定本地文档；被 git 忽略，未强制加入版本控制）。
- 内容：当前 Add/Search 两处可选接入；协议实验不等于原生 Jev；50 个判断点（15 个 V4、12 个 Add 细化扩展、15 个 Search/注入、8 个治理）；每项有输入、动作、边界、指标；6 组优先实验。
- 状态：研究稿可供评审讨论，不是设计裁决；未修改产品代码、standard、提示词、Roadmap，未运行付费模型评测，未提交现有工作区代码。

## 核对与验证

- HEAD `7f4257b9c26b7fb2c947c678767ecb3d1e784e3f`，分支 `dev-project-memory-add-search`；另含其他任务未提交 V4 改动，正文已说明。
- standard V4 SHA 前缀 `1e2e0db92f92`；代码组织设计 `fdc115eac3c6`，与规格快照一致。
- 读取源代码、ADR、专项脚本、会话消融脚本及保存结果；专项历史分数来自 metrics，未作为本次重跑结果。
- HTML 结构校验、2 张 SVG 浏览器测量校验、设计 token 校验通过。
- `/Users/junfengran/memtensor` 下 `npm test` 通过（模板与校验门禁）。
- Playwright 使用本机 Chrome 检查 1440px、820px、深浅配色、目录锚点；28 个正文文件链接均存在，无 JS pageerror，无窄屏整页横向溢出。截图查看并修复了生成器 figure 重复包装。
- 没有产品代码变更，因此未运行 Memory typecheck、Vitest 或产品端到端测试；没有把文档验证写成产品质量结论。

## 后续讨论

先以同候选／同预算分离模型与协议收益；原生 Jev 接口、中文能力、概率校准、成本和延迟均待实测。不得把探索清单当成当前 V4 过渡实施任务。
