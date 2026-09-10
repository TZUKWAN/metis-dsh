import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  FundingTemplateObservationDocumentSchema,
  FundingTemplatePackageSchema,
  type FundingTemplateAnalysisRequest,
  type FundingTemplatePackage,
} from '../../engine/runtime/FundingTemplateContract.js';
import {
  analyzeFundingTemplate,
  decodeFundingTemplatePackage,
  diffFundingTemplatePackages,
  serializeFundingTemplatePackage,
  verifyFundingTemplatePackage,
} from '../../engine/personalization/FundingTemplateAnalyzer.js';

function digest(label: string): string {
  return createHash('sha256').update(label, 'utf8').digest('hex');
}

function fixture(): FundingTemplateAnalysisRequest {
  return {
    templateId: 'user:funding-template-001',
    templateVersion: 1,
    createdAt: 1_900_000_000_000,
    document: {
      contractVersion: 1,
      documentId: 'upload-observation-001',
      sourceFormat: 'pdf',
      sourceDigest: digest('funding-source-v1'),
      extractedAt: 1_899_999_999_000,
      extractor: { name: 'main-process-safe-extractor', version: '1.2.0' },
      pageCount: 2,
      pages: [
        { pageNumber: 1, widthPt: 595, heightPt: 842, observedMarginsPt: { top: 72, right: 72, bottom: 72, left: 72 } },
        { pageNumber: 2, widthPt: 595, heightPt: 842, observedMarginsPt: { top: 72, right: 72, bottom: 72, left: 72 } },
      ],
      styles: [
        {
          styleId: 'title-style', fontFamily: 'Source Han Serif SC', fontSizePt: 18,
          fontWeight: 'bold', italic: false, alignment: 'center', lineSpacingPt: 26,
          paragraphBeforePt: 0, paragraphAfterPt: 18,
        },
        {
          styleId: 'heading-style', fontFamily: 'Source Han Serif SC', fontSizePt: 14,
          fontWeight: 'bold', italic: false, alignment: 'left', lineSpacingPt: 22,
          paragraphBeforePt: 12, paragraphAfterPt: 6,
        },
        {
          styleId: 'body-style', fontFamily: 'Source Han Serif SC', fontSizePt: 10.5,
          fontWeight: 'normal', italic: false, alignment: 'justify', lineSpacingPt: 18,
          paragraphBeforePt: 0, paragraphAfterPt: 6,
        },
        {
          styleId: 'table-style', fontFamily: 'Source Han Sans SC', fontSizePt: 10,
          fontWeight: 'normal', italic: false, alignment: 'center', lineSpacingPt: 16,
          paragraphBeforePt: 0, paragraphAfterPt: 0,
        },
      ],
      blocks: [
        {
          kind: 'paragraph', blockId: 'p-title', pageNumber: 1, ordinal: 0,
          bounds: { x: 72, y: 48, width: 451, height: 30 },
          text: '国家社会科学基金项目申请书', contentRole: 'template_label', styleId: 'title-style',
        },
        {
          kind: 'paragraph', blockId: 'p-project-name', pageNumber: 1, ordinal: 1,
          bounds: { x: 72, y: 100, width: 180, height: 20 },
          text: '项目名称', contentRole: 'template_label', styleId: 'body-style',
        },
        {
          kind: 'paragraph', blockId: 'p-section-1', pageNumber: 1, ordinal: 2,
          bounds: { x: 72, y: 150, width: 451, height: 24 },
          text: '一、课题论证', contentRole: 'template_label', styleId: 'heading-style',
        },
        {
          kind: 'paragraph', blockId: 'p-instruction-1', pageNumber: 1, ordinal: 3,
          bounds: { x: 72, y: 180, width: 451, height: 20 },
          text: '必填，本栏限5000字。', contentRole: 'instruction', styleId: 'body-style',
        },
        {
          kind: 'table', blockId: 'table-schedule', pageNumber: 1, ordinal: 4,
          bounds: { x: 72, y: 250, width: 450, height: 100 }, rowCount: 2, columnCount: 2,
          cells: [
            {
              rowIndex: 0, columnIndex: 0, rowSpan: 1, columnSpan: 1,
              text: '年度', contentRole: 'template_label', styleId: 'table-style',
              bounds: { x: 72, y: 250, width: 225, height: 50 },
            },
            {
              rowIndex: 0, columnIndex: 1, rowSpan: 1, columnSpan: 1,
              text: '研究任务', contentRole: 'template_label', styleId: 'table-style',
              bounds: { x: 297, y: 250, width: 225, height: 50 },
            },
            {
              rowIndex: 1, columnIndex: 0, rowSpan: 1, columnSpan: 1,
              text: '2026', contentRole: 'user_content', styleId: 'table-style',
              bounds: { x: 72, y: 300, width: 225, height: 50 },
            },
            {
              rowIndex: 1, columnIndex: 1, rowSpan: 1, columnSpan: 1,
              text: '申请人尚未公开的研究安排', contentRole: 'user_content', styleId: 'table-style',
              bounds: { x: 297, y: 300, width: 225, height: 50 },
            },
          ],
        },
        {
          kind: 'paragraph', blockId: 'p-section-2', pageNumber: 2, ordinal: 5,
          bounds: { x: 72, y: 72, width: 451, height: 24 },
          text: '二、研究基础', contentRole: 'template_label', styleId: 'heading-style',
        },
        {
          kind: 'paragraph', blockId: 'p-instruction-2', pageNumber: 2, ordinal: 6,
          bounds: { x: 72, y: 105, width: 451, height: 20 },
          text: '本部分不超过3000字。', contentRole: 'instruction', styleId: 'body-style',
        },
        {
          kind: 'paragraph', blockId: 'p-expected', pageNumber: 2, ordinal: 7,
          bounds: { x: 72, y: 145, width: 180, height: 20 },
          text: '预期成果', contentRole: 'template_label', styleId: 'body-style',
        },
        {
          kind: 'paragraph', blockId: 'p-sensitive', pageNumber: 2, ordinal: 8,
          bounds: { x: 72, y: 180, width: 451, height: 40 },
          text: '申请人张三，手机号13800138000，邮箱zhangsan@example.com',
          contentRole: 'user_content', styleId: 'body-style',
        },
      ],
    },
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function expectSuccess(request: FundingTemplateAnalysisRequest = fixture()) {
  const result = analyzeFundingTemplate(request);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`Expected analysis success: ${result.code}`);
  return result.template;
}

describe('FundingTemplateAnalyzer strict observation boundary', () => {
  it('rejects a missing declared page', () => {
    const request = fixture();
    request.document.pages.pop();
    const result = analyzeFundingTemplate(request);
    expect(result).toMatchObject({ ok: false, code: 'invalid_input' });
  });

  it('rejects pages supplied out of order', () => {
    const request = fixture();
    request.document.pages.reverse();
    expect(analyzeFundingTemplate(request)).toMatchObject({ ok: false, code: 'invalid_input' });
  });

  it('rejects a block outside its observed page bounds', () => {
    const request = fixture();
    request.document.blocks[0]!.bounds.x = 594;
    expect(analyzeFundingTemplate(request)).toMatchObject({ ok: false, code: 'invalid_input' });
  });

  it('rejects a cell outside its table even when it remains on the page', () => {
    const request = fixture();
    const table = request.document.blocks.find((block) => block.kind === 'table');
    if (!table || table.kind !== 'table') throw new Error('Fixture table missing');
    table.cells[0]!.bounds = { x: 10, y: 250, width: 20, height: 20 };
    expect(analyzeFundingTemplate(request)).toMatchObject({ ok: false, code: 'invalid_input' });
  });

  it('rejects a paragraph that claims an unobserved style', () => {
    const request = fixture();
    const paragraph = request.document.blocks.find((block) => block.kind === 'paragraph');
    if (!paragraph || paragraph.kind !== 'paragraph') throw new Error('Fixture paragraph missing');
    paragraph.styleId = 'fabricated-style';
    expect(analyzeFundingTemplate(request)).toMatchObject({ ok: false, code: 'invalid_input' });
  });

  it('rejects duplicate style identifiers before analysis', () => {
    const request = fixture();
    request.document.styles.push(clone(request.document.styles[0]!));
    expect(FundingTemplateObservationDocumentSchema.safeParse(request.document).success).toBe(false);
  });

  it('rejects blocks with non-monotonic extraction order', () => {
    const request = fixture();
    request.document.blocks[2]!.ordinal = 0;
    expect(analyzeFundingTemplate(request)).toMatchObject({ ok: false, code: 'invalid_input' });
  });

  it('rejects template metadata that predates the extraction event', () => {
    const request = fixture();
    request.createdAt = request.document.extractedAt - 1;
    expect(analyzeFundingTemplate(request)).toMatchObject({ ok: false, code: 'invalid_input' });
  });
});

describe('FundingTemplateAnalyzer evidence-bound package', () => {
  it('creates a versioned, user-upload-authoritative package without claiming official freshness', () => {
    const template = expectSuccess();
    expect(template).toMatchObject({
      format: 'metis-funding-template-package',
      schemaVersion: 1,
      templateId: 'user:funding-template-001',
      templateVersion: 1,
      source: {
        authority: 'user_upload',
        officialCurrency: 'not_asserted',
      },
      privacy: { rawTextStored: false, sourceTextRetention: 'none' },
    });
    expect(template.source.fundingFamily).toMatchObject({
      state: 'observed', value: 'national_social_science_fund',
    });
    expect(verifyFundingTemplatePackage(template)).toMatchObject({ ok: true, code: 'valid' });
  });

  it('recognizes a Ministry-style upload only as an evidence-bound family hint', () => {
    const request = fixture();
    const title = request.document.blocks[0];
    if (!title || title.kind !== 'paragraph') throw new Error('Fixture title missing');
    title.text = '教育部人文社会科学研究项目申请评审书';
    const template = expectSuccess(request);
    expect(template.source.fundingFamily).toMatchObject({
      state: 'observed', value: 'ministry_humanities_social_sciences',
    });
    expect(template.source.officialCurrency).toBe('not_asserted');
  });

  it('extracts heading hierarchy, fixed fields, instructions, length limits, and table structure', () => {
    const template = expectSuccess();
    expect(template.sections.map((section) => section.normalizedTitle)).toEqual([
      '国家社会科学基金项目申请书', '课题论证', '研究基础',
    ]);
    expect(template.contentSlots.some((slot) => slot.normalizedLabel === '项目名称')).toBe(true);
    expect(template.contentSlots.some((slot) => slot.normalizedLabel === '国家社会科学基金项目申请书')).toBe(false);
    expect(template.fieldMappings.some((mapping) => mapping.canonicalField === 'project_name')).toBe(true);
    expect(template.instructions.some((instruction) => instruction.maxLength?.value === 5000)).toBe(true);
    expect(template.contentSlots.some((slot) => slot.maxLength?.value === 3000)).toBe(true);
    expect(template.tables[0]).toMatchObject({ rowCount: 2, columnCount: 2 });
    expect(template.tables[0]?.headers.map((header) => header.normalizedLabel)).toEqual(['年度', '研究任务']);
  });

  it('records typography and margins only with real evidence locators', () => {
    const template = expectSuccess();
    const heading = template.typography.find((rule) => rule.scope === 'section_heading');
    const table = template.typography.find((rule) => rule.scope === 'table');
    expect(heading?.fontSizePt).toMatchObject({ state: 'uncertain', value: 14 });
    expect(heading?.fontSizePt.evidence.every((item) => item.blockKind === 'paragraph')).toBe(true);
    expect(table?.fontFamily.evidence.every((item) => item.blockKind === 'table_cell')).toBe(true);
    expect(template.layout.marginsPt).toMatchObject({
      state: 'observed', value: { top: 72, right: 72, bottom: 72, left: 72 },
    });
  });

  it('uses explicit not_observed assertions rather than inventing absent typography or margins', () => {
    const request = fixture();
    request.document.pages.forEach((page) => { page.observedMarginsPt = null; });
    request.document.styles = [];
    for (const block of request.document.blocks) {
      if (block.kind === 'paragraph') block.styleId = null;
      else block.cells.forEach((cell) => { cell.styleId = null; });
    }
    const template = expectSuccess(request);
    expect(template.layout.marginsPt).toEqual({ state: 'not_observed', value: null, confidence: 0, evidence: [] });
    expect(template.typography.every((rule) => rule.fontFamily.state === 'not_observed')).toBe(true);
    expect(template.quality.status).toBe('needs_review');
    expect(template.quality.issues).toContain('typography_not_observed');
    expect(template.quality.issues).toContain('margins_not_observed');
  });

  it('does not store sensitive or user-authored source content', () => {
    const template = expectSuccess();
    const serialized = serializeFundingTemplatePackage(template);
    expect(serialized).not.toContain('张三');
    expect(serialized).not.toContain('13800138000');
    expect(serialized).not.toContain('zhangsan@example.com');
    expect(serialized).not.toContain('申请人尚未公开的研究安排');
    expect(template.privacy.sensitiveBlocksExcluded).toBeGreaterThan(0);
  });

  it('fails closed when there is too little template evidence', () => {
    const request = fixture();
    request.document.styles = [];
    request.document.pageCount = 1;
    request.document.pages = [request.document.pages[0]!];
    request.document.blocks = [{
      kind: 'paragraph', blockId: 'unknown-only', pageNumber: 1, ordinal: 0,
      bounds: { x: 72, y: 72, width: 300, height: 20 },
      text: '一段无法确认用途的普通文字', contentRole: 'unknown', styleId: null,
    }];
    expect(analyzeFundingTemplate(request)).toMatchObject({
      ok: false, code: 'insufficient_template_evidence',
    });
  });

  it('rejects duplicate normalized section labels', () => {
    const request = fixture();
    const label = request.document.blocks.find((block) => block.blockId === 'p-expected');
    if (!label || label.kind !== 'paragraph') throw new Error('Fixture label missing');
    label.text = '三、研究基础';
    label.styleId = 'heading-style';
    expect(analyzeFundingTemplate(request)).toMatchObject({ ok: false, code: 'duplicate_section' });
  });

  it('rejects duplicate table columns instead of silently overwriting a slot', () => {
    const request = fixture();
    const table = request.document.blocks.find((block) => block.kind === 'table');
    if (!table || table.kind !== 'table') throw new Error('Fixture table missing');
    table.cells[1]!.text = table.cells[0]!.text;
    expect(analyzeFundingTemplate(request)).toMatchObject({ ok: false, code: 'duplicate_field' });
  });
});

describe('FundingTemplateAnalyzer digest, persistence, and reanalysis', () => {
  it('is canonical and deterministic for the same observation request', () => {
    const first = expectSuccess();
    const second = expectSuccess(clone(fixture()));
    expect(second.canonicalDigest).toBe(first.canonicalDigest);
    expect(serializeFundingTemplatePackage(second)).toBe(serializeFundingTemplatePackage(first));
  });

  it('round-trips a package through the strict persistence decoder', () => {
    const template = expectSuccess();
    const decoded = decodeFundingTemplatePackage(serializeFundingTemplatePackage(template));
    expect(decoded).toMatchObject({ ok: true, code: 'valid' });
    expect(decoded.template?.canonicalDigest).toBe(template.canonicalDigest);
  });

  it('detects package digest tampering even when the structural schema still parses', () => {
    const template = clone(expectSuccess());
    template.sections[0]!.normalizedTitle = '篡改后的栏目';
    expect(FundingTemplatePackageSchema.safeParse(template).success).toBe(true);
    expect(verifyFundingTemplatePackage(template)).toMatchObject({ ok: false, code: 'digest_mismatch' });
  });

  it('rejects extra fields at the observation and package boundaries', () => {
    const request = fixture() as FundingTemplateAnalysisRequest & { unexpected?: boolean };
    request.unexpected = true;
    expect(analyzeFundingTemplate(request)).toMatchObject({ ok: false, code: 'invalid_input' });
    const template = expectSuccess() as FundingTemplatePackage & { unexpected?: boolean };
    template.unexpected = true;
    expect(verifyFundingTemplatePackage(template)).toMatchObject({ ok: false, code: 'invalid_package' });
  });

  it('produces an integrity-bound reanalysis diff and marks structural removal as breaking', () => {
    const first = expectSuccess();
    const secondRequest = fixture();
    secondRequest.templateVersion = 2;
    const removed = secondRequest.document.blocks.findIndex((block) => block.blockId === 'p-expected');
    secondRequest.document.blocks.splice(removed, 1);
    for (let index = removed; index < secondRequest.document.blocks.length; index += 1) {
      secondRequest.document.blocks[index]!.ordinal -= 1;
    }
    const second = expectSuccess(secondRequest);
    const diff = diffFundingTemplatePackages(first, second);
    expect(diff).toMatchObject({ fromVersion: 1, toVersion: 2, breaking: true });
    expect(diff.changes.some((change) => change.kind === 'removed' && change.entity === 'content_slot')).toBe(true);
    expect(diff.diffDigest).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('refuses diffing a tampered package or a non-advancing version', () => {
    const first = expectSuccess();
    const tampered = clone(first);
    tampered.layout.pageSizePt.confidence = 0.1;
    expect(() => diffFundingTemplatePackages(first, tampered)).toThrow(/Next package is invalid/u);
    expect(() => diffFundingTemplatePackages(first, first)).toThrow(/advance the template version/u);
  });
});
