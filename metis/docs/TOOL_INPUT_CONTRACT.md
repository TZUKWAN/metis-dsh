# TOOL_INPUT_CONTRACT — 工具输入边界契约

每个模型-facing 工具的输入路径统一为：

```
raw model args → normalization → validation → execution → canonical output
```

## 归一化（按语义允许）
- JSON 字符串 → 解析（如 literature_save.records、funding requirements）；
- 单对象 → 单元素数组（records/usedEvidenceIds）；
- 数字字符串 → Number（page/limit/version）。

## 禁止（不得自动猜）
- DOI/题名补全、标题相似度合并（只按 DOI 或 provider+sourceId 去重）；
- 未声明枚举值静默降级（relation/status/claimType/verificationState 等显式报错）；
- 空输入伪成功（literature_save 空数组直接 INVALID_INPUT）。

## 错误契约
- 领域级失败：`{ ok: false, error: { code, message, retryable } }`，code ∈
  INVALID_INPUT/NOT_FOUND/CONFLICT/PROVIDER_UNAVAILABLE/NETWORK_TIMEOUT/RATE_LIMITED/
  VERIFICATION_FAILED/STORAGE_FAILURE/PERMISSION_DENIED/CANCELLED；
- 程序缺陷：向上抛出，由 DSH 管线物化为 isError；
- 网络类工具遵守 `exec.signal`；网络失败诚实返回（providerFailures），不伪造空成功。

## 引用完整性
所有 id 引用（project/evidence/artifact/journal/case）在数据层外键+显式校验，
引用不存在即失败，绝不静默忽略。
