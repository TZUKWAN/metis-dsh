import { createHash } from 'node:crypto';
import {
  FUNDING_TEMPLATE_PACKAGE_FORMAT,
  FUNDING_TEMPLATE_PACKAGE_SCHEMA_VERSION,
  FundingTemplateAnalysisRequestSchema,
  FundingTemplateAnalysisResultSchema,
  FundingTemplateDiffSchema,
  FundingTemplatePackageSchema,
  type FundingEvidenceLocator,
  type FundingParagraphObservation,
  type FundingStyleObservation,
  type FundingTableObservation,
  type FundingTemplateAnalysisRequest,
  type FundingTemplateAnalysisResult,
  type FundingTemplateDiff,
  type FundingTemplateObservationDocument,
  type FundingTemplatePackage,
} from '../runtime/FundingTemplateContract.js';

const ANALYZER_VERSION = '1.0.0' as const;
const MAX_OUTPUT_LABEL = 300;
const MAX_OUTPUT_INSTRUCTION = 500;

type AssertionState = 'observed' | 'uncertain' | 'not_observed';
type CanonicalField = FundingTemplatePackage['fieldMappings'][number]['canonicalField'];
type ContentSlot = FundingTemplatePackage['contentSlots'][number];
type Section = FundingTemplatePackage['sections'][number];

interface AnalyzerContext {
  document: FundingTemplateObservationDocument;
  styles: Map<string, FundingStyleObservation>;
  sensitiveBlocks: Set<string>;
}

interface LocatedValue<T> {
  value: T;
  locator: FundingEvidenceLocator;
}

interface HeadingCandidate {
  block: FundingParagraphObservation;
  normalizedTitle: string;
  level: number;
  confidence: number;
}

export interface FundingTemplatePackageVerification {
  ok: boolean;
  code: 'valid' | 'invalid_package' | 'digest_mismatch';
  issues: string[];
  template?: FundingTemplatePackage;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function canonicalizeFundingTemplateValue(value: unknown, seen = new Set<object>()): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Non-finite numbers cannot be canonicalized');
    return JSON.stringify(value);
  }
  if (typeof value !== 'object') throw new Error('Only JSON values can be canonicalized');
  if (seen.has(value)) throw new Error('Cyclic values cannot be canonicalized');
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item) => canonicalizeFundingTemplateValue(item, seen)).join(',')}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error('Only plain JSON objects can be canonicalized');
    }
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalizeFundingTemplateValue(record[key], seen)}`,
    ).join(',')}}`;
  } finally {
    seen.delete(value);
  }
}

function normalizeWhitespace(value: string): string {
  return value.normalize('NFKC').replace(/\s+/gu, ' ').trim();
}

function normalizeLabel(value: string): string {
  return normalizeWhitespace(value)
    .replace(/^(?:[一二三四五六七八九十百]+|\d+)[、.．)）]\s*/u, '')
    .replace(/[：:]$/u, '')
    .slice(0, MAX_OUTPUT_LABEL);
}

function normalizeInstruction(value: string): string {
  return normalizeWhitespace(value).slice(0, MAX_OUTPUT_INSTRUCTION);
}

function comparisonKey(value: string): string {
  return normalizeLabel(value).toLocaleLowerCase('zh-CN').replace(/[\s，,。；;：:()（）【】]/gu, '');
}

