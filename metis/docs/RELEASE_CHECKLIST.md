# RELEASE_CHECKLIST — v0.1.0-rc

1. `git fetch` 后确认 upstream 血缘（merge-base = baseline）；
2. `check-dsh-untouched` + `verify-fresh-clone` + `verify-guard-negative` 全过；
3. `pnpm test`（L1 全绿）；typecheck；
4. `build:plugins` + `pack:plugins`（10 tarball）；
5. `verify-dsh-runtime`（setup+verify）；`verify-dsh-dist`（80+ 矩阵）；
6. `verify-real-agent`；`verify-golden-run`；`run-evals`（有凭据时）；
7. `generate-engineering-status --full` → verdict PASS；
8. 更新 KNOWN_LIMITATIONS；打 tag `v0.1.0-rc`；推送 tag 与 master。
