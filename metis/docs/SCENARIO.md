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

- 激活后方法学指令经 `systemPrompt.section()` 按需注入
- 未激活场景零注入
- 必需工具缺失时 fail-loud（T17-017）
- 运行时复用 DSH 原生 Goal/Plan/Skills/Workflow