function hasSensitiveText(value: string): boolean {
  const normalized = normalizeWhitespace(value);
  return /(?:[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/iu.test(normalized)
    || /(?:^|\D)1[3-9]\d{9}(?:\D|$)/u.test(normalized)
    || /(?:^|\D)\d{17}[\dXx](?:\D|$)/u.test(normalized)
    || /(?:身份证|银行卡|手机号|电子邮箱|家庭住址)\s*[：:]?\s*\S{4,}/u.test(normalized)
    || /(?:api[_ -]?key|secret|token)\s*[=:：]\s*[A-Za-z0-9_\-.]{12,}/iu.test(normalized);
}

function safeForTemplateOutput(text: string, role: string): boolean {
  return role !== 'user_content' && !hasSensitiveText(text);
}

function paragraphLocator(
  document: FundingTemplateObservationDocument,
  paragraph: FundingParagraphObservation,
): FundingEvidenceLocator {
  return {
    documentId: document.documentId,
    sourceDigest: document.sourceDigest,
    pageNumber: paragraph.pageNumber,
    blockId: paragraph.blockId,
    blockKind: 'paragraph',
    cell: null,
    bounds: paragraph.bounds,
    observedTextDigest: sha256(paragraph.text),
  };
}

function tableLocator(
  document: FundingTemplateObservationDocument,
  table: FundingTableObservation,
): FundingEvidenceLocator {
  return {
    documentId: document.documentId,
    sourceDigest: document.sourceDigest,
    pageNumber: table.pageNumber,
    blockId: table.blockId,
    blockKind: 'table',
    cell: null,
    bounds: table.bounds,
    observedTextDigest: null,
  };
}

function cellLocator(
  document: FundingTemplateObservationDocument,
  table: FundingTableObservation,
  cell: FundingTableObservation['cells'][number],
): FundingEvidenceLocator {
  return {
    documentId: document.documentId,
    sourceDigest: document.sourceDigest,
    pageNumber: table.pageNumber,
    blockId: table.blockId,
    blockKind: 'table_cell',
    cell: { rowIndex: cell.rowIndex, columnIndex: cell.columnIndex },
    bounds: cell.bounds,
    observedTextDigest: sha256(cell.text),
  };
}

function pageLocator(
  document: FundingTemplateObservationDocument,
  pageNumber: number,
): FundingEvidenceLocator {
  return {
    documentId: document.documentId,
    sourceDigest: document.sourceDigest,
    pageNumber,
    blockId: `page-${pageNumber}`,
    blockKind: 'page',
    cell: null,
    bounds: null,
    observedTextDigest: null,
  };
}

function notObserved<T>(): {
  state: 'not_observed';
  value: T | null;
  confidence: 0;
  evidence: FundingEvidenceLocator[];
} {
  return { state: 'not_observed', value: null, confidence: 0, evidence: [] };
}

function assertion<T>(
  state: Exclude<AssertionState, 'not_observed'>,
  value: T,
  confidence: number,
  evidence: FundingEvidenceLocator[],
) {
  return {
    state,
    value,
    confidence: Math.max(0.01, Math.min(1, confidence)),
    evidence: evidence.slice(0, 128),
  };
}

function stableId(prefix: string, identity: string): string {
  return `${prefix}:${sha256(identity).slice(0, 24)}`;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  const value = ordered[middle];
  if (value === undefined) return null;
  if (ordered.length % 2 === 1) return value;
  const previous = ordered[middle - 1];
  return previous === undefined ? value : (previous + value) / 2;
}

function inferHeadingLevel(text: string, style: FundingStyleObservation | undefined, bodySize: number | null): number {
  const normalized = normalizeWhitespace(text);
  if (/^[一二三四五六七八九十百]+[、.．)）]/u.test(normalized)) return 1;
  if (/^\d+[、.．)）]/u.test(normalized)) return 2;
  if (/^\d+\.\d+/u.test(normalized)) return 3;
  if (style !== undefined && style.fontSizePt !== null && bodySize !== null) {
    if (style.fontSizePt >= bodySize + 5) return 1;
    if (style.fontSizePt >= bodySize + 2) return 2;
  }
  return 2;
}

function isHeadingCandidate(
  paragraph: FundingParagraphObservation,
  style: FundingStyleObservation | undefined,
  bodySize: number | null,
): boolean {
  if (paragraph.contentRole !== 'template_label') return false;
  const text = normalizeWhitespace(paragraph.text);
  if (text.length === 0 || text.length > MAX_OUTPUT_LABEL) return false;
  const numbered = /^(?:[一二三四五六七八九十百]+|\d+(?:\.\d+)?)[、.．)）]/u.test(text);
  const visuallyProminent = style !== undefined && (
    (style.fontSizePt !== null && bodySize !== null && style.fontSizePt >= bodySize + 2)
    || (style.fontWeight === 'bold' && style.alignment === 'center')
  );
  return numbered || visuallyProminent;
}

function collectSensitiveBlocks(document: FundingTemplateObservationDocument): Set<string> {
  const result = new Set<string>();
  for (const block of document.blocks) {
    if (block.kind === 'paragraph') {
      if (!safeForTemplateOutput(block.text, block.contentRole)) result.add(block.blockId);
      continue;
    }
    if (block.cells.some((cell) => !safeForTemplateOutput(cell.text, cell.contentRole))) {
      result.add(block.blockId);
    }
  }
  return result;
}

