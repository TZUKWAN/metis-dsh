# SCENARIO — 科研方法学场景

## 内置场景

| 场景 | requiredTools | outputContract |
|---|---|---|
| literature-review | literature_search / literature_save / ncpssd_search | literature-review artifact |
| empirical-paper | literature_search / literature_save | empirical paper artifact |
| theoretical-paper | literature_search | theoretical paper artifact |
| cssci-paper | literature_search / ncpssd_search / literature_save | cssci paper artifact |
| paper-review | literature_search | review artifact |

## 机制

- 激活状态按 **DSH Session** 持久化在 SQLite（`scenario_activations`）；跨进程重启恢复，会话间严格隔离
- 激活后方法学指令经 `systemPrompt.section()` 按当前 agent 作用域求值注入；未激活场景零注入
- 激活前用 `ctx.tools.get(tool, agent)` 校验必需工具在**当前 agent 视角**真实可见；缺失 fail-loud（返回 missingTools）
- 激活时通过 **DSH 原生 Goal 服务**（`ctx.goals`）创建目标；已有未完成 Goal 时拒绝覆盖，不重造状态机
- 激活要求当前 session 已绑定科研项目（`metisResearch.requireCurrentProject`）
