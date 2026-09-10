# METIS 增量架构

> 本文档只描述 **METIS 增量**（在 DSH 之上的部分），与代码现状同步维护。
> 交付状态以 `ENGINEERING_STATUS.json`（机器生成）为准；`reports/` 与 `MIGRATION_STATUS.md`
> 为历史材料，其中的完成声明不反映当前架构。

## 分层

```
DSH 原生（session/chat/agent-loop/models/tools runtime/goal/plan/workspace/
          system-prompt/fs/web/… —— upstream untouched，由 git 守卫保证）
    ↑ 只通过 ctx 公开扩展点消费（tools.register / systemPrompt.section /
      goals.* / workspaceRegistry / agents.create / ctx.tools.get / ctx.tools.execute）
METIS 插件家族（metis/plugins/*，每插件独立 install/remove；分发形态为 esbuild
                打包的 dist/index.js tarball）
    ├── core                ResearchProject（SQLite）+ 项目作用域解析 + 系统提示注入
    ├── evidence            Evidence/Claim/验证生命周期（SQLite，共享 metis.db）
    ├── literature          LiteratureRecord/Provider Registry/检索保存工具（SQLite）
    ├── literature-crossref / -openalex / -ncpssd   真实 API provider（注册进 registry）
    ├── scenario            方法学场景：per-session 持久化激活 + DSH 原生 Goal 联动
    ├── artifact            成果身份/版本链/Evidence 关联（SQLite，限当前 DSH Workspace 内文件）
    ├── funding             申报模板解析/限字数/表格/diff（内部登记仍为 JSON —— 待迁移）
    └── submission          期刊目录 parser + 选刊聚合 + 投稿契约（无持久化状态）
METIS shared（纯领域库，打包进各插件 bundle，不单独分发）
    ├── data      MetisDataStore（node:sqlite；全部领域表；STRICT schema v1）
    └── funding   FundingTemplateAnalyzer
```

## 关键设计决策

| 决策 | 理由 |
|---|---|
| 领域状态全部进 SQLite（`metis/shared/data`） | 项目/文献/证据/场景/成果是关系型数据；进程内存或 JSON 文件无法支撑重启恢复与多工作区隔离。funding 内部登记是当前唯一例外（已列入待办） |
| 每插件共享一个 `metis.db`（路径由插件 config 对齐） | 同一进程多连接 + WAL + busy_timeout；文献保存与证据登记在同一事务完成 |
| 类型直接对 DSH 官方 `.d.ts`（`tsconfig.json` paths） | 禁止 ambient `any` 遮蔽真实契约；工具输出的 JsonValue 约束在编译期执行 |
| 插件入口 = descriptor（`{ name, inject, apply }`），工具在 Service 构造器注册并捕获 `this` | 这是经 vendored loader 反射规则验证的形态：入口级 inject 决定 apply 期可访问的服务；工具闭包持有服务实例，不在执行期读取自身子作用域 |
| 项目作用域来自真实 DSH 身份 | session id = `agent.id`；workspace id = `ctx.workspaceRegistry` 按 `agent.session.header.cwd` 解析；工具可用性校验用 `ctx.tools.get(name, agent)` |
| Scenario Goal 完全委托 `ctx.goals` | METIS 不重造 Goal/Plan/Agent 状态机；scenario_activate 通过 DSH 原生 Goal 服务创建目标 |
| Artifact 只登记当前 Workspace 内真实文件 | 路径经 `workspaceRegistry` 解析 + 相对化校验（拒绝穿越）；SQLite 记录版本链与证据关系，不复制文件内容 |
| 系统提示经 `systemPrompt.section()` 按需注入 | research-context 与 scenario 指令都在装配期按当前 agent 作用域求值；未绑定/未激活即零注入 |

## 验证体系（证据链）

| 层级 | 内容 | 入口 |
|---|---|---|
| L1 单元/集成 | 持久化、隔离、生命周期、截断、损坏 fail-loud、真实 provider API | `pnpm test`（metis 目录，41 项） |
| L2 真实 Loader + Runtime | 真实 boot(dsh-base + METIS overlay) → 真实 agent → 真实工具管线 → 跨进程重启恢复 | `node --import tsx/esm metis/scripts/verify-dsh-runtime.ts setup|verify <state.json>`（31+8 项） |
| L3 分发 | tarball clean-install 到全新 profile（官方 `dsh plugin add`）→ 真实 boot → 服务/工具/provider 注册 + **全部 24 个工具的真实执行矩阵**（网络类工具断言「成功或诚实失败」） | `node --import tsx/esm metis/scripts/verify-dsh-dist.ts metis/dist-tarballs/*.tgz`（56 项） |
| L4 Real Agent E2E | 模型自主调用全链路（真实 LLM 经 llm-pi-ai 路由） | `CLOUDLOB_API_KEY=… node --import tsx/esm metis/scripts/verify-real-agent.ts`（7 项；密钥仅经环境变量注入，不入库；DeepSeek 官方路由亦可配置） |
| 上游守卫 | 9080 个 upstream path 的内容 + Git mode + worktree 校验 | `node metis/scripts/check-dsh-untouched.mjs` |

## 当前已知未完成事项（如实声明）

- funding 插件内部登记仍为 JSON 文件（`metis-data/funding-templates.json`），待迁移到 MetisDataStore；
- submission 无持久化状态，完整投稿生命周期未实现；
- 公共 GitHub 远端尚未接收本地 upstream 血缘修复（涉及公开历史重写，待确认后执行）。
