/**
 * RIS citation format parser (Web of Science / Scopus / compatible RIS exports).
 *
 * RIS entries are tag-value lines (`XX  - value`), separated by `ER  -`.
 * Continuation lines (indented, no tag) are appended to the previous value.
 */

export interface RisEntry {
  title: string;
  authors: string[];
  year: number;
  venue: string;
  abstract: string;
  doi?: string;
  url?: string;
}

/** True when the text looks like RIS (a TY tag line at the start of a line). */
export function isRisFormat(text: string): boolean {
  return /^TY\s{1,2}-\s+/m.test(text);
}

/** Parse RIS text into entries. Tolerant of missing fields. */
export function parseRis(text: string): RisEntry[] {
  const entries: RisEntry[] = [];
  let current: Record<string, string[]> | null = null;
  let lastTag = '';

  const flush = () => {
    if (!current) return;
    const first = (tag: string) => current?.[tag]?.[0]?.trim() ?? '';
    const yearMatch = first('PY').match(/\d{4}/) ?? first('Y1').match(/\d{4}/) ?? first('DA').match(/\d{4}/);
    entries.push({
      title: first('TI') || first('T1'),
      authors: [...(current['AU'] ?? []), ...(current['A1'] ?? [])].map((a) => a.trim()).filter(Boolean),
      year: yearMatch ? parseInt(yearMatch[0], 10) : 0,
      venue: first('JO') || first('JF') || first('T2') || first('JA'),
      abstract: first('AB') || first('N2'),
      doi: first('DO') || undefined,
      url: first('UR') || undefined,
    });
    current = null;
    lastTag = '';
  };

  for (const line of text.split(/\r?\n/)) {
    const tagMatch = line.match(/^([A-Z][A-Z0-9])\s{1,2}-\s?(.*)$/);
    if (tagMatch) {
      const tag = tagMatch[1]!;
      const value = tagMatch[2] ?? '';
      if (tag === 'TY') {
        flush();
        current = {};
        lastTag = tag;
        continue;
      }
      if (tag === 'ER') {
        flush();
        continue;
      }
      if (current) {
        (current[tag] ??= []).push(value);
        lastTag = tag;
      }
      continue;
    }
    // Continuation line: append to the previous tag value.
    if (current && lastTag && line.trim()) {
      const values = current[lastTag];
      if (values && values.length > 0) {
        values[values.length - 1] = `${values[values.length - 1]} ${line.trim()}`;
      }
    }
  }
  flush();
  return entries.filter((e) => e.title);
}