function findHeadings(context: AnalyzerContext): HeadingCandidate[] {
  const observedSizes = context.document.blocks.flatMap((block) => {
    if (block.kind !== 'paragraph' || block.contentRole === 'instruction') return [];
    const size = block.styleId === null ? null : context.styles.get(block.styleId)?.fontSizePt;
    return size === null || size === undefined ? [] : [size];
  });
  const bodySize = median(observedSizes);
  const headings: HeadingCandidate[] = [];
  for (const block of context.document.blocks) {
    if (block.kind !== 'paragraph' || context.sensitiveBlocks.has(block.blockId)) continue;
    const style = block.styleId === null ? undefined : context.styles.get(block.styleId);
    if (!isHeadingCandidate(block, style, bodySize)) continue;
    const normalizedTitle = normalizeLabel(block.text);
    if (normalizedTitle.length === 0) continue;
    const confidence = style?.fontSizePt !== null && style?.fontSizePt !== undefined
      ? 0.95
      : 0.82;
    headings.push({
      block,
      normalizedTitle,
      level: inferHeadingLevel(block.text, style, bodySize),
      confidence,
    });
  }
  return headings;
}

function locateSectionForOrdinal(sections: readonly Section[], headings: readonly HeadingCandidate[], ordinal: number): string | null {
  let selected: string | null = null;
  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index];
    if (!heading || heading.block.ordinal > ordinal) break;
    selected = sections[index]?.sectionId ?? null;
  }
  return selected;
}

function parseMaxLength(text: string): { value: number; unit: 'characters' | 'words' } | null {
  const normalized = normalizeWhitespace(text);
  const chinese = normalized.match(/(?:不超过|限|最多)\s*(\d{1,8})\s*(字|字符|词)/u);
  if (chinese) {
    const value = Number(chinese[1]);
    if (Number.isSafeInteger(value) && value > 0) {
      return { value, unit: chinese[2] === '词' ? 'words' : 'characters' };
    }
  }
  const english = normalized.match(/(?:no more than|maximum|max\.?|limit(?:ed)? to)\s*(\d{1,8})\s*(characters?|words?)/iu);
  if (!english) return null;
  const value = Number(english[1]);
  if (!Number.isSafeInteger(value) || value <= 0) return null;
  return { value, unit: english[2]?.toLocaleLowerCase('en-US').startsWith('word') ? 'words' : 'characters' };
}

function instructionKind(text: string, length: ReturnType<typeof parseMaxLength>) {
  if (length !== null) return 'max_length' as const;
  if (/(?:必填|不能为空|required)/iu.test(text)) return 'required' as const;
  if (/(?:格式|字体|字号|排版|format)/iu.test(text)) return 'format' as const;
  if (/(?:提交|上传|报送|submit|upload)/iu.test(text)) return 'submission' as const;
  return 'other' as const;
}

function canonicalFieldForLabel(label: string): { field: CanonicalField; confidence: number } {
  const tests: Array<[RegExp, CanonicalField]> = [
    [/(?:项目|课题|申请)名称|project title/iu, 'project_name'],
    [/(?:申请人|负责人|principal investigator|applicant)/iu, 'applicant'],
    [/(?:依托|责任|所在)单位|organization|institution/iu, 'organization'],
    [/(?:学科|研究方向|discipline)/iu, 'discipline'],
    [/(?:研究基础|前期成果|research basis|prior work)/iu, 'research_basis'],
    [/(?:研究目标|总体目标|objectives?)/iu, 'research_objectives'],
    [/(?:研究方法|方法论|methodology|methods?)/iu, 'research_methods'],
    [/(?:研究计划|研究内容|课题论证|research plan)/iu, 'research_plan'],
    [/(?:预期成果|成果形式|expected outputs?)/iu, 'expected_outputs'],
    [/(?:经费|预算|budget)/iu, 'budget'],
    [/(?:进度|时间安排|schedule|timeline)/iu, 'schedule'],
    [/(?:参考文献|references|bibliography)/iu, 'references'],
  ];
  for (const [pattern, field] of tests) {
    if (pattern.test(label)) return { field, confidence: 0.92 };
  }
  return { field: 'custom', confidence: 0.55 };
}

function contentKindForLabel(label: string): ContentSlot['kind'] {
  if (/(?:金额|经费|预算|数量|number|amount)/iu.test(label)) return 'number';
  if (/(?:日期|时间|date)/iu.test(label)) return 'date';
  if (/(?:附件|上传|attachment)/iu.test(label)) return 'attachment';
  if (/(?:论证|基础|内容|说明|目标|方法|成果|plan|basis|objective|method)/iu.test(label)) return 'rich_text';
  return 'plain_text';
}

function modeAssertion<T extends string | number>(values: readonly LocatedValue<T>[]) {
  if (values.length === 0) return notObserved<T>();
  const counts = new Map<string, { value: T; count: number; evidence: FundingEvidenceLocator[] }>();
  for (const item of values) {
    const key = JSON.stringify(item.value);
    const current = counts.get(key) ?? { value: item.value, count: 0, evidence: [] };
    current.count += 1;
    current.evidence.push(item.locator);
    counts.set(key, current);
  }
  const winner = [...counts.values()].sort((left, right) => right.count - left.count)[0];
  if (!winner) return notObserved<T>();
  const confidence = winner.count / values.length;
  return assertion(confidence === 1 ? 'observed' : 'uncertain', winner.value, confidence, winner.evidence);
}

