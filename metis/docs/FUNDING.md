# FUNDING — 申报模板解析

## 核心

`shared/funding/src/funding-template-analyzer.ts`（861 行，从 legacy FundingTemplateAnalyzer.ts 整体迁移）。

## 工具

| 工具 | 说明 |
|---|---|
| funding_template_parse | 观察文档 → FundingTemplatePackage（章节树/指令/限字数/表格/字段映射/排版） |
| funding_template_requirements | 提取章节/指令/限字数/表格要求清单 |
| funding_template_check | digest + schema 完整性校验 |
| funding_template_diff | 两版本结构化差异 |

## 纪律

履历/经费/成果等用户事实缺失时明确列为缺口，绝不编造（T20-027/028）。
