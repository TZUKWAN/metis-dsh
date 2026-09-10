import { describe, expect, it } from 'vitest';
import {
  OutcomeDefaultTemplateSetRequestSchema,
  OutcomeTemplateDeleteRequestSchema,
  OutcomeTemplateKindSchema,
  OutcomeTemplateListRequestSchema,
  OutcomeTemplateUpdateRequestSchema,
  WordFormattingConfigSchema,
  WordFormattingTemplateDefinitionSchema,
  decodePptTemplateDefinition,
  serializeOutcomeTemplateDefinition,
} from '../../engine/runtime/OutcomeRuntimeContract.js';

const fullDefinition = {
  config: {
    page: { paper: 'A4', marginTopCm: 2.54, marginBottomCm: 2.54, marginLeftCm: 3.17, marginRightCm: 3.17 },
    body: { fontFamily: '宋体', fontSizePt: 12, color: '#17243A', align: 'justify', firstLineIndentChars: 2, lineSpacing: 1.5, spaceBeforePt: 0, spaceAfterPt: 6 },
    headings: { '1': { fontFamily: '黑体', fontSizePt: 16, align: 'center', spaceBeforePt: 12, spaceAfterPt: 6 }, '2': { fontSizePt: 14 }, '3': {}, '4': {}, '5': {}, '6': {} },
    captions: { fontFamily: '宋体', fontSizePt: 10.5, align: 'center' },
  },
  header: '研究报告',
  footer: 'METIS · 草稿',
  pageNumber: true,
};

describe('OutcomeTemplate contract', () => {
  it('accepts a complete word formatting template definition with document furniture defaults', () => {
    const parsed = WordFormattingTemplateDefinitionSchema.parse({ config: { body: { fontSizePt: 12 } } });
    expect(parsed.header).toBe('');
    expect(parsed.footer).toBe('');
    expect(parsed.pageNumber).toBe(false);
    const full = WordFormattingTemplateDefinitionSchema.parse(fullDefinition);
    expect(full.config.body?.fontFamily).toBe('宋体');
    expect(full.pageNumber).toBe(true);
  });

  it('rejects out-of-range formatting values at the contract boundary', () => {
    expect(WordFormattingConfigSchema.safeParse({ body: { fontSizePt: 200 } }).success).toBe(false);
    expect(WordFormattingConfigSchema.safeParse({ page: { marginTopCm: 42 } }).success).toBe(false);
    expect(WordFormattingConfigSchema.safeParse({ body: { lineSpacing: 0.1 } }).success).toBe(false);
    expect(WordFormattingConfigSchema.safeParse({ body: { firstLineIndentChars: -1 } }).success).toBe(false);
    expect(WordFormattingConfigSchema.safeParse({ body: { color: 'red' } }).success).toBe(false);
    expect(WordFormattingConfigSchema.safeParse({ headings: { '9': {} } }).success).toBe(false);
  });

  it('restricts template kinds to ppt and word_formatting', () => {
    expect(OutcomeTemplateKindSchema.safeParse('ppt').success).toBe(true);
    expect(OutcomeTemplateKindSchema.safeParse('word_formatting').success).toBe(true);
    expect(OutcomeTemplateKindSchema.safeParse('ppt_generation_skill').success).toBe(false);
  });

  it('requires an update request to change name or definition', () => {
    expect(OutcomeTemplateUpdateRequestSchema.safeParse({ id: 'tpl-1', kind: 'word_formatting' }).success).toBe(false);
    expect(OutcomeTemplateUpdateRequestSchema.safeParse({ id: 'tpl-1', kind: 'ppt', name: '新名' }).success).toBe(true);
    expect(OutcomeTemplateUpdateRequestSchema.safeParse({ id: 'tpl-1', kind: 'ppt', definition: { theme: { primary: '#236c91' } } }).success).toBe(true);
  });

  it('validates delete, list, and default-set requests by kind', () => {
    expect(OutcomeTemplateDeleteRequestSchema.safeParse({ id: 'tpl-1', kind: 'word_formatting' }).success).toBe(true);
    expect(OutcomeTemplateDeleteRequestSchema.safeParse({ id: '', kind: 'ppt' }).success).toBe(false);
    expect(OutcomeTemplateListRequestSchema.parse({ kind: 'ppt' })).toEqual({ kind: 'ppt' });
    expect(OutcomeDefaultTemplateSetRequestSchema.safeParse({ kind: 'ppt', templateId: null }).success).toBe(true);
    expect(OutcomeDefaultTemplateSetRequestSchema.safeParse({ kind: 'word_formatting', templateId: 'tpl-2' })).toEqual({ success: true, data: { kind: 'word_formatting', templateId: 'tpl-2' } });
  });
});

