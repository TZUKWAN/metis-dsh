/**
 * SubmissionVenueMatching（2026-09-01 刘总报告：匹配到的会议/期刊与论文毫无关系）
 *
 * 旧策略的两个致命伤：
 *   1. 查询词直接用成果标题——而成果标题是"场景名 + 交付物"这类工作流元信息，
 *      不是论文主题；中文工作流名砸给 OpenAlex 只能搜回不相干的东西。
 *   2. 搜到什么就聚合什么，零相关性门槛——机电、电商论文都能当"近期相关论文"
 *      凑数，候选期刊自然全是噪音。
 *
 * 新策略（确定性，无 AI 依赖）：
 *   - buildVenueMatchQuery：从论文正文（词频统计）提取主题关键词构造查询，
 *     标题只做兜底；剥离"交付物/最终成果"等元信息噪声。
 *   - filterRelevantPapers：搜到的每篇论文标题必须与关键词集合有实质重叠
 *     （拉丁词命中 / 中文关键词子串命中），零命中的论文直接剔除，不进入聚合。
 */

const LATIN_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'are', 'was', 'were', 'have', 'has',
  'their', 'them', 'they', 'its', 'into', 'onto', 'about', 'based', 'study', 'research',
  'analysis', 'paper', 'review', 'approach', 'application', 'applications', 'case',
  'journal', 'science', 'sciences', 'international', 'chinese', 'china', 'proceedings',
]);

/** 高频虚词/格式词：分词时视作分隔符，不作为主题词。 */
const CJK_STOPCHARS = new Set('的了与及和或在为对从被把是将更要就也都还又再才只等之其此通过基于对于关于我们你们它们它是有着给让向往自从以已曾经正在将会可以能够应当应该需要同时另外此外因此所以然而但是尽管虽然不仅并且而且或者例如比如即譬如首先其次最后其中目前当前近年来指出认为提出介绍探讨分析研究论文综述文献工作流写作系统管理使用方法结果讨论结论摘要关键词参考文献出版发表期刊杂志大学学报出版社一些一种一方面另一方面某种某些不同进行发展影响存在形成提供实现');

const META_TITLE_NOISE = /(交付物|最终成果|定稿|终稿|初稿|草稿|工作流|写作|生成物)/gu;

export interface VenueMatchPaper {
  title: string;
  year?: number | null;
  venue?: string | null;
  doi?: string | null;
  issn?: string | null;
  source?: string;
}

export interface VenueMatchKeywords {
  query: string;
  keywords: string[];
}

function isCjk(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return code >= 0x4e00 && code <= 0x9fff;
}

function isLatinWord(text: string): boolean {
  return /^[a-z][a-z-]{2,}$/u.test(text);
}

/**
 * 从正文提取主题关键词：拉丁实词按词频；中文按"停用字切分后的连续片段 +
 * 片段内高频二元组"计频。标题噪声（交付物等）先剥离。
 */
const CJK_FUNCTION_CHARS = new Set('的了与及和或在为对从被把是将更要就也都还又再才等之其此同时因此所以然而虽然并且或者例如即其中作为但是不仅而且');
const CJK_STOP_WORDS = new Set<string>(["研究","论文","综述","文献","分析","探讨","工作流","写作","系统","方法","结果","摘要","关键词","使用","进行","发展","影响","存在","形成","提供","实现","出版","发表","期刊","杂志","大学","学报","出版社","一些","一种","不同","某种","某些","相关","问题","维度","视角","背景","意义","内容","特征","因素","机制","模式","视角"]);

/**
 * 从正文提取主题关键词：按单字虚词把中文连续段切成片段（片段即主题词，
 * 如「平台劳动」「劳动社会学」），超长片段再补二元组兜底；拉丁实词按词频。
 * 标题权重 ×2；命中计数 <2 的丢弃；被更长入选词包含的碎片去重。
 */