function styleRuleFromObservations(
  scope: FundingTemplatePackage['typography'][number]['scope'],
  locatedStyles: ReadonlyArray<{ style: FundingStyleObservation; locator: FundingEvidenceLocator }>,
): FundingTemplatePackage['typography'][number] {
  const collect = <T extends string | number>(
    read: (style: FundingStyleObservation) => T | null,
  ): Array<LocatedValue<T>> => locatedStyles.flatMap(({ style, locator }) => {
    const value = read(style);
    return value === null ? [] : [{ value, locator }];
  });
  return {
    scope,
    fontFamily: modeAssertion(collect((style) => style.fontFamily)),
    fontSizePt: modeAssertion(collect((style) => style.fontSizePt)),
    fontWeight: modeAssertion(collect((style) => style.fontWeight)),
    alignment: modeAssertion(collect((style) => style.alignment)),
    lineSpacingPt: modeAssertion(collect((style) => style.lineSpacingPt)),
    paragraphBeforePt: modeAssertion(collect((style) => style.paragraphBeforePt)),
    paragraphAfterPt: modeAssertion(collect((style) => style.paragraphAfterPt)),
  };
}

function styleRule(
  scope: FundingTemplatePackage['typography'][number]['scope'],
  paragraphs: readonly FundingParagraphObservation[],
  context: AnalyzerContext,
): FundingTemplatePackage['typography'][number] {
  const locatedStyles = paragraphs.flatMap((paragraph) => {
    if (paragraph.styleId === null) return [];
    const style = context.styles.get(paragraph.styleId);
    return style ? [{ style, locator: paragraphLocator(context.document, paragraph) }] : [];
  });
  return styleRuleFromObservations(scope, locatedStyles);
}

function tableStyleRule(
  tables: readonly FundingTableObservation[],
  context: AnalyzerContext,
): FundingTemplatePackage['typography'][number] {
  const locatedStyles: Array<{ style: FundingStyleObservation; locator: FundingEvidenceLocator }> = [];
  for (const table of tables) {
    for (const cell of table.cells) {
      if (cell.styleId === null || cell.text.trim().length === 0) continue;
      const style = context.styles.get(cell.styleId);
      if (style) locatedStyles.push({ style, locator: cellLocator(context.document, table, cell) });
    }
  }
  return styleRuleFromObservations('table', locatedStyles);
}

function familyAssertion(context: AnalyzerContext) {
  const candidates: Array<LocatedValue<'national_social_science_fund' | 'ministry_humanities_social_sciences'>> = [];
  for (const block of context.document.blocks) {
    if (block.kind !== 'paragraph' || context.sensitiveBlocks.has(block.blockId)) continue;
    if (block.contentRole !== 'template_label' && block.contentRole !== 'instruction') continue;
    if (/国家社会科学基金/u.test(block.text)) {
      candidates.push({ value: 'national_social_science_fund', locator: paragraphLocator(context.document, block) });
    } else if (/教育部.*(?:人文|社会科学)/u.test(block.text)) {
      candidates.push({ value: 'ministry_humanities_social_sciences', locator: paragraphLocator(context.document, block) });
    }
  }
  if (candidates.length === 0) return notObserved<'national_social_science_fund' | 'ministry_humanities_social_sciences'>();
  const first = candidates[0];
  if (!first) return notObserved<'national_social_science_fund' | 'ministry_humanities_social_sciences'>();
  const agreeing = candidates.filter((candidate) => candidate.value === first.value);
  return assertion(
    agreeing.length === candidates.length ? 'observed' : 'uncertain',
    first.value,
    agreeing.length / candidates.length,
    agreeing.map((candidate) => candidate.locator),
  );
}

