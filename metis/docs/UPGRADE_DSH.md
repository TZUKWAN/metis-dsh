# UPGRADE_DSH — 升级 DeepSeek Harness 的固定流程

```
git fetch upstream
git merge/rebase upstream baseline（保持 metis/** 为唯一新增）
node metis/scripts/check-dsh-untouched.mjs        # 内容+mode+worktree
node metis/scripts/verify-fresh-clone.mjs
cd metis && pnpm install && pnpm test && pnpm run build:plugins && pnpm run pack:plugins
node --import tsx/esm scripts/verify-dsh-runtime.ts setup/verify <state>
node --import tsx/esm scripts/verify-dsh-dist.ts dist-tarballs/*.tgz
node scripts/generate-engineering-status.mjs --full
```

任何一步失败：先修 METIS 侧兼容层（禁止改 DSH 源码）；如 DSH 破坏了公开契约，
在 `metis/docs/DEFERRED_DSH_GAPS.md` 登记并向上游反馈。
