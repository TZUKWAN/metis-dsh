# ARTIFACT — 科研成果领域模型

## 类型

paper / report / proposal / review / dataset / figure / presentation / spreadsheet / other

## 领域身份与版本（SQLite：`artifacts` / `artifact_versions` / `artifact_evidence_links`）

- `id`：领域主键（`art-<uuid>`）
- `version`：当前版本号；每次 `artifact_version` +1
- `versions[]`：历史版本条目（workspacePath/note/createdAt），只增不减，不可覆盖
- `evidenceIds[]`：关联的 Evidence 记录（外键校验，引用不存在的证据会整体失败）
- 真实文件保存在 DSH Workspace（用户/DSH Files 管理），本插件只维护领域身份、相对路径引用、版本链与证据关系

## Workspace 边界（真实 DSH 身份，不接受任意路径）

- 登记路径必须是**当前 agent session 的 cwd 所注册的 DSH Workspace** 内的相对路径；
- session cwd 未注册为 Workspace → 拒绝；`..` 穿越 / workspace 根目录 → 拒绝；文件不存在 → 拒绝（fail-loud，不静默成功）；
- 所有读取按「当前 session 已绑定项目」过滤，跨项目按 id 猜测访问会被拒绝。

## 工具

artifact_register / artifact_list / artifact_get / artifact_version / artifact_update_metadata
