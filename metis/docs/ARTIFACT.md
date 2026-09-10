# ARTIFACT — 科研成果领域模型

## 类型

paper / report / proposal / review / dataset / figure / presentation / spreadsheet / other

## 领域身份与版本

- `id`：领域主键（art-<ts>-<rand>）
- `version`：metadata 版本，每次内容/路径变更 +1
- `versions[]`：历史版本条目（path/createdAt/note），只增不减
- 真实文件在 DSH workspace，本插件只维护领域身份/版本/关联

## 工具

artifact_register / artifact_list / artifact_get / artifact_version / artifact_update_metadata