function pageLayout(context: AnalyzerContext): FundingTemplatePackage['layout'] {
  const sizeValues = context.document.pages.map((page) => ({
    value: `${page.widthPt}:${page.heightPt}`,
    widthPt: page.widthPt,
    heightPt: page.heightPt,
    locator: pageLocator(context.document, page.pageNumber),
  }));
  const sizeCounts = new Map<string, typeof sizeValues>();
  for (const value of sizeValues) sizeCounts.set(value.value, [...(sizeCounts.get(value.value) ?? []), value]);
  const sizeWinner = [...sizeCounts.values()].sort((left, right) => right.length - left.length)[0];
  const pageSizePt = sizeWinner && sizeWinner[0]
    ? assertion(
      sizeWinner.length === sizeValues.length ? 'observed' : 'uncertain',
      { widthPt: sizeWinner[0].widthPt, heightPt: sizeWinner[0].heightPt },
      sizeWinner.length / sizeValues.length,
      sizeWinner.map((entry) => entry.locator),
    )
    : notObserved<{ widthPt: number; heightPt: number }>();

  const marginValues = context.document.pages.flatMap((page) => page.observedMarginsPt === null ? [] : [{
    value: page.observedMarginsPt,
    locator: pageLocator(context.document, page.pageNumber),
  }]);
  const marginCounts = new Map<string, typeof marginValues>();
  for (const value of marginValues) {
    const key = canonicalizeFundingTemplateValue(value.value);
    marginCounts.set(key, [...(marginCounts.get(key) ?? []), value]);
  }
  const marginWinner = [...marginCounts.values()].sort((left, right) => right.length - left.length)[0];
  const marginsPt = marginWinner && marginWinner[0]
    ? assertion(
      marginWinner.length === context.document.pages.length ? 'observed' : 'uncertain',
      marginWinner[0].value,
      marginWinner.length / context.document.pages.length,
      marginWinner.map((entry) => entry.locator),
    )
    : notObserved<FundingTemplatePackage['layout']['marginsPt']['value'] extends infer T ? Exclude<T, null> : never>();
  return { pageSizePt, marginsPt };
}

function packageWithoutDigest(template: FundingTemplatePackage): Omit<FundingTemplatePackage, 'canonicalDigest'> {
  const { canonicalDigest: _canonicalDigest, ...withoutDigest } = template;
  void _canonicalDigest;
  return withoutDigest;
}

export function computeFundingTemplatePackageDigest(template: FundingTemplatePackage): string {
  return sha256(canonicalizeFundingTemplateValue(packageWithoutDigest(template)));
}

export function verifyFundingTemplatePackage(raw: unknown): FundingTemplatePackageVerification {
  const decoded = FundingTemplatePackageSchema.safeParse(raw);
  if (!decoded.success) {
    return {
      ok: false,
      code: 'invalid_package',
      issues: decoded.error.issues.map((issue) => `${issue.path.join('.') || 'package'}: ${issue.message}`),
    };
  }
  const expected = computeFundingTemplatePackageDigest(decoded.data);
  if (expected !== decoded.data.canonicalDigest) {
    return { ok: false, code: 'digest_mismatch', issues: ['canonicalDigest does not match the package'] };
  }
  return { ok: true, code: 'valid', issues: [], template: decoded.data };
}

export function serializeFundingTemplatePackage(template: FundingTemplatePackage): string {
  const verified = verifyFundingTemplatePackage(template);
  if (!verified.ok || !verified.template) throw new Error(`Cannot serialize funding template: ${verified.code}`);
  return canonicalizeFundingTemplateValue(verified.template);
}

export function decodeFundingTemplatePackage(serialized: string): FundingTemplatePackageVerification {
  try {
    return verifyFundingTemplatePackage(JSON.parse(serialized));
  } catch {
    return { ok: false, code: 'invalid_package', issues: ['Serialized package is not valid JSON'] };
  }
}

