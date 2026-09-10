# LITERATURE — 文献能力

## Provider 契约

```ts
interface LiteratureProvider {
  name: string
  capabilities: { search: boolean; getByDoi: boolean }
  search(options: { query: string; limit?: number; signal?: AbortSignal }): Promise<LiteratureRecord[]>
  getByDoi?(doi: string, signal?: AbortSignal): Promise<LiteratureRecord | null>
}
```

## 已实现 Provider

| Provider | 包 | 来源 | 状态 |
|---|---|---|---|
| Crossref | dsh-metis-literature-crossref | api.crossref.org | ✅（真实 API 集成测试通过） |
| OpenAlex | dsh-metis-literature-openalex | api.openalex.org | ✅（同上） |
| NCPSSD | dsh-metis-literature-ncpssd | www.ncpssd.org/searchHandler | ✅（真实 API 冒烟通过） |

## 已知限制

- NCPSSD 无 DOI 检索（getByDoi=false）
- LetPub/万维门户交互式抓取标 DEFERRED（需登录态）
- Semantic Scholar / arXiv adapter 未迁移（legacy 资产已定位）
