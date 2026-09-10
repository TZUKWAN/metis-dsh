# PLUGIN_STANDARD — METIS 插件标准（以真实 Cordis Loader 验证形态为准）

## 1. 目录与清单

```
metis/plugins/<name>/
├── package.json        # name: dsh-metis-<name>；private；type: module；
│                       # main: ./dist/index.js（分发态，esbuild bundle）；
│                       # files: [./dist/index.js, ./cordis.patch.yml]；
│                       # dsh: { bundle: { patch: './cordis.patch.yml' } }
├── cordis.patch.yml    # - insert: [{ id: metis-<name>, name: dsh-metis-<name> }]
├── src/index.ts        # 插件入口（服务 + 工具注册；开发态可由 tsx 直载）
└── tests/*.test.ts     # vitest（metis/vitest.config.ts 统一跑）
```

构建：`pnpm run build:plugins`（`scripts/build-plugins.mjs`，esbuild 打包；METIS 内部模块全部打入
bundle，外部仅保留 `@deepseek-ai/*`、`dsh-metis-literature`、`zod`、`node:*`）。
打包：`pnpm run pack:plugins` → `dist-tarballs/*.tgz`。

## 2. 入口契约（vendored loader 实测要求）

- **default export 必须是 descriptor**：`{ name: 'metis-<x>', inject: [...], apply(ctx, config) }`。
  裸函数（无 inject 属性）会在 apply 期触发 `cannot get property ... without inject`；
  命名导出 `apply` 的 namespace 形态同样不被 vendored loader 接受。
- 服务用 `class X extends Service` + `static inject = [...]`；构造里 `super(ctx, '<camelKey>')`。
- **工具注册放在 Service 构造器内**，闭包捕获 `this` 与协作服务引用（如 `this.research = ctx.metisResearch`）；
  不要在工具 execute 里读取「本插件子作用域提供的服务」——反射走链不支持向下读取。
- `inject`（descriptor 级 + 服务 static 级）声明依赖；cordis 按可用性排序激活。

## 3. 工具规范

- `defineTool({ name, description, parameters, output: { schema, render }, execute })`。
- `output.schema` 的对象值**必须**写 `additionalProperties: boolean`；失败分支不得依赖 `undefined` 字段（显式 `null`）。
- `execute` 返回值必须匹配 schema；领域对象用 `toJson()` 显式转 `JsonValue`。
- 工具 `execute` 支持 `exec.signal`（取消）；网络失败抛 `ProviderUnavailableError`（fail-loud，禁止伪成功）。
- 需要项目作用域的工具通过 `metisResearch.requireCurrentProject(agent, projectId?)` 解析；
  只能作用于当前 DSH Workspace/Session 绑定的项目，不能凭 id 跨会话访问。

## 4. 服务与依赖方向

```
core ← literature ← literature-crossref / -openalex / -ncpssd（provider 注册进 registry）
core ← evidence
core ← artifact
core+goals ← scenario
funding / submission（独立，无持久化依赖）
```

- 跨插件消费用**类型化服务引用**（`static inject` + 构造期捕获），禁止 `as unknown as` 桥接；
- provider 不得依赖上层业务插件；core 不得反向依赖任何插件。

## 5. 持久化

- 领域状态统一写 `metis/shared/data` 的 MetisDataStore（node:sqlite；STRICT schema v1；
  WAL + busy_timeout；schema 版本高于运行时 fail-loud）。
- 各插件 config 的 `databasePath` 必须指向同一 `metis.db`。
- 连接在 `ctx.effect()` 中随服务销毁关闭。
- 例外（待迁移）：funding 内部登记仍为 JSON 文件。

## 6. Windows 注意事项

- patch 行的绝对路径必须 `file:///D:/...`（裸盘符被 ESM loader 当协议）。
- profile 目录 `~/.dsh/profiles/<name>` 的 pnpm 版本须保持一致（v10/v11 store 不兼容）。
- 宿主服务包（@deepseek-ai/*）在真实安装中由宿主 node_modules 提供；本地分发验证用 junction 链接
  （见 `scripts/verify-dsh-dist.ts`）。

## 7. 每插件测试最低要求

工具注册/名称、工具 execute 行为（含空态与失败态）、服务方法、持久化 reload、（有 I/O 时）cancel 与 provider 失败路径。
插件家族整体另受三层真实验证约束（见 `docs/ARCHITECTURE.md` 验证体系）：真实 Loader runtime、
跨进程重启恢复、tarball clean-install。
