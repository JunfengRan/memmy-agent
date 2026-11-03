# ADR-0002：项目记忆在独立模块重写

- 日期：2026-11-03
- 状态：已采纳
- 规格出处：v3 §1.3、§5.1、§5.3、§5.4

## 背景

此前的实现（commit 56cae326 等）把项目记忆写成 `memories` 表里 `kind=work_memory` 的行：

- 普通召回的候选池会把这些行当作 L1 Work Memory 注入；
- 数据挂在 `userId[0]` 名下，`visibility=private`；
- 没有 Topic 实体、history、conflicts、revision 和 OCC；
- add 在请求内同步调用模型，返回的 task_id 不可查询；
- 逻辑全部写在 `memory-service.ts`。

## 决定

在 `Memory/src/service/project-memory/` 按 v3 模块重写，使用 v3 §5.3 的独立表，经 `ProjectMemoryStore` 访问存储，接口挂在 `/api/openmem/v1/`。旧实现在新链路可用后删除，包括 `/api/v1/memory/*` 上的 project 分支、`types.ts` 中的旧类型和 `topic-skill.ts`。

## 影响

- 旧的评测回放脚本不能再用，评测 runner 改为调用规格接口（见 ADR-0004）。
- `memory-service.ts` 和 `http.ts` 只保留薄委托。

## 替代方案

在旧实现上增量添加 Topic 和 OCC：改动小，但表结构与 v3 长期不一致，且召回污染问题要另外处理。不采用。
