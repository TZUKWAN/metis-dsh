# METIS Update Trust Model（任务 5）

状态：**UNSIGNED（alpha 阶段）— DEV ONLY / NOT RELEASE SAFE**。本文件是任务 5 §5 要求的如实声明。

## 渠道与信任策略

| 渠道 | 判定 | 自动下载 | 安装门 | 状态披露 |
|---|---|---|---|---|
| `dev` | 未打包运行 | 关闭（不做应用内更新） | — | DEV ONLY |
| `alpha` | 打包 + 版本带 prerelease 标签（如 `0.1.0-alpha.3`） | 开（GitHub prerelease feed，`setFeedURL releaseType:prerelease`） | 允许安装未签名工件，但事件与状态披露 UNSIGNED | `UNSIGNED ALPHA — NOT RELEASE SAFE` |
| `stable` | 打包 + 版本无 prerelease | 关（仅 check，不 auto-download） | **Authenticode 签名必须有效**，否则拒装（fail-safe，事件 `install-blocked`） | `STABLE — SIGNATURE REQUIRED (RELEASE SAFE)` |

- 渠道解析：`electron/UpdateChannelPolicy.ts`（env `METIS_UPDATE_CHANNEL` 仅用于测试/harness 显式覆盖）。
- 策略单一事实源：TS 常量；`build/update-trust-policy.json` 为镜像，单测强制二者同步。
- 运行时验签：`electron/UpdateSignatureVerifier.ts` 下载完成后对安装包跑 `Get-AuthenticodeSignature`（PowerShell），任何失败（超时/解析失败/非 Windows）一律按**未验证**处理——绝不乐观放行。
- 验签 pending 期间调用安装 → 拒绝（`signature-verification-pending`）。
- stable 未签名安装被拒时 `update:install` 返回 `{installing:false, blocked:'update_install_blocked_by_trust_policy'}`，不静默 quitAndInstall。

## 发布门（release.yml + `release:verify`）

- 版本无 prerelease（= stable）且工件未签名 → `verify-release-policy.mjs` 报 `stable_unsigned_update_blocked`，**发布被拒绝**（`evaluateUpdateTrust`，见 `tests/scripts/VerifyReleaseTrustPolicy.test.ts`）。
- alpha 未签名 → 允许发布，但验证报告 `updateTrust.trustLabel = UNSIGNED ALPHA — DEV ONLY / NOT RELEASE SAFE` 并附 disclosure notice。

## 证书到位后的切换清单（一次性）

1. electron-builder 签名环境：CI secrets `WINDOWS_CSC_LINK` / `WINDOWS_CSC_KEY_PASSWORD`（release.yml 已留好占位）。
2. `build/release-policy.json` → `windows.requireAuthenticode: true`。
3. `electron/UpdateChannelPolicy.ts` 与 `build/update-trust-policy.json` → `expectedSignerSubject: '<证书主题>'`（pin 签发者）。
4. stable 构建的 electron-updater 端 `verifyUpdateCodeSignature` 可翻回 `true`（package.json build.win）。
5. 重跑 `npm run verify:reliability:release` 全链验证。

## 当前双更新通道说明

- `AutoUpdaterService`（应用内，受本信任模型约束）与 `UpdateCheckerService`（GitHub API 手动检查，仅提示下载 URL）并存；alpha 的应用内自动下载只发生在显式渠道判定为 alpha 的打包构建中，dev 构建完全禁用。
