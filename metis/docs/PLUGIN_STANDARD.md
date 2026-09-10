# PLUGIN_STANDARD — METIS 插件标准（Phase 08，基于 dsh-metis-core 已验证形态）

## 1. 目录与清单

```
metis/plugins/<name>/
├── package.json        # name: dsh-metis-<name>；private；type: module；
│                       # main: ./src/index.ts（开发态，tsx 直载）；
│                       # dsh: { bundle: { patch: './cordis.patch.yml' } }
├── cordis.patch.yml    # - insert: [{ id: metis-<name>, name: dsh-metis-<name>, inject?: [...] }]
├── src/index.ts        # 插件入口（服务 + 工具注册）
└── tests/*.test.ts     # vitest（metis/vitest.config.ts 统一跑）
```

## 2. 入口契约（cordis loader 实测要求）

- **default export 必须是插件函数或带 `apply` 的对象**（`export class` 或命名导出不满足 loader 校验，启动即 fail-loud）。
- 服务用 `class X extends Service`，构造里 `super(ctx, '<camelKey>')`——服务经声明合并挂到 `ctx.<key>`；工具注册抽为独立函数由 constructor 调用。
- `inject` 声明依赖（如 `['tools']`、`['metisLiterature']`）；cordis 会等待依赖就绪。

## 3. 工具规范（R0-027）

- `defineTool({ name, description, parameters, output: { schema, render }, execute })`。
- `output.schema` 的对象值**必须**写 `additionalProperties: boolean`；`properties` 声明字段以获得类型推断。
- `execute` 返回值必须匹配 schema 推断类型；领域对象用 `toJson()` 显式转 `JsonValue`（数组逐元素转）。
- 工具 `execute` 支持 `exec.signal`（取消）；网络失败抛 `ProviderUnavailableError`（fail-loud，禁止伪成功/静默空结果）。

## 4. 服务与依赖方向

```
core ← evidence ← literature ← literature-crossref / -openalex / -ncpssd
core ← artifact ← funding / submission
```

- 跨插件消费用**最小桥接口**（interface + `as unknown as` 断言），不做硬代码依赖；
- bundle 依赖在 package.json 里以 `file:` / 将来的 npm 形式声明；
- provider 不得依赖上层业务插件；core 不得反向依赖任何插件。

## 5. 持久化

- 第一版：JSON 文件 + 原子写（tmp + rename），`SCHEMA_VERSION` 字段；损坏文件隔离备份。
- 迁移目标：core 持有的 SQLite（`metis-data/`，DATA_MIGRATION_PLAN.md）。
- 生命周期：文件句柄/连接在 `ctx.effect()` 中清理。

## 6. Windows 注意事项

- patch 行的绝对路径必须 `file:///D:/...`（裸盘符被 ESM loader 当协议）。
- profile 目录 `~/.dsh/profiles/<name>` 的 pnpm 版本须保持一致（v10/v11 store 不兼容）。
- in-box bundle（如 `@deepseek-ai/dsh-web-app`）不可加装进自定义 profile——依赖闭包只在 DSH workspace 内解析；Web UI 用「原生 web + `--patch` overlay」。

## 7. 每插件测试最低要求

工具注册/名称、工具 execute 行为（含空态与失败态）、服务方法、持久化 reload、（有 I/O 时）cancel 与 provider 失败路径。
