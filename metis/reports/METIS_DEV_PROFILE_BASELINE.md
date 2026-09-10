> **历史材料**：本报告含早期验收口径，其中部分「已验证」声明（如基于 fakeCtx 的集成、
> JSON 文件持久化）已被后续真实 Loader/Runtime/分发验证取代。当前状态以
> ENGINEERING_STATUS.json 与 docs/ARCHITECTURE.md 为准。

# METIS-DEV PROFILE BASELINE（Phase 07 / T7-007）

> 生成：2026-09-10。对应 DSH commit `d347e70`（master）。

## Profile 事实

| 项 | 值 |
|---|---|
| 位置 | `C:\Users\lauze\.dsh\profiles\metis-dev`（由 `dsh plugin --profile metis-dev add ...` 初始化，非手写） |
| bundles 顺序 | `@deepseek-ai/dsh-base` → `dsh-metis-core` |
| 已装依赖 | `dsh-metis-core link:.../metis/plugins/core`（本地 checkout link，开发态） |
| patchReload | `live` |
| 与原生 Web 一致性 | 原生 Web = base + web-app（auto-init 模板）；metis-dev = base + metis-core。**核心 composition 差异仅 web-app 与 metis-core 的互换**（T7-006 的对照说明：metis-dev 不含 web-app，Web UI 冒烟经原生 web + `--patch` overlay 完成，见下） |

## 验证记录

1. **插件加载（bundle 通道）**：`dsh plugin --profile metis-dev add ./metis/plugins/core` 成功，`dsh.profile.bundles` 自动追加 `dsh-metis-core`；`dsh --profile metis-dev --dump-config` 显示 `# == dsh-metis-core` 层。
2. **插件加载（patch overlay 通道 / Web UI 共存）**：`pnpm dsh web --patch ./metis/plugins/core/cordis.patch.dev.yml --no-open` → 3080 就绪、token 鉴权 303 进入应用、**0 error**——metis-core（research_project_get / research_project_update 工具 + metisResearch 服务）经 tsx 加载成功。
3. **真实模型工具调用验证**：需要 DEEPSEEK_API_KEY，当前未配置——**DEFERRED**（列入 Gate C 复验项，不得视为已验证）。

## 过程中确认的平台约束（Windows / 当前 checkout）

- **Windows ESM 路径**：cordis loader 对 patch 行的插件路径按 ESM URL 解析——绝对路径必须写 `file:///D:/...`，裸 `D:/...` 报 `ERR_UNSUPPORTED_ESM_URL_SCHEME`（`d:` 被当协议）。
- **in-box bundle 不可加装进自定义 profile**：`dsh plugin --profile <custom> add @deepseek-ai/dsh-web-app` 失败——web-app 的依赖（如 `@deepseek-ai/dsh-frontend-static`）不在公共 npm registry，依赖闭包只在 DSH workspace 内解析。→ 自定义 profile 想要 Web UI 的官方路径是「原生 web + `--patch` overlay」；记录于 DEFERRED_DSH_GAPS 的前置事实（非 gap，属设计）。
- **pnpm 双版本**：全局 10.27 与 Corepack pin 11.7 并存。DSH 仓库内由 packageManager 自动切 11.7；`~/.dsh/profiles/**` 无 pin，会被 10.27 接管。profile 一旦用某版本建库，须继续用同一版本操作（store v10/v11 不兼容）。处置：profile 目录已统一用 10.27 重装。
- **fs-ext 编译**：需 node-gyp@10（经 `npm_config_node_gyp` 注入）；node-gyp 12 在 Node 25 下对 fs-ext@2.1.1 的 MSVC 工程生成有缺陷（LNK1181）。