const pptElement = (id: string, x = 0, y = 0, width = 4, height = 2) => ({
  id, type: 'rect' as const, x, y, width, height, locked: false, props: {},
});
const pptPage = (id: string, elements: Array<ReturnType<typeof pptElement>> = []) => ({
  id, title: id, pageType: 'content', humanModified: false, status: 'complete' as const, elements,
});

describe('decodePptTemplateDefinition', () => {
  it('accepts ratio-only and theme-only partial templates', () => {
    expect(decodePptTemplateDefinition({ ratio: '4:3' }, '16:9')).toEqual({ ratio: '4:3' });
    expect(decodePptTemplateDefinition({ theme: { primary: '#236c91' } }, '16:9')).toEqual({ theme: { primary: '#236c91' } });
  });

  it('decodes a full definition and keeps ratio, theme and pages', () => {
    const pages = [pptPage('p1', [pptElement('e1', 28, 0, 4, 18)])];
    const decoded = decodePptTemplateDefinition({ ratio: '16:9', theme: { text: '#183b59' }, pages }, '16:9');
    expect(decoded).toEqual({ ratio: '16:9', theme: { text: '#183b59' }, pages });
  });

  it('rejects invalid ratio, non-object theme and empty definitions', () => {
    expect(decodePptTemplateDefinition({ ratio: '21:9' }, '16:9')).toBeUndefined();
    expect(decodePptTemplateDefinition({ theme: [] }, '16:9')).toBeUndefined();
    expect(decodePptTemplateDefinition({ theme: null }, '16:9')).toBeUndefined();
    expect(decodePptTemplateDefinition({}, '16:9')).toBeUndefined();
    expect(decodePptTemplateDefinition('nope', '16:9')).toBeUndefined();
  });

  it('rejects empty page arrays and duplicate page/element ids', () => {
    expect(decodePptTemplateDefinition({ ratio: '16:9', pages: [] }, '16:9')).toBeUndefined();
    expect(decodePptTemplateDefinition({ pages: [pptPage('p1'), pptPage('p1')] }, '16:9')).toBeUndefined();
    expect(decodePptTemplateDefinition({ pages: [pptPage('p1', [pptElement('e1'), pptElement('e1')])] }, '16:9')).toBeUndefined();
    expect(decodePptTemplateDefinition({ pages: [pptPage('p1', [pptElement('e1')]), pptPage('p2', [pptElement('e1')])] }, '16:9')).toBeUndefined();
  });

  it('enforces grid bounds per ratio for template pages', () => {
    expect(decodePptTemplateDefinition({ pages: [pptPage('p1', [pptElement('e1', 29, 0, 4, 2)])] }, '16:9')).toBeUndefined();
    expect(decodePptTemplateDefinition({ pages: [pptPage('p1', [pptElement('e1', 0, 17, 4, 2)])] }, '16:9')).toBeUndefined();
    // 4:3 fallback grid is 24 wide: a 32-grid element overflows it.
    expect(decodePptTemplateDefinition({ pages: [pptPage('p1', [pptElement('e1', 28, 0, 4, 2)])] }, '4:3')).toBeUndefined();
    // The same element is fine once the definition declares 16:9.
    expect(decodePptTemplateDefinition({ ratio: '16:9', pages: [pptPage('p1', [pptElement('e1', 28, 0, 4, 2)])] }, '4:3')).toBeDefined();
  });
});

describe('serializeOutcomeTemplateDefinition', () => {
  it('round-trips normal definitions and enforces the byte budget', () => {
    const definition = { ratio: '16:9' as const, theme: { primary: '#236c91' } };
    expect(JSON.parse(serializeOutcomeTemplateDefinition(definition))).toEqual(definition);
    const oversized = { theme: { junk: 'x'.repeat(1_100_000) } };
    expect(() => serializeOutcomeTemplateDefinition(oversized)).toThrow('outcome_template_definition_too_large');
  });
});