export function extractVenueMatchKeywords(contentText: string, title = '', limit = 8): string[] {
  const frequencies = new Map<string, number>();
  const bump = (term: string) => { if (!term) return; frequencies.set(term, (frequencies.get(term) ?? 0) + 1); };
  const cleanedTitle = title.replace(META_TITLE_NOISE, ' ');
  const sources = `${cleanedTitle} ${cleanedTitle} ${contentText}`.toLowerCase();
  for (const word of sources.match(/[a-z][a-z-]{2,}/gu) ?? []) {
    if (LATIN_STOPWORDS.has(word)) continue;
    bump(word);
  }
  for (const run of sources.match(/[一-鿿]+/gu) ?? []) {
    let segment = '';
    const flush = () => {
      if (segment.length < 2) { segment = ''; return; }
      if (!CJK_STOP_WORDS.has(segment) && segment.length <= 12) bump(segment);
      if (segment.length > 5) {
        for (let i = 0; i + 2 <= segment.length; i += 1) bump(segment.slice(i, i + 2));
      }
      segment = '';
    };
    for (const char of run) {
      if (CJK_FUNCTION_CHARS.has(char)) flush();
      else segment += char;
    }
    flush();
  }
  const ranked = [...frequencies.entries()]
    .filter(([term, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .map(([term]) => term);
  const picked: string[] = [];
  for (const term of ranked) {
    if (picked.some((chosen) => chosen.includes(term) || term.includes(chosen))) continue;
    picked.push(term);
    if (picked.length >= limit) break;
  }
  return picked;
}

/** 组装检索查询：关键词优先，正文为空时退回剥噪标题。 */
export function buildVenueMatchQuery(contentText: string, title: string, maxLength = 200): VenueMatchKeywords {
  const cleanedTitle = title.replace(META_TITLE_NOISE, ' ').replace(/\s+/gu, ' ').trim();
  // 正文不可读时退回整条净标题（旧行为）；有关正文时关键词策略才生效。
  if (!contentText.trim()) {
    return { query: cleanedTitle.slice(0, maxLength), keywords: cleanedTitle ? [cleanedTitle] : [] };
  }
  const keywords = extractVenueMatchKeywords(contentText, cleanedTitle);
  if (keywords.length === 0) {
    return { query: cleanedTitle.slice(0, maxLength), keywords: cleanedTitle ? [cleanedTitle] : [] };
  }
  return { query: keywords.join(' ').slice(0, maxLength), keywords };
}

/** 论文标题与关键词集的相关性：命中 ≥1 即相关，返回命中数。 */
export function venuePaperRelevance(paperTitle: string, keywords: readonly string[]): number {
  const title = paperTitle.toLowerCase();
  let hits = 0;
  for (const keyword of keywords) {
    if (isLatinWord(keyword)) {
      if (new RegExp(`(?:^|[^a-z])${keyword}(?:[^a-z]|$)`, 'u').test(title)) hits += 1;
    } else if (keyword && title.includes(keyword.toLowerCase())) hits += 1;
  }
  return hits;
}

/** 相关性门槛：零命中的论文剔除，不进入期刊聚合；按命中数降序。 */
export function filterRelevantPapers<T extends VenueMatchPaper>(papers: readonly T[], keywords: readonly string[]): Array<T & { relevance: number }> {
  if (keywords.length === 0) return [];
  return papers
    .map((paper) => ({ ...paper, relevance: venuePaperRelevance(paper.title, keywords) }))
    .filter((paper) => paper.relevance > 0)
    .sort((a, b) => b.relevance - a.relevance);
}

/** 从成果内容提取可用于匹配的纯文本（word 块文本；其余类型返回空串走标题兜底）。 */
export function outcomeContentToMatchText(content: unknown): string {
  if (!content || typeof content !== 'object') return '';
  const document = content as { type?: string; blocks?: Array<{ text?: unknown }>; pages?: Array<{ elements?: Array<{ text?: unknown }> }> };
  if (document.type === 'word' && Array.isArray(document.blocks)) {
    return document.blocks.map((block) => (typeof block.text === 'string' ? block.text : '')).join('\n');
  }
  if (document.type === 'ppt' && Array.isArray(document.pages)) {
    return document.pages
      .flatMap((page) => (Array.isArray(page.elements) ? page.elements.map((element) => (typeof element.text === 'string' ? element.text : '')) : []))
      .join('\n');
  }
  return '';
}
