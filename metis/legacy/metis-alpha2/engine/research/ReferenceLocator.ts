/**
 * Reference section locator for research PDFs (O9, Smart Jump subset).
 *
 * Research PDFs put a References/Bibliography section near the end. Given the
 * per-page text extracted by pdf.js, locate that section's page range and,
 * inside it, find the page that contains a given reference number "[n]" or
 * "(n)". This powers the reader's "jump to references" and "jump to [n]"
 * affordances without full citation-graph parsing.
 *
 * Heuristics only — best-effort, returns null when no section is found.
 */

const SECTION_HEADERS = [
  /^\s*(references|bibliography|references\s+and\s+notes|works\s+cited)\s*$/i,
  /^\s*参考文献\s*$/,
];

/** A located reference section: start page (0-based) and end page. */
export interface ReferenceSection {
  /** 1-based page number where the section starts. */
  startPage: number;
  /** 1-based page number where the section ends (inclusive). */
  endPage: number;
}

/** Find the reference section within a page text map. */
export function findReferenceSection(pageTextMap: Map<number, string>): ReferenceSection | null {
  // Look at the last 40% of pages first — references almost always live there.
  const pageNumbers = [...pageTextMap.keys()].sort((a, b) => a - b);
  if (pageNumbers.length === 0) return null;
  const lastIdx = pageNumbers.length - 1;
  const fromIdx = Math.max(0, Math.floor(lastIdx * 0.55));

  for (let i = lastIdx; i >= fromIdx; i--) {
    const page = pageNumbers[i];
    if (page === undefined) continue;
    const text = pageTextMap.get(page) ?? '';
    const lines = text.split(/\r?\n/);
    const hasHeader = lines.some((line) => SECTION_HEADERS.some((re) => re.test(line.trim())));
    if (hasHeader) {
      // Heuristic: the section runs from this page to the last page that still
      // looks like bibliography (contains bracketed numbers) or is the end.
      let endPage = page;
      for (let j = i + 1; j <= lastIdx; j++) {
        const nextPage = pageNumbers[j];
        if (nextPage === undefined) continue;
        const nextText = pageTextMap.get(nextPage) ?? '';
        if (/\[\d+\]|\(\d+\)|^\s*\d+\s+[A-Z]/m.test(nextText) || j === lastIdx) {
          endPage = nextPage;
        } else {
          break;
        }
      }
      return { startPage: page, endPage };
    }
  }
  return null;
}

/**
 * Find the page within a reference section that contains reference number n.
 * Matches "[n]", "(n)", and a bare "n" at line start. Returns the 1-based page
 * or null when not found.
 */
export function findReferencePage(
  pageTextMap: Map<number, string>,
  section: ReferenceSection,
  refNumber: number,
): number | null {
  const pattern = new RegExp(
    `(\\[${refNumber}\\]|\\(${refNumber}\\)|^\\s*${refNumber}\\s)`,
    'm',
  );
  for (let page = section.startPage; page <= section.endPage; page++) {
    const text = pageTextMap.get(page) ?? '';
    if (pattern.test(text)) return page;
  }
  return null;
}
