# METIS 增量架构（Phase 28 / 任务清单 T29-001）

> 本文档只写 **METIS 增量**（在 DSH 之上的部分）；DSH 自身架构见其官方文档，不在此重复。

## 分层

```
DSH 原生（session/chat/agent-loop/models/tools runtime/goal/plan/skills/permissions/fs/web/…）
    ↑ 通过 ctx 公开扩展点消费
METIS 插件家族（metis/plugins/*，每插件独立 install/remove）
    ├── core        科研项目元数据 + bounded context 注入
    ├── evidence    证据登记/验证生命周期/DOI 去重
    ├── literature  LiteratureRecord/Provider Registry/检索保存工具
    ├── literature-crossref   Crossref API provider
    ├── literature-openalex   OpenAlex API provider
    ├── literature-ncpssd     NCPSSD API provider（中文核心）
    ├── scenario    科研方法学场景定义 + 按需 systemPrompt 注入
    ├── artifact    成果领域身份/版本链
    ├── funding     申报模板解析/限字数/表格/diff
    └── submission  期刊目录 parser + 选刊聚合 + 投稿契约
METIS shared（纯领域库，无 bundle 声明）
    └── funding-core  FundingTemplateAnalyzer（861 行迁移，语义不变）
```

## 关键设计决策

| 决策 | 理由 |
|---|---|
| 工具以 raw JSON-Schema 注册 | 独立 workspace 无法解析 DSH 传递依赖闭包；ctx.tools.register 接受 raw 形状（cookbook 背书） |
| 类型面用 `types/dsh-modules.d.ts` ambient 声明 | 同上；DSH 完整 .d.ts 依赖其 workspace 类型图 |
| 领域数据用 SQLite（legacy 沿袭） | 领域查询本质关系型（papers↔projects↔evidence↔claims 多对多）；不用 JSON KV 强改 |
| bounded context 经 `systemPrompt.section()` 注入 | DSH 官方机制；provider 形态每次装配评估当前项目 |
| 证据登记由领域工具显式调用 | 不做全局 hook 拦截（T10-022），避免改变 DSH 原生工具行为 |
| scenario 激活经 `systemPrompt.section()` 按需注入 | 未激活场景零 instructions（R0-025/026） |

## Phase 16-21 增量描述（Phase 09-21 已交付）

### bounded research context（core / T9-012）

`MetisResearch.getBoundedResearchContext(maxChars)` 输出科研项目结构化摘要（字段固定顺序、可重建），超预算时截断并显式标注。经 `systemPrompt.section({ name: 'metis:research-context', text: provider })` 注入，provider 形态每次装配评估当前项目。

### evidence 插件（Phase 10）

`EvidenceStore` 提供原子持久化（tmp + rename）、DOI/URL 规范化去重、验证生命周期（unverified → verified/rejected/conflicted/stale）。对模型暴露 `evidence_query` 工具。

### literature 核心 + Provider Registry（Phase 11-13）

`LiteratureRegistry` 维护 provider 注册表（同名拒绝、DOI 优先去重、resolve fail-loud）。三个 provider：

| Provider | 来源 API | 状态 |
|---|---|---|
| CrossrefProvider | api.crossref.org/works | ✅ 真实 API 集成通过 |
| OpenAlexProvider | api.openalex.org/works | ✅ 同上 |
| NcpssdProvider | www.ncpssd.org/searchHandler | ✅ 真实 API 冒烟通过（中文核心白名单过滤） |

### artifact 插件（Phase 18）

`ArtifactStore` 维护领域身份（id）、类型、标题、路径引用、项目关联、版本链（versions[]）。真实文件保存在 DSH workspace，不复制内容。5 个工具：register/list/get/version/update_metadata。

### funding 插件（Phase 20）

复用 legacy FundingTemplateAnalyzer（861 行整体迁移到 shared/funding），4 个工具：parse（观察文档→模板包）、requirements（章节/指令/限字数/表格清单）、check（digest 校验）、diff（版本差异）。

### submission 插件（Phase 21）

journal-catalog parser（500 行 LetPub/eshukan HTML 解析纯函数，fetcher 可注入）+ journal-targeting 选刊聚合（基于主题相关近期论文的期刊白名单匹配）。2 个工具：journal_search、journal_targeting_match。

### scenario 插件（Phase 17）

5 个方法学 Scenario Definition（literature-review/empirical-paper/theoretical-paper/cssci-paper/paper-review）+ 3 个目录工具（scenario_list/get/activate）。激活后方法学指令经 `systemPrompt.section()` 按需注入；未激活场景零注入（R0-025/026）。必需工具缺失时激活校验返回缺失清单。

### bounded context / systemPrompt 注入（Phase 16 / core 插件）

`MetisResearch.getBoundedResearchContext()` 生成科研项目结构化摘要（4k 硬预算），经 `systemPrompt.section({ name: 'metis:research-context', text: provider })` 注入。未激活项目输出引导性短文本；超预算时截断并标注（绝不静默溢出）。
