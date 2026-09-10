/**
 * MCP 预置目录（2026-09-08 刘总清单）。
 *
 * 存储≠注册：这些条目只是**目录元数据**（来源/能力/预置级别），不代表已在
 * METIS 中安装、启动或注入上下文。用户在 MCP 库中选择某条目并配置端点/
 * 凭据后才成为可绑定的 McpDefinition；且默认仍不启动——只有绑定到正在执行的
 * Workflow 步骤时才由 Managed MCP Runtime 拉起，结束即释放（任务7 7E）。
 */

export interface McpCatalogEntry {
  id: string;
  name: string;
  category: 'web' | 'academic' | 'data' | 'office' | 'code' | 'reference' | 'news' | 'archive';
  repo: string;
  /** 一句话能力（来自刘总清单）。 */
  capability: string;
  /** 预置级别 A/A-/B/B-/C（刘总清单）。 */
  level: 'A' | 'A-' | 'B' | 'B-' | 'C';
  note?: string;
}

export const MCP_CATALOG: readonly McpCatalogEntry[] = [
  // ── 通用互联网（清单置顶：Search/Reader/Crawler/Browser 四类互补）──
  { id: 'playwright-mcp', name: 'Playwright MCP', category: 'web', repo: 'microsoft/playwright-mcp', capability: '基于可访问性快照的结构化导航/点击/输入', level: 'A', note: '借鉴稳定元素引用与可访问性树' },
  { id: 'chrome-devtools-mcp', name: 'Chrome DevTools MCP', category: 'web', repo: 'ChromeDevTools/chrome-devtools-mcp', capability: '真实 Chrome/页面/网络/调试控制', level: 'A', note: 'CNKI 等真实登录会话工作流' },
  { id: 'tavily-mcp', name: 'Tavily MCP', category: 'web', repo: 'tavily-ai/tavily-mcp', capability: '实时 Web Search/抽取/站点 map/crawl', level: 'A', note: 'Search Broker 生产级 provider' },
  { id: 'exa-mcp', name: 'Exa MCP', category: 'web', repo: 'exa-labs/exa-mcp-server', capability: '语义 Web Search/相似页面/fetch', level: 'A' },
  { id: 'jina-mcp', name: 'Jina AI MCP', category: 'web', repo: 'jina-ai/MCP', capability: 'URL→Markdown/截图/日期推断/rerank', level: 'A', note: 'Web Reader 与重排层' },
  { id: 'firecrawl-mcp', name: 'Firecrawl MCP', category: 'web', repo: 'firecrawl/firecrawl-mcp-server', capability: '搜索/抓取/爬取/动态页面', level: 'A' },
  { id: 'brave-search-mcp', name: 'Brave Search MCP', category: 'web', repo: 'brave/brave-search-mcp-server', capability: 'Web/News/Images/Videos 搜索', level: 'A', note: '通用搜索主 provider' },
  { id: 'perplexity-mcp', name: 'Perplexity MCP', category: 'web', repo: 'perplexityai/modelcontextprotocol', capability: '实时搜索/Deep Research', level: 'B', note: '独立模型成本' },
  { id: 'brightdata-mcp', name: 'Bright Data MCP', category: 'web', repo: 'brightdata/brightdata-mcp', capability: '抗阻断抓取/浏览器自动化', level: 'B', note: '困难站点按需' },
  { id: 'apify-mcp', name: 'Apify MCP', category: 'web', repo: 'apify/apify-mcp-server', capability: 'Actor 市场抓取', level: 'B' },
  { id: 'browserless-mcp', name: 'Browserless MCP', category: 'web', repo: 'browserless/browserless-mcp', capability: '云浏览器/search/crawl', level: 'B', note: '本地 Browser 仍保留' },
  { id: 'mcp-fetch', name: 'MCP Fetch (参考实现)', category: 'web', repo: 'modelcontextprotocol/servers', capability: 'HTTP fetch/HTML→Markdown', level: 'B', note: '须补 SSRF/redirect 安全' },
  { id: 'serper-mcp', name: 'Serper MCP', category: 'web', repo: 'postfix/serper-mcp', capability: 'Google SERP', level: 'B', note: '需 API Key' },
  { id: 'browser-mcp-nizovtsev', name: 'Browser MCP Server', category: 'web', repo: 'nizovtsevnv/browser-mcp-server', capability: '浏览器+Fetch+Search 一体', level: 'C' },

  // ── 学术检索 ──
  { id: 'paper-search-openags', name: 'Paper Search MCP (openags)', category: 'academic', repo: 'openags/paper-search-mcp', capability: '多学术源搜索/去重/下载/全文抽取', level: 'A', note: '学术搜索聚合层核心' },
  { id: 'paper-search-bbutlerau', name: 'Paper Search MCP (bbutlerau)', category: 'academic', repo: 'bbutlerau/paper-search-mcp', capability: 'Crossref/ERIC/S2/OpenAlex/Unpaywall 聚合', level: 'B', note: 'ERIC 教育学' },
  { id: 'paper-search-upascal', name: 'Paper Search MCP (upascal)', category: 'academic', repo: 'upascal/paper-search-mcp', capability: '多源统一检索+RRF 融合排序', level: 'B', note: 'RRF 思路移植 Search Broker' },
  { id: 'semantic-scholar-mcp', name: 'Semantic Scholar MCP', category: 'academic', repo: 'smaniches/semantic-scholar-mcp', capability: 'S2 Graph 结构化检索', level: 'B', note: '已有原生 S2,插件替代' },
  { id: 'openalex-mcp', name: 'OpenAlex MCP', category: 'academic', repo: 'cyanheads/openalex-mcp-server', capability: 'works/authors/sources/citation 图谱', level: 'A', note: '社科覆盖广' },
  { id: 'crossref-mcp', name: 'Crossref MCP', category: 'academic', repo: 'botanicastudios/crossref-mcp', capability: 'DOI/学术元数据', level: 'B', note: '已有原生 Crossref' },
  { id: 'arxiv-mcp', name: 'arXiv MCP', category: 'academic', repo: 'CoChatAI/arxiv-mcp-server', capability: 'arXiv 搜索与访问', level: 'C', note: '已有原生 arXiv' },
  { id: 'academic-tools-mcp', name: 'Academic Tools MCP', category: 'academic', repo: 'hunter-heidenreich/academic-tools-mcp', capability: 'OpenAlex/arXiv/ACL/OpenCitations 聚合', level: 'B' },
  { id: 'scholar-search-mcp', name: 'Scholar Search MCP', category: 'academic', repo: 'Silung/scholar-search-mcp', capability: 'Google Scholar 类检索', level: 'C', note: '反爬需实测' },
  { id: 'academic-search-afrise', name: 'Academic Search MCP', category: 'academic', repo: 'afrise/academic-search-mcp-server', capability: '多来源学术检索', level: 'C', note: 'E2E 后再默认启用' },
  { id: 'core-mcp', name: 'CORE MCP', category: 'academic', repo: 'CoChatAI/core-mcp-server', capability: '开放获取研究资源', level: 'B' },
  { id: 'pubmed-mcp', name: 'PubMed MCP', category: 'academic', repo: 'grll/pubmedmcp', capability: 'PubMed 检索', level: 'C', note: '公共卫生/心理' },
  { id: 'europepmc-mcp', name: 'Europe PMC MCP', category: 'academic', repo: 'CoChatAI/europepmc-mcp-server', capability: '生医开放全文', level: 'C' },

  // ── 参考文献管理 ──
  { id: 'zotero-mcp-isezen', name: 'Zotero MCP (isezen)', category: 'reference', repo: 'isezen/zotero-mcp', capability: 'Zotero 库/文献/笔记', level: 'A', note: 'METIS↔Zotero 正式桥' },
  { id: 'zotero-mcp-lucidbard', name: 'Zotero MCP (lucidbard)', category: 'reference', repo: 'lucidbard/zotero-mcp', capability: '本地 Zotero 读取', level: 'B' },
  { id: 'orcid-mcp', name: 'ORCID MCP', category: 'reference', repo: 'cyanheads/orcid-mcp-server', capability: '研究者身份检索', level: 'B' },
  { id: 'datacite-mcp', name: 'DataCite MCP', category: 'reference', repo: 'alexwade/datacite-mcp', capability: '数据集 DOI/元数据', level: 'B' },
  { id: 'unpaywall-mcp', name: 'Unpaywall MCP', category: 'reference', repo: 'dam2452/unpaywall-mcp', capability: '合法 OA 版本定位', level: 'A', note: '接 PDF 获取链路' },
  { id: 'osf-mcp', name: 'OSF MCP', category: 'reference', repo: 'SourceShift/osf-mcp-server', capability: '开放科学项目/预注册', level: 'C' },
  { id: 'zenodo-mcp', name: 'Zenodo MCP', category: 'reference', repo: 'eic/zenodo-mcp-server', capability: '研究数据/对象', level: 'B' },

  // ── 新闻/舆情/趋势 ──
  { id: 'newsapi-mcp', name: 'NewsAPI.ai MCP', category: 'news', repo: 'EventRegistry/newsapi-mcp', capability: '实时新闻/事件跟踪/过滤', level: 'A', note: '政策/传播/舆情' },
  { id: 'gdelt-mcp', name: 'GDELT MCP', category: 'news', repo: 'cyanheads/gdelt-mcp-server', capability: '全球新闻/tone/时间线', level: 'A', note: '高价值免费数据源' },
  { id: 'gdelt-mcp-light', name: 'GDELT MCP (轻量)', category: 'news', repo: 'anysiteio/GDELT-mcp', capability: 'GDELT 文章/情感/地理', level: 'C', note: '优先 cyanheads 实现' },
  { id: 'reddit-mcp', name: 'Reddit MCP', category: 'news', repo: 'selamy-labs/reddit-mcp', capability: 'Reddit 只读研究访问', level: 'B', note: '遵守平台条款' },
  { id: 'reddit-research-mcp', name: 'Reddit Research MCP', category: 'news', repo: 'king-of-the-grackles/reddit-research-mcp', capability: 'Reddit 语义检索与引用', level: 'C' },
  { id: 'google-trends-mcp', name: 'Google Trends MCP', category: 'news', repo: 'purahmanian/google-trends-mcp', capability: '趋势/相关查询/地区比较', level: 'B' },
  { id: 'google-news-mcp', name: 'Google News MCP', category: 'news', repo: 'Tatsuya50/google-news-mcp', capability: '新闻向量库语义搜索', level: 'C' },
  { id: 'news-api-mcp', name: 'News API MCP', category: 'news', repo: 'berlinbra/news-api-mcp', capability: '全文搜索/来源过滤', level: 'C' },

  // ── 档案/知识图谱 ──
  { id: 'wikipedia-mcp', name: 'Wikipedia MCP', category: 'archive', repo: 'automateyournetwork/Wikipedia_MCP', capability: '百科检索与条目读取', level: 'C', note: '背景来源,不高权重' },
  { id: 'wikidata-mcp', name: 'Wikidata MCP', category: 'archive', repo: 'wmde/WikidataMCP', capability: '结构化知识图谱', level: 'A', note: '人物/机构/地点消歧' },
  { id: 'wayback-mcp', name: 'Wayback MCP', category: 'archive', repo: 'sisilet/wayback-mcp', capability: '网页历史快照', level: 'A', note: '政策史/传播研究' },
  { id: 'wayback-mcp-alt', name: 'Wayback MCP (alt)', category: 'archive', repo: 'fuushyn/wayback-machine-mcp', capability: '快照查询/可用性检测', level: 'C' },
  { id: 'archiveorg-mcp', name: 'Internet Archive MCP', category: 'archive', repo: 'smeet666/mcp-archiveorg', capability: '扫描书全文/历史网页', level: 'A', note: '历史学原始材料' },
  { id: 'archiveorg-ocr-mcp', name: 'Internet Archive OCR MCP', category: 'archive', repo: 'nestordemeure/archives-mcp', capability: '数字化书籍 OCR 搜索', level: 'B' },
  { id: 'data-commons-mcp', name: 'Data Commons MCP', category: 'data', repo: 'alpic-ai/datacommons-mcp', capability: '公共统计知识图谱', level: 'B' },
  { id: 'worldbank-data360-mcp', name: 'World Bank Data360 MCP', category: 'data', repo: 'worldbank/data360-mcp', capability: '指标发现/时间序列', level: 'A', note: '发展/公共政策核心' },
  { id: 'owid-mcp', name: 'Our World in Data MCP', category: 'data', repo: 'pipeworx-io/mcp-owid', capability: '开放指标/元数据', level: 'A' },
  { id: 'fred-mcp', name: 'FRED MCP', category: 'data', repo: 'zachspar/fred-mcp', capability: '宏观经济时间序列', level: 'A', note: '经济学/公共政策' },
  { id: 'eurostat-mcp', name: 'Eurostat MCP', category: 'data', repo: 'dcerecedo/eurostat-mcp', capability: '欧盟统计 API', level: 'B' },
  { id: 'census-mcp', name: 'U.S. Census MCP', category: 'data', repo: 'uscensusbureau/us-census-bureau-data-api-mcp', capability: '人口普查数据', level: 'B' },

  // ── 文档/代码运行时 ──
  { id: 'markitdown-mcp', name: 'MarkItDown MCP', category: 'office', repo: 'microsoft/markitdown', capability: 'URL/PDF/Office→Markdown', level: 'A', note: '统一文档摄取层' },
  { id: 'document-parser-mcp', name: 'Document Parser MCP', category: 'office', repo: 'kgand/document-parser-mcp', capability: '多格式解析抽取', level: 'B' },
  { id: 'pdf-rag-mcp', name: 'PDF RAG MCP', category: 'office', repo: 'MBaranekTech/pdf-rag-mcp', capability: 'PDF 摄取/检索/RAG', level: 'C' },
  { id: 'pdf-tools-mcp', name: 'PDF Tools MCP', category: 'office', repo: 'nfsarch33/pdf-mcp-server', capability: 'PDF 解析/OCR/表格', level: 'C', note: '权限面大,需沙箱' },
  { id: 'jupyter-mcp', name: 'Jupyter MCP', category: 'code', repo: 'datalayer/jupyter-mcp-server', capability: 'Python/Notebook 计算', level: 'A', note: '实证/文本分析基础' },
  { id: 'r-mcp', name: 'R MCP', category: 'code', repo: 'finite-sample/rmcp', capability: 'R 统计/计量', level: 'A', note: '社科实证一级运行时' },
  { id: 'stata-mcp', name: 'Stata MCP', category: 'code', repo: 'shichengg/stata-mcp', capability: 'dofile/持久会话', level: 'A', note: '经济/管理/公共政策' },
  { id: 'duckdb-mcp', name: 'DuckDB MCP', category: 'code', repo: 'mustafahasankhan/duckdb-mcp-server', capability: '本地 SQL 分析', level: 'B', note: 'CSV/Parquet 探索' },
  { id: 'browserless-core', name: 'Browserless (自托管)', category: 'code', repo: 'browserless/browserless', capability: '自托管 headless browser', level: 'C' },
];

export function findMcpCatalogEntry(id: string): McpCatalogEntry | undefined {
  return MCP_CATALOG.find((entry) => entry.id === id);
}
