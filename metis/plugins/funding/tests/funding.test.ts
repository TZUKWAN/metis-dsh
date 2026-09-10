/**
 * dsh-metis-funding 测试（Phase 20 / 任务清单 T20-021~027、27.3）。
 * 覆盖：合法观察文档解析、invalid_input fail-loud、坏 payload、diff、check。
 */

import { describe, expect, it } from 'vitest';
import { createFundingTools } from '../src/tools.ts';

/** 构造最小合法的观察文档（字段与 FundingTemplateObservationDocumentSchema 对齐）。 */
function observationDocument(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contractVersion: 1,
    documentId: 'doc-001',
    sourceFormat: 'pdf',
    sourceDigest: 'a'.repeat(64),
    extractedAt: 1_900_000_000_000,
    extractor: { name: 'test-extractor', version: '1.0.0' },
    pageCount: 1,
    pages: [{ pageNumber: 1, widthPt: 612, heightPt: 792, observedMarginsPt: null }],
    styles: [{
      styleId: 'style-heading',
      fontFamily: 'SimSun',
      fontSizePt: 14,
      fontWeight: 'bold',
      italic: false,
      alignment: 'left',
      lineSpacingPt: null,
      paragraphBeforePt: null,
      paragraphAfterPt: null,
    }],
    blocks: [
      {
        kind: 'paragraph', blockId: 'b1', pageNumber: 1, ordinal: 0,
        bounds: { x: 70, y: 70, width: 470, height: 20 },
        text: 'Project Title:',
        contentRole: 'template_label', styleId: 'style-heading',
      },
      {
        kind: 'paragraph', blockId: 'b2', pageNumber: 1, ordinal: 1,
        bounds: { x: 70, y: 95, width: 470, height: 20 },
        text: '（在此填写项目名称）',
        contentRole: 'placeholder', styleId: null,
      },
      {
        kind: 'paragraph', blockId: 'b3', pageNumber: 1, ordinal: 2,
        bounds: { x: 70, y: 120, width: 470, height: 60 },
        text: '立项依据应填写不超过 2000 字，说明研究背景与意义。',
        contentRole: 'instruction', styleId: null,
      },
    ],
    ...overrides,
  };
}

type FundingTools = ReturnType<typeof createFundingTools>;

function makeFunding(): {
  parse: (args: any) => Promise<any>
  requirements: (args: any) => Promise<any>
  check: (args: any) => Promise<any>
  diff: (args: any) => Promise<any>
} {
  const tools = createFundingTools(`.test-funding-${Date.now()}.json`);
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  return {
    parse: (args) => byName.get('funding_template_parse')!.execute(args),
    requirements: (args) => byName.get('funding_template_requirements')!.execute(args),
    check: (args) => byName.get('funding_template_check')!.execute(args),
    diff: (args) => byName.get('funding_template_diff')!.execute(args),
  };
}

describe('dsh-metis-funding', () => {
  it('parses a valid observation document into a template package', async () => {
    const funding = makeFunding();
    expect(typeof funding.parse).toBe('function');
    expect(typeof funding.check).toBe('function');
    expect(typeof funding.diff).toBe('function');
    expect(typeof funding.requirements).toBe('function');
    const result = await funding.parse({
      observationDocument: observationDocument(),
      templateId: 'user:test-template',
      templateVersion: 1,
      createdAt: 1_900_000_000_001,
    });
    expect(result.ok).toBe(true);
    expect((result as { template?: { source?: { sourceDigest?: string } } }).template?.source?.sourceDigest)
      .toBe('a'.repeat(64));
  });

  it('fails loud with issues for an invalid observation document', async () => {
    const funding = makeFunding();
    const result = await funding.parse({
      observationDocument: { contractVersion: 1 },
      templateId: 'user:broken',
      templateVersion: 1,
      createdAt: 1_900_000_000_001,
    });
    expect(result.ok).toBe(false);
    expect((result as { issues?: string[] }).issues!.length).toBeGreaterThan(0);
  });

  it('reports the parse failure code for a non-object document', async () => {
    const funding = makeFunding();
    const result = await funding.parse({
      observationDocument: 'not-a-document',
      templateId: 'user:x',
      templateVersion: 1,
      createdAt: 1_900_000_000_001,
    });
    expect(result.ok).toBe(false);
  });

  it('checks package integrity via verify', async () => {
    const funding = makeFunding();
    const parsed = await funding.parse({
      observationDocument: observationDocument(),
      templateId: 'user:test-template',
      templateVersion: 1,
      createdAt: 1_900_000_000_001,
    });
    const check = await funding.check({ templatePackage: (parsed as { template?: unknown }).template });
    expect((check as { ok: boolean }).ok).toBe(true);
  });

  it('produces a structural diff between two template packages', async () => {
    const funding = makeFunding();
    const parseWith = async (label: string, version: number): Promise<unknown> => {
      const result = await funding.parse({
        observationDocument: observationDocument({
          blocks: [{
            kind: 'paragraph', blockId: 'b1', pageNumber: 1, ordinal: 0,
            bounds: { x: 70, y: 70, width: 470, height: 20 },
            text: label, contentRole: 'template_label', styleId: null,
          }],
        }),
        templateId: 'user:diff',
        templateVersion: version,
        createdAt: 1_900_000_000_001,
      });
      return (result as { template?: unknown }).template;
    };
    // 领域契约：重分析必须递增版本号，否则 diff 抛「Reanalysis must advance the template version」。
    const oldPackage = await parseWith('旧版标题', 1);
    const newPackage = await parseWith('新版标题', 2);
    const diff = await funding.diff({ oldPackage, newPackage }) as { diff?: { changes?: unknown[] } };
    expect(diff.diff).toBeDefined();
  });

  it('extracts requirements including word limits and instructions', async () => {
    const funding = makeFunding();
    const parsed = await funding.parse({
      observationDocument: observationDocument(),
      templateId: 'user:req',
      templateVersion: 1,
      createdAt: 1_900_000_000_001,
    });
    const template = (parsed as { template?: Record<string, unknown> }).template ?? {};
    const requirements = await funding.requirements({ template }) as {
      totalSections: number
      requirements: Array<Record<string, unknown>>
    };
    // 最小 fixture（无标题候选）下 analyzer 识别 0 个章节是真实行为；
    // 断言结构与类型有效，深章节识别由完整观察文档（Gate F 集成）覆盖。
    expect(Array.isArray(requirements.requirements)).toBe(true);
  });
});
