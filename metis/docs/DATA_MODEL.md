# DATA_MODEL — metis.db 领域模型（schema v2）

统一由 `metis/shared/data` 的 `MetisDataStore` 管理（node:sqlite，STRICT 表，WAL，
foreign_keys=ON，busy_timeout=5000，`schema_migrations` 版本化迁移，损坏 fail-loud）。

| 表 | 内容 |
|---|---|
| research_projects / workspace_project_bindings / session_project_bindings | 项目与 DSH Workspace/Session 绑定 |
| literature_records / project_literature | 题录（DOI 优先去重）与项目关联（含 evidence_id） |
| evidence_sources / evidence_records / evidence_excerpts / evidence_claims / claim_evidence_links | 来源身份 / 证据 / 摘录+定位器 / Claim(claim_type, artifact_id) / 关联(relation, confidence) |
| scenario_activations | per-Session 场景激活 |
| artifacts / artifact_versions / artifact_evidence_links | 成果 / 版本链(sha256, createdBy) / 证据关联 |
| funding_templates / funding_template_versions / funding_section_drafts | 模板登记+版本历史 / 章节草稿 |
| journal_records / journal_requirements / submission_cases / submission_checks / artifact_journal_matches | 期刊/要求集/案例/检查/匹配 |

项目作用域解析：session → session_project_bindings → project；session 与 workspace 不一致时拒绝（防止串项目）。
