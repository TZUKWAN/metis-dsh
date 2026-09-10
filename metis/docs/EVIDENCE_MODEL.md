# EVIDENCE MODEL — 证据领域模型

## 核心类型

```ts
interface EvidenceRecord {
  id: string                        // ev-<ts>-<rand>
  projectId: string | null          // 归属项目（null=未归属）
  sourceType: EvidenceSourceType    // literature/web_page/database_observation/computation/user_provided/model_inference/file
  source: {
    provider: string                // crossref/openalex/ncpssd/user
    sourceId?: string               // 来源内部 id（DOI/OpenAlex id）
    url?: string
    retrievedAt?: number
  }
  title: string
  observation?: string              // 原文摘录（≤4000 字符，截断标 truncated）
  doi?: string                      // 规范化小写
  url?: string
  observedAt: number
  verificationState: 'unverified'|'verified'|'rejected'|'conflicted'|'stale'
  createdByTool: string
  createdAt / updatedAt
}
```

## 生命周期

unverified → verified / rejected / conflicted / stale（由 verify/reject/markConflict/markStale 转移）。

## 优先来源

NCPSSD / Crossref / OpenAlex / Semantic Scholar / arXiv / 期刊官网 / 出版社 / 权威数据库。
能核验 DOI 时必须核验；模型记忆中的文献未经验证不得进入正式成果。
