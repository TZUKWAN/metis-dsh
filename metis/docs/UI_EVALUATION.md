# UI 插件评估（Phase 23 / T23-001~012）

> 结论：**默认不做**。当前无任何对话面满足"没有 UI 就无法合理完成核心功能"的门槛（任务清单二十三）。

## 逐项评估

| 候选 | 结论 | 理由 |
|---|---|---|
| T23-001 literature sidebar | 不做 | Generic Tool Card 已完整承载 literature_search/save 的 canonical JSON 输出；literature_search_project 可按需查询已保存文献，无需常驻侧栏 |
| T23-002 artifact sidebar | 不做 | artifact_list/get 工具输出可由 Chat 呈现；DSH Files 已负责文件浏览 |
| T23-003 funding template explorer | 不做 | funding_template_requirements/check 工具输出结构化要求清单，Chat 内可直接消费 |
| T23-004 submission shortlist | 不做 | journal_targeting_match 工具输出候选期刊 JSON，Chat 内可直接消费 |

## Reopen 条件

某一对话面出现「没有专用 UI 就无法合理完成核心功能」的实证场景（任务清单二十三开头条件），且 Generic Tool Card + Chat 呈现确实无法覆盖时，重开评估。
