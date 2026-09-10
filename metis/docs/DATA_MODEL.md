# DATA MODEL — METIS 领域数据归属

## 归属三分

| 分类 | 含义 | 示例 |
|---|---|---|
| DSH_OWNED | 由 DSH 原生运行时管理，不迁移 | sessions/messages/agent_events/checkpoints |
| METIS_DOMAIN_OWNED | 科研领域数据，迁移到新库 | projects/papers/evidence/claims/artifacts/journal_*/submission_* |
| LEGACY_ONLY | 不迁移 | memory/image_generation_settings/office_prompt_* |

详见 `metis/migration/DATA_MIGRATION_PLAN.md`（72 表三分）。

## 存储

- 引擎：SQLite（沿袭旧 METIS，领域查询本质关系型）
- 位置：`<DSH_HOME>/metis/` 目录（core 插件创建并持有连接）
- 版本：`SCHEMA_VERSION = 1`（新库起始），单调递增
- 备份：migration 前自动 `.bak-<ts>`

## 迁移工具

`metis/scripts/migrate-legacy.py`：dry-run / --apply / 幂等水位 / 冲突表 / 备份。
