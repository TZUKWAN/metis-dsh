# SUBMISSION — 学术投稿

## 迁移资产

- `journal-catalog.ts`（500 行）：LetPub/eshukan 目录 HTML parser（decodeHtmlEntities/htmlToText/parseLetPubFieldOptions/parseLetPubJournalList/parseLetPubDetail），fetcher 可注入
- `journal-targeting.ts`（133 行）：选刊匹配——基于主题相关近期论文的期刊聚合 + 白名单层级标注
- `submission-contract.ts`：投稿生命周期 zod 契约（Series/Case/状态转移）

## 诚实边界

影响因子/录用率/审稿周期/版面费等指标**不允许凭模型记忆产生**——只透出有来源的字段；无法核验的要求标 unverified。
