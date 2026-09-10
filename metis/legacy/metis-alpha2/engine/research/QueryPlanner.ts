/**
 * METIS 哲学社会科学 Search Planner(2026-09-05 刘总要求,任务7 Web Research 3.1)。
 *
 * 哲社检索不能只拿用户原句搜一次:本模块把研究问题自动扩展为多源、多语种、
 * 多概念的检索词组(中文/英文/理论概念/相反观点/上位下位概念),供
 * web_search / 学术工具 / 选题模块使用。纯函数,无 I/O。
 */

export interface SearchPlanQuery {
  query: string;
  language: 'zh' | 'en';
  /** 检索意图维度:core=核心概念 / theory=理论视角 / contrast=相反观点 / source=原始来源。 */
  dimension: 'core' | 'theory' | 'contrast' | 'source';
}

export interface SearchPlan {
  originalQuery: string;
  queries: SearchPlanQuery[];
  /** 覆盖审计提示(哲社检索完整性检查清单)。 */
  coverageChecklist: string[];
}

/** 高频哲社概念的中英映射(检索扩展用,覆盖劳动/数字/治理/城市化等常见主题)。 */
const ZH_EN_CONCEPTS: ReadonlyArray<readonly [string, string]> = [
  ['生成式人工智能', 'generative AI'],
  ['人工智能', 'artificial intelligence'],
  ['知识劳动者', 'knowledge workers'],
  ['知识工作', 'knowledge work'],
  ['劳动者', 'workers'],
  ['技能形成', 'skill formation'],
  ['技能', 'skills'],
  ['劳动过程', 'labor process'],
  ['劳动控制', 'labor control'],
  ['算法管理', 'algorithmic management'],
  ['平台劳动', 'platform labor'],
  ['零工经济', 'gig economy'],
  ['职业分层', 'occupational stratification'],
  ['职业流动', 'career mobility'],
  ['内部分层', 'internal stratification'],
  ['分层', 'stratification'],
  ['工作场所学习', 'workplace learning'],
  ['数字劳动', 'digital labor'],
  ['社会治理', 'social governance'],
  ['基层治理', 'grassroots governance'],
  ['城市化', 'urbanization'],
  ['老龄化', 'population aging'],
  ['乡村振兴', 'rural revitalization'],
  ['社会流动', 'social mobility'],
  ['阶层', 'class'],
  ['性别不平等', 'gender inequality'],
  ['变量', 'variables'],
  ['机制', 'mechanism'],
];

/** 理论视角词典:出现相关中文概念时补英文理论检索词。 */
const THEORY_LENS: ReadonlyArray<readonly [RegExp, string]> = [
  [/劳动|工作|职业|技能|劳动者/u, 'labor process theory'],
  [/劳动|工作|职业|技能/u, 'skill-biased technological change'],
  [/平台|算法|数字/u, 'platform society'],
  [/治理|政策|政府/u, 'governance theory'],
  [/分层|不平等|阶层|流动/u, 'social stratification theory'],
  [/学习|教育|培训/u, 'professional socialization'],
  [/研究|论文|综述/u, 'literature review methodology'],
];

/** 相反观点触发词:为争议性主题生成反向检索。 */
const CONTRAST_HINTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/影响|效应|冲击|改变/u, '相反观点 争论'],
  [/影响|effect|impact/u, 'contrasting findings debate'],
];

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

/** 把研究问题拆为中文关键词串与英文关键词串。 */
export function extractConcepts(query: string): { zh: string[]; en: string[] } {
  const zh: string[] = [];
  const en: string[] = [];
  for (const [zhTerm, enTerm] of ZH_EN_CONCEPTS) {
    if (query.includes(zhTerm)) {
      zh.push(zhTerm);
      en.push(enTerm);
    }
  }
  // 英文原句中的词也可直接成为检索词(取信息量大的长词)。
  if (/[a-zA-Z]{4,}/u.test(query)) {
    for (const word of query.split(/[^a-zA-Z]+/u)) {
      if (word.length >= 5) en.push(word.toLowerCase());
    }
  }
  return { zh: dedupe(zh).slice(0, 6), en: dedupe(en).slice(0, 8) };
}

/** 构建哲学社会科学检索计划(文档二十九节:自动扩展,不是拿原句搜一次)。 */
export function buildSearchPlan(originalQuery: string): SearchPlan {
  const query = originalQuery.trim();
  const { zh, en } = extractConcepts(query);
  const queries: SearchPlanQuery[] = [];

  // 1. 原句与中文核心组合
  queries.push({ query, language: /[\u4e00-\u9fff]/u.test(query) ? 'zh' : 'en', dimension: 'core' });
  if (zh.length >= 2) {
    queries.push({ query: zh.slice(0, 3).join(' '), language: 'zh', dimension: 'core' });
  }
  // 2. 英文核心组合
  if (en.length >= 2) {
    queries.push({ query: en.slice(0, 4).join(' '), language: 'en', dimension: 'core' });
  }
  // 3. 理论视角
  const theoryQueries: string[] = [];
  for (const [pattern, lens] of THEORY_LENS) {
    if (pattern.test(query) || en.some((term) => lens.includes(term))) {
      theoryQueries.push(lens);
    }
  }
  for (const lens of dedupe(theoryQueries).slice(0, 2)) {
    const anchor = en[0] ?? query;
    queries.push({ query: `${anchor} ${lens}`, language: 'en', dimension: 'theory' });
  }
  // 4. 相反观点/争论
  for (const [pattern, contrast] of CONTRAST_HINTS) {
    if (pattern.test(query)) {
      const anchorZh = zh[0];
      queries.push({
        query: anchorZh ? `${anchorZh} ${contrast}` : contrast,
        language: /[\u4e00-\u9fff]/u.test(contrast) ? 'zh' : 'en',
        dimension: 'contrast',
      });
      break;
    }
  }
  // 5. 原始来源(经典/政策/一手)
  if (/[\u4e00-\u9fff]/u.test(query)) {
    queries.push({ query: `${query} 政策文件 原始文献`, language: 'zh', dimension: 'source' });
  } else {
    queries.push({ query: `${query} primary sources policy documents`, language: 'en', dimension: 'source' });
  }

  const seen = new Set<string>();
  const uniqueQueries = queries.filter((item) => {
    const key = item.query.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return {
    originalQuery: query,
    queries: uniqueQueries,
    coverageChecklist: [
      '是否同时覆盖中文与英文来源?',
      '是否只有二手来源?缺经典/原始文本吗?',
      '是否缺少相反解释或争论性文献?',
      '是否把观点当事实?经验结论是否外推过度?',
      '来源时间是否过旧?是否有最新进展?',
      '引用是否可核验(DOI/URL)?',
    ],
  };
}
