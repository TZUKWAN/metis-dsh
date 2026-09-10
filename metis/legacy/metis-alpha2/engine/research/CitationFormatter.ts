/**
 * CitationFormatter — 引用体例引擎（T18）。
 *
 * 支持国标 GB/T 7714-2015（顺序编码制 + 著者-出版年制文中引注）、
 * APA 7、Chicago（作者-日期）三套体例。纯确定性格式化，零模型调用：
 * 文中引注与文末著录成对生成，杜绝孤儿引用。
 */

export type CitationStyle = 'gbt7714' | 'apa7' | 'chicago';

export interface CitationSource {
  id: string;
  title: string;
  authors: string[];
  year: number;
  venue: string;
  doi?: string;
  volume?: string;
  issue?: string;
  pages?: string;
}

/** 中文姓名缩写（GB/T）：张伟 → 张；外国人名 ZHANG Wei → ZHANG W。 */
function gbtAuthorName(author: string): string {
  if (/^[\u4e00-\u9fff·]+$/.test(author)) {
    return author; // 中文姓名 GB/T 7714 不缩写（与 2015 版一致）
  }
  const parts = author.trim().split(/\s+/u);
  if (parts.length === 1) return parts[0]!.toUpperCase();
  const family = parts[0]!.toUpperCase();
  const initials = parts.slice(1).map((given) => `${given[0]!.toUpperCase()}`).join(' ');
  return `${family} ${initials}`;
}

function isChineseSource(source: CitationSource): boolean {
  return /[\u4e00-\u9fff]/.test(source.title) || /[\u4e00-\u9fff]/.test(source.venue);
}

function apaAuthors(authors: string[], zh: boolean): string {
  if (authors.length === 0) return zh ? '佚名' : 'Anonymous';
  if (zh) return authors.join('，');
  const formatted = authors.map((author, index) => {
    const parts = author.trim().split(/\s+/u);
    const family = parts[0] ?? author;
    const initials = parts.slice(1).map((given) => `${given[0]!.toUpperCase()}.`).join(' ');
    if (index === authors.length - 1 && authors.length > 1) return `& ${family}, ${initials}`.replace(', ,', ',').replace(/, $/u, '');
    return `${family}, ${initials}`.replace(/, $/u, '');
  });
  return formatted.join(', ').replace(', &', ' &');
}

export function formatBibliographyEntry(source: CitationSource, style: CitationStyle): string {
  const zh = isChineseSource(source);
  switch (style) {
    case 'gbt7714': {
      const authorPart = source.authors.length > 0
        ? source.authors.map((author) => gbtAuthorName(author)).join(zh ? '，' : ', ')
        : (zh ? '佚名' : 'ANON');
      const venuePart = source.venue ? `[J]. ${source.venue}` : '';
      const yearPart = `${source.year || ''}`;
      const volPart = [source.volume, source.issue ? `(${source.issue})` : ''].filter(Boolean).join('');
      const pagePart = source.pages ? `: ${source.pages}` : '';
      const doiPart = source.doi ? `. DOI:${source.doi}` : '';
      return `${authorPart}. ${source.title}${venuePart}, ${yearPart}${volPart ? `,${volPart}` : ''}${pagePart}${doiPart}.`.replace(/\s+/gu, ' ').replace(/,\s*\./u, '.');
    }
    case 'apa7': {
      const authors = apaAuthors(source.authors, zh);
      const year = source.year || 'n.d.';
      const volIssue = [source.volume, source.issue ? `(${source.issue})` : ''].filter(Boolean).join('');
      const pages = source.pages ? `, ${source.pages}` : '';
      const doi = source.doi ? `. https://doi.org/${source.doi}` : '';
      return `${authors} (${year}). ${source.title}. ${source.venue}${volIssue ? `, ${volIssue}` : ''}${pages}${doi}`.replace(/\s+/gu, ' ').replace(/ \./u, '.').replace(/\.\./u, '.');
    }
    case 'chicago': {
      const authors = source.authors.length > 0 ? source.authors.join(zh ? '，' : ', ') : (zh ? '佚名' : 'Anonymous');
      const year = source.year || 'n.d.';
      const volIssue = [source.volume, source.issue ? `, no. ${source.issue}` : ''].filter(Boolean).join('');
      const pages = source.pages ? `: ${source.pages}` : '';
      const doi = source.doi ? `. https://doi.org/${source.doi}` : '';
      return `${authors}. "${source.title}." ${source.venue} ${volIssue} (${year})${pages}${doi}`.replace(/\s+/gu, ' ');
    }
  }
}

/** 文中引注（按引用顺序编号，GB/T 顺序编码制）。 */
export function formatInTextCitation(sources: CitationSource[], style: CitationStyle, sequenceNumber?: number): string {
  switch (style) {
    case 'gbt7714': {
      // 顺序编码制：[1] / [1-3]；未提供序号时退化为著者-年份。
      if (sequenceNumber !== undefined) {
        return `[${sequenceNumber}]`;
      }
      return gbtAuthorYear(sources);
    }
    case 'apa7':
    case 'chicago': {
      return gbtAuthorYear(sources, style === 'apa7' ? '&' : '和');
    }
  }
}

function gbtAuthorYear(sources: CitationSource[], ampersand = '&'): string {
  if (sources.length === 0) return '（佚名，n.d.）';
  const first = sources[0]!;
  const zh = isChineseSource(first);
  const family = first.authors[0]?.trim().split(/\s+/u)[0] ?? (zh ? '佚名' : 'Anonymous');
  const year = first.year || 'n.d.';
  const authorLabel = sources.length > 2
    ? `${family} ${zh ? '等' : 'et al.'}`
    : sources.length === 2
      ? `${family} ${ampersand} ${(sources[1]!.authors[0] ?? '').trim().split(/\s+/u)[0]}`
      : family;
  return zh ? `（${authorLabel}，${year}）` : `(${authorLabel}, ${year})`;
}

export interface CitationBundle {
  style: CitationStyle;
  /** 文末著录（按输入顺序；GB/T 顺序编码制自动编号）。 */
  bibliography: string[];
  /** 与 bibliography 一一对应的文中引注示例。 */
  inText: string[];
}

export function formatCitationBundle(sources: CitationSource[], style: CitationStyle): CitationBundle {
  const bibliography = sources.map((source) => formatBibliographyEntry(source, style));
  const inText = sources.map((source, index) => formatInTextCitation([source], style, style === 'gbt7714' ? index + 1 : undefined));
  return { style, bibliography, inText };
}

/** 一键切换体例：同一组文献重新输出。 */
export function switchCitationStyle(sources: CitationSource[], from: CitationStyle, to: CitationStyle): CitationBundle {
  void from;
  return formatCitationBundle(sources, to);
}