function buildTemplate(request: FundingTemplateAnalysisRequest): FundingTemplateAnalysisResult {
  const document = request.document;
  const context: AnalyzerContext = {
    document,
    styles: new Map(document.styles.map((style) => [style.styleId, style])),
    sensitiveBlocks: collectSensitiveBlocks(document),
  };
  const headings = findHeadings(context);
  const headingKeys = headings.map((heading) => comparisonKey(heading.normalizedTitle));
  if (new Set(headingKeys).size !== headingKeys.length) {
    return { ok: false, code: 'duplicate_section', issues: ['Observed section labels are ambiguous after normalization'] };
  }

  const instructionParagraphs = document.blocks.filter(
    (block): block is FundingParagraphObservation => block.kind === 'paragraph'
      && block.contentRole === 'instruction'
      && !context.sensitiveBlocks.has(block.blockId),
  );
  const sections: Section[] = headings.map((heading, index) => {
    const nextOrdinal = headings[index + 1]?.block.ordinal ?? Number.MAX_SAFE_INTEGER;
    const relevantInstructions = instructionParagraphs.filter(
      (paragraph) => paragraph.ordinal > heading.block.ordinal && paragraph.ordinal < nextOrdinal,
    );
    const requiredEvidence = relevantInstructions.filter((paragraph) => /(?:必填|不能为空|required)/iu.test(paragraph.text));
    const headingEvidence = paragraphLocator(document, heading.block);
    return {
      sectionId: stableId('section', `${heading.normalizedTitle}:${index}`),
      normalizedTitle: heading.normalizedTitle,
      level: heading.level,
      order: index,
      required: requiredEvidence.length === 0
        ? notObserved<boolean>()
        : assertion('observed', true, 0.92, requiredEvidence.map((paragraph) => paragraphLocator(document, paragraph))),
      confidence: heading.confidence,
      evidence: [headingEvidence],
    };
  });

  const instructions: FundingTemplatePackage['instructions'] = instructionParagraphs.map((paragraph, index) => {
    const maxLength = parseMaxLength(paragraph.text);
    return {
      instructionId: stableId('instruction', `${paragraph.blockId}:${index}`),
      sectionId: locateSectionForOrdinal(sections, headings, paragraph.ordinal),
      kind: instructionKind(paragraph.text, maxLength),
      normalizedText: normalizeInstruction(paragraph.text),
      maxLength,
      confidence: 0.9,
      evidence: [paragraphLocator(document, paragraph)],
    };
  });

  const tableBlocks = document.blocks.filter((block): block is FundingTableObservation => block.kind === 'table');
  const tables: FundingTemplatePackage['tables'] = [];
  const contentSlots: FundingTemplatePackage['contentSlots'] = [];
  const fieldMappings: FundingTemplatePackage['fieldMappings'] = [];
  const seenSlotLabels = new Set<string>();

  const addSlot = (
    label: string,
    sectionId: string | null,
    kind: ContentSlot['kind'],
    required: ContentSlot['required'],
    maxLength: ContentSlot['maxLength'],
    evidence: FundingEvidenceLocator[],
    identity: string,
  ): boolean => {
    const normalizedLabel = normalizeLabel(label);
    const key = `${sectionId ?? 'root'}:${comparisonKey(normalizedLabel)}`;
    if (normalizedLabel.length === 0 || seenSlotLabels.has(key)) return false;
    seenSlotLabels.add(key);
    const slotId = stableId('slot', identity);
    contentSlots.push({ slotId, sectionId, normalizedLabel, kind, required, maxLength, evidence });
    const mapped = canonicalFieldForLabel(normalizedLabel);
    fieldMappings.push({
      mappingId: stableId('mapping', slotId),
      slotId,
      sourceLabel: normalizedLabel,
      canonicalField: mapped.field,
      confidence: mapped.confidence,
      evidence,
    });
    return true;
  };

  for (const [index, section] of sections.entries()) {
    const representsFormTitle = /(?:申请(?:评审)?书|申报书|(?:申请|申报)(?:表|模板)|application\s+form)/iu.test(section.normalizedTitle);
    if (representsFormTitle) continue;
    const maxInstruction = instructions.find((instruction) => instruction.sectionId === section.sectionId && instruction.maxLength !== null);
    addSlot(
      section.normalizedTitle,
      section.sectionId,
      'rich_text',
      section.required,
      maxInstruction?.maxLength
        ? {
          ...maxInstruction.maxLength,
          confidence: maxInstruction.confidence,
          evidence: maxInstruction.evidence,
        }
        : null,
      section.evidence,
      `section:${section.sectionId}:${index}`,
    );
  }

  const headingBlockIds = new Set(headings.map((heading) => heading.block.blockId));
  for (const paragraph of document.blocks) {
    if (paragraph.kind !== 'paragraph'
      || paragraph.contentRole !== 'template_label'
      || headingBlockIds.has(paragraph.blockId)
      || context.sensitiveBlocks.has(paragraph.blockId)) continue;
    const evidence = [paragraphLocator(document, paragraph)];
    const sectionId = locateSectionForOrdinal(sections, headings, paragraph.ordinal);
    if (!addSlot(
      paragraph.text,
      sectionId,
      contentKindForLabel(paragraph.text),
      notObserved<boolean>(),
      null,
      evidence,
      `paragraph:${paragraph.blockId}`,
    )) {
      return { ok: false, code: 'duplicate_field', issues: ['Observed field labels are duplicated within a section'] };
    }
  }

  for (const table of tableBlocks) {
    const sectionId = locateSectionForOrdinal(sections, headings, table.ordinal);
    const headers = table.cells.flatMap((cell) => {
      if (cell.rowIndex !== 0
        || cell.text.trim().length === 0
        || cell.contentRole !== 'template_label'
        || hasSensitiveText(cell.text)) return [];
      return [{
        columnIndex: cell.columnIndex,
        normalizedLabel: normalizeLabel(cell.text),
        confidence: cell.contentRole === 'template_label' ? 0.95 : 0.65,
        evidence: [cellLocator(document, table, cell)],
      }];
    });
    const headerKeys = headers.map((header) => comparisonKey(header.normalizedLabel));
    if (new Set(headerKeys).size !== headerKeys.length) {
      return { ok: false, code: 'duplicate_field', issues: ['Observed table columns contain duplicate labels'] };
    }
    const outputTableId = stableId('table', table.blockId);
    tables.push({
      tableId: outputTableId,
      sectionId,
      rowCount: table.rowCount,
      columnCount: table.columnCount,
      headers,
      mergedCells: table.cells.filter((cell) => cell.rowSpan > 1 || cell.columnSpan > 1).map((cell) => ({
        rowIndex: cell.rowIndex,
        columnIndex: cell.columnIndex,
        rowSpan: cell.rowSpan,
        columnSpan: cell.columnSpan,
      })),
      confidence: headers.length > 0 ? 0.9 : 0.6,
      evidence: [tableLocator(document, table)],
    });
    for (const header of headers) {
      if (!addSlot(
        header.normalizedLabel,
        sectionId,
        contentKindForLabel(header.normalizedLabel),
        notObserved<boolean>(),
        null,
        header.evidence,
        `table:${table.blockId}:${header.columnIndex}`,
      )) {
        return { ok: false, code: 'duplicate_field', issues: ['Observed table fields duplicate another field in the same section'] };
      }
    }
  }

  if (sections.length === 0 && contentSlots.length === 0 && tables.length === 0) {
    return {
      ok: false,
      code: 'insufficient_template_evidence',
      issues: ['No evidence-backed section, field, or table structure was observed'],
    };
  }

  const headingParagraphs = headings.map((heading) => heading.block);
  const bodyParagraphs = document.blocks.filter(
    (block): block is FundingParagraphObservation => block.kind === 'paragraph'
      && !headingBlockIds.has(block.blockId)
      && block.contentRole !== 'instruction'
      && !context.sensitiveBlocks.has(block.blockId),
  );
  const typography = [
    styleRule('document_body', bodyParagraphs, context),
    styleRule('section_heading', headingParagraphs, context),
    tableStyleRule(tableBlocks, context),
  ];
  const layout = pageLayout(context);
  const qualityIssues: FundingTemplatePackage['quality']['issues'] = [];
  if (sections.length < 2) qualityIssues.push('limited_structure');
  if (typography.every((rule) => rule.fontFamily.state === 'not_observed'
    && rule.fontSizePt.state === 'not_observed')) qualityIssues.push('typography_not_observed');
  if (layout.marginsPt.state === 'not_observed') qualityIssues.push('margins_not_observed');
  if (layout.pageSizePt.state === 'uncertain' || layout.marginsPt.state === 'uncertain') {
    qualityIssues.push('conflicting_layout_observations');
  }
  if (context.sensitiveBlocks.size > 0) qualityIssues.push('sensitive_content_excluded');
  const structuralConfidence = Math.min(1, (sections.length * 2 + contentSlots.length + tables.length) / 8);
  const evidenceConfidence = sections.length > 0
    ? sections.reduce((sum, section) => sum + section.confidence, 0) / sections.length
    : tables.length > 0 ? tables.reduce((sum, table) => sum + table.confidence, 0) / tables.length : 0.5;
  const overallConfidence = Number(((structuralConfidence + evidenceConfidence) / 2).toFixed(4));

  const withoutDigest: Omit<FundingTemplatePackage, 'canonicalDigest'> = {
    format: FUNDING_TEMPLATE_PACKAGE_FORMAT,
    schemaVersion: FUNDING_TEMPLATE_PACKAGE_SCHEMA_VERSION,
    templateId: request.templateId,
    templateVersion: request.templateVersion,
    createdAt: request.createdAt,
    analyzerVersion: ANALYZER_VERSION,
    source: {
      authority: 'user_upload',
      officialCurrency: 'not_asserted',
      documentId: document.documentId,
      sourceFormat: document.sourceFormat,
      sourceDigest: document.sourceDigest,
      observationDigest: sha256(canonicalizeFundingTemplateValue(document)),
      pageCount: document.pageCount,
      fundingFamily: familyAssertion(context),
    },
    sections,
    instructions,
    tables,
    contentSlots,
    fieldMappings,
    typography,
    layout,
    quality: {
      status: overallConfidence >= 0.75 && qualityIssues.length <= 1 ? 'ready' : 'needs_review',
      overallConfidence,
      issues: qualityIssues,
    },
    privacy: {
      rawTextStored: false,
      sourceTextRetention: 'none',
      sensitiveBlocksExcluded: context.sensitiveBlocks.size,
    },
  };
  const candidate: FundingTemplatePackage = {
    ...withoutDigest,
    canonicalDigest: sha256(canonicalizeFundingTemplateValue(withoutDigest)),
  };
  const parsed = FundingTemplatePackageSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      ok: false,
      code: 'invalid_package',
      issues: parsed.error.issues.map((issue) => `${issue.path.join('.') || 'package'}: ${issue.message}`),
    };
  }
  return { ok: true, template: parsed.data };
}

