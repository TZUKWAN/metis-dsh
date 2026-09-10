/**
 * PaperRecordCleaner — 题录确定性清洗（LIT-CLEAN-01，T15）。
 *
 * 旧浏览器时代从网页采集的题录带有系统性脏数据：
 *  - 标题携带来源站后缀（" - 中国知网"、" _ 知网"、"| CNKI" 等）；
 *  - 摘要误抓了网页导航文字（"总库 检索 CNKI AI 出版来源 …"）。
 * 本模块用确定性规则修复（不经模型，零 token、可预期），
 * 返回修复后的字段与修复项清单，未命中规则的字段保持原样。
 */

/** 来源站标题后缀（不区分大小写、允许中英文连接符与空白变体）。 */
const TITLE_SOURCE_SUFFIXES: RegExp[] = [
  /\s*[-_|–—]+\s*中国知网\s*$/u,
  /\s*[-_|–—]+\s*知网\s*$/u,
  /\s*[-_|–—]+\s*CNKI\s*$/iu,
  /\s*[-_|–—]+\s*百度学术\s*$/u,
  /\s*[-_|–—]+\s*谷歌学术\s*$/u,
  /\s*[-_|–—]+\s*Google\s+Scholar\s*$/iu,
  /\s*[-_|–—]+\s*万方数据\s*$/u,
  /\s*[-_|–—]+\s*维普\s*$/u,
  /\s*[-_|–—]+\s*arxiv\s*$/iu,
];

/** 摘要开头的网页导航/操作词 —— 命中即判定摘要被误抓。 */
const ABSTRACT_NAVIGATOR_PREFIXES: RegExp[] = [
  /^(总库|检索|CNKI|出版来源|我的CNKI|充值|会员|文献知网节|首页|登录|注册|下载APP|客户端)/u,
  /^(摘要|全文|快照)\s*[:：]/u,
  /^\s*(如何|怎么样?)/u,
];

/** 摘要包含明显的整站导航组合时也判定为误抓。 */
const ABSTRACT_NAVIGATOR_DENSITY = /(?:总库|文献知网节|我的CNKI|充值|会员|出版来源|服务推荐|智能写作|职称评审)/gu;

export interface CleanResult {
  title: string;
  abstract: string;
  changes: Array<'title_source_suffix' | 'abstract_navigator_text'>;
}

function isNavigatorAbstract(abstract: string): boolean {
  const text = abstract.trim();
  if (!text) return false;
  for (const pattern of ABSTRACT_NAVIGATOR_PREFIXES) {
    if (pattern.test(text)) return true;
  }
  const navigatorHits = text.match(ABSTRACT_NAVIGATOR_DENSITY)?.length ?? 0;
  // 短摘要里出现 ≥3 个导航词，或摘要过短且以问句开头，都视为误抓。
  return navigatorHits >= 3;
}

export function cleanPaperRecord(paper: { title: string; abstract: string }): CleanResult {
  const changes: CleanResult['changes'] = [];
  let title = paper.title;
  for (const pattern of TITLE_SOURCE_SUFFIXES) {
    const next = title.replace(pattern, '').trim();
    if (next !== title && next.length > 0) {
      title = next;
      changes.push('title_source_suffix');
      break;
    }
  }
  let abstract = paper.abstract;
  if (isNavigatorAbstract(abstract)) {
    abstract = '';
    changes.push('abstract_navigator_text');
  }
  return { title, abstract, changes };
}

/** 批量清洗：返回发生了变化的条目（保留原 id 以便回写）。 */
export function cleanPaperRecords<T extends { id: string; title: string; abstract: string }>(papers: T[]): Array<T & { cleaned: CleanResult }> {
  const results: Array<T & { cleaned: CleanResult }> = [];
  for (const paper of papers) {
    const cleaned = cleanPaperRecord(paper);
    if (cleaned.changes.length > 0) results.push({ ...paper, cleaned });
  }
  return results;
}
