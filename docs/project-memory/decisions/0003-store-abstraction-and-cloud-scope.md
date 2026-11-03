# ADR-0003：Store 抽象与本期云端范围

- 日期：2026-11-03
- 状态：已采纳
- 规格出处：v3 §5.1、§5.2、§6.1 #2

## 背景

v3 规定所有加工在本机完成，只在存储层区分 SQLite 和云端存储服务。云端存储服务（C01–C04）由后端实现，不在本仓库。

## 决定

- 11/27 前完成 SQLite 版 `ProjectMemoryStore` 的全部能力。
- 云端版只实现 HTTP 适配（`/project/recall`、`/project/topics:batchGet`、`/project/commit` 和 Space / domain 接口），用 mock 服务做契约测试。
- 契约测试之后做一次小范围云端测试：在本地起服务，或部署到测试机（通过 ssh 别名连接）。
- 代码按 `capabilities()` 分支，不按模式分支。

## 影响

后端接口变化时只影响 `store/cloud/` 和契约测试。