export function analyzeFundingTemplate(raw: unknown): FundingTemplateAnalysisResult {
  const request = FundingTemplateAnalysisRequestSchema.safeParse(raw);
  if (!request.success) {
    return FundingTemplateAnalysisResultSchema.parse({
      ok: false,
      code: 'invalid_input',
      issues: request.error.issues.map((issue) => `${issue.path.join('.') || 'request'}: ${issue.message}`),
    });
  }
  return FundingTemplateAnalysisResultSchema.parse(buildTemplate(request.data));
}

interface DiffEntity {
  entity: FundingTemplateDiff['changes'][number]['entity'];
  key: string;
  value: unknown;
}

function packageEntities(template: FundingTemplatePackage): DiffEntity[] {
  return [
    { entity: 'source' as const, key: 'source:upload', value: template.source },
    ...template.sections.map((value) => ({ entity: 'section' as const, key: value.sectionId, value })),
    ...template.instructions.map((value) => ({ entity: 'instruction' as const, key: value.instructionId, value })),
    ...template.tables.map((value) => ({ entity: 'table' as const, key: value.tableId, value })),
    ...template.contentSlots.map((value) => ({ entity: 'content_slot' as const, key: value.slotId, value })),
    ...template.fieldMappings.map((value) => ({ entity: 'field_mapping' as const, key: value.mappingId, value })),
    ...template.typography.map((value) => ({ entity: 'typography' as const, key: `typography:${value.scope}`, value })),
    { entity: 'layout' as const, key: 'layout:page', value: template.layout },
    { entity: 'quality' as const, key: 'quality:analysis', value: template.quality },
  ];
}

