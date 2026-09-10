# Vendored: GenOffice docx-engine + pptx-engine

- 上游：https://github.com/genspark-ai/genoffice （Apache-2.0）
- 版本锚点：main 分支第 52 个 commit 附近的快照，快照日期 2026-08-25
- 引入决策：`docs/OFFICE_ENGINE_MIGRATION_PLAN.md`（刘总 2026-08-25 批准）
- 本地验证：独立 workspace 实跑 docx-engine 80 个测试文件（859 通过/1 跳过）、
  pptx-engine 76 个测试文件（766 全过）；另通过 METIS P0 保真基准
  （`D:\LATEXTEST\tools\genoffice-poc\`，4/4 样本字节保持零差异）。

## 修改记录（相对上游）

1. `docx-engine/src/parse.ts`：workspace 导入 `@genoffice/pptx-engine/custgeom`
   改为相对路径 `../../pptx-engine/src/custgeom`。
2. 仅保留 `src/`（上游 tests/fixtures/scripts 不随 vendor 分发；其测试在
   上游仓库与 P0 环境可复跑）。

## 治理

- 不追上游浮动；更新须走 `docs/OFFICE_ENGINE_MIGRATION_PLAN.md` §P4 流程
  （上游 diff 审查 → 上游测试 → METIS 护栏 → 人工双开对比）。
- `ee/` 目录（企业许可）从未引入；本目录仅含 Apache-2.0 的引擎源码。
- 运行时依赖：fast-xml-parser、jszip、utif2（见根 package.json）。
