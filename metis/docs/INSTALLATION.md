# INSTALLATION — METIS Research Plugins 安装指南

## 前置

- Node.js >= 24（或 22.19+）
- pnpm（Corepack 可自动解析）
- DSH checkout（`metis/` 的父目录即 DSH 仓库），已完成 `pnpm install && pnpm run build`

## 安装插件

在 DSH checkout 根目录执行：

```sh
pnpm dsh plugin --profile metis-dev add ./metis/plugins/core
pnpm dsh plugin --profile metis-dev add ./metis/plugins/evidence
pnpm dsh plugin --profile metis-dev add ./metis/plugins/literature
pnpm dsh plugin --profile metis-dev add ./metis/plugins/literature-crossref
pnpm dsh plugin --profile metis-dev add ./metis/plugins/literature-openalex
pnpm dsh plugin --profile metis-dev add ./metis/plugins/literature-ncpssd
pnpm dsh plugin --profile metis-dev add ./metis/plugins/scenario
pnpm dsh plugin --profile metis-dev add ./metis/plugins/artifact
pnpm dsh plugin --profile metis-dev add ./metis/plugins/funding
pnpm dsh plugin --profile metis-dev add ./metis/plugins/submission
```

每次 add 后 `dsh.profile.bundles` 自动追加对应 bundle。

## 启动

```sh
pnpm dsh --profile metis-dev
```

启动日志确认各插件加载（无 error）。

## 卸载

```sh
pnpm dsh plugin --profile metis-dev remove ./metis/plugins/<name>
```

卸载后 DSH 原生 Chat/Goal/Plan 等不受影响。

## 数据迁移（可选）

从旧 METIS 迁移领域数据：

```sh
python metis/scripts/migrate-legacy.py            # dry-run
python metis/scripts/migrate-legacy.py --apply    # 真正写库
```

## API Key

真实模型调用需在环境变量或 `.env` 配置 `DEEPSEEK_API_KEY`。