export function diffFundingTemplatePackages(
  previousRaw: unknown,
  nextRaw: unknown,
): FundingTemplateDiff {
  const previous = verifyFundingTemplatePackage(previousRaw);
  const next = verifyFundingTemplatePackage(nextRaw);
  if (!previous.ok || !previous.template) throw new Error(`Previous package is invalid: ${previous.code}`);
  if (!next.ok || !next.template) throw new Error(`Next package is invalid: ${next.code}`);
  if (previous.template.templateId !== next.template.templateId) throw new Error('Template identifiers do not match');
  if (next.template.templateVersion <= previous.template.templateVersion) {
    throw new Error('Reanalysis must advance the template version');
  }
  const previousEntities = new Map(packageEntities(previous.template).map((entry) => [`${entry.entity}:${entry.key}`, entry]));
  const nextEntities = new Map(packageEntities(next.template).map((entry) => [`${entry.entity}:${entry.key}`, entry]));
  const identities = [...new Set([...previousEntities.keys(), ...nextEntities.keys()])].sort();
  const changes: FundingTemplateDiff['changes'] = [];
  for (const identity of identities) {
    const before = previousEntities.get(identity);
    const after = nextEntities.get(identity);
    const beforeDigest = before ? sha256(canonicalizeFundingTemplateValue(before.value)) : null;
    const afterDigest = after ? sha256(canonicalizeFundingTemplateValue(after.value)) : null;
    if (beforeDigest === afterDigest) continue;
    const sample = after ?? before;
    if (!sample) continue;
    changes.push({
      kind: before === undefined ? 'added' : after === undefined ? 'removed' : 'changed',
      entity: sample.entity,
      key: sample.key,
      beforeDigest,
      afterDigest,
    });
  }
  const withoutDigest: Omit<FundingTemplateDiff, 'diffDigest'> = {
    schemaVersion: 1,
    templateId: previous.template.templateId,
    fromVersion: previous.template.templateVersion,
    toVersion: next.template.templateVersion,
    fromDigest: previous.template.canonicalDigest,
    toDigest: next.template.canonicalDigest,
    changes,
    breaking: changes.some((change) => change.kind === 'removed'
      || (change.kind === 'changed' && ['section', 'content_slot', 'field_mapping', 'layout'].includes(change.entity))),
  };
  return FundingTemplateDiffSchema.parse({
    ...withoutDigest,
    diffDigest: sha256(canonicalizeFundingTemplateValue(withoutDigest)),
  });
}
