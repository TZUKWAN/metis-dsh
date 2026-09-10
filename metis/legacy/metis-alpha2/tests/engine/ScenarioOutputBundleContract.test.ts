import { describe, expect, it } from 'vitest';
import {
  SCENARIO_OUTPUT_BUNDLE_LIMITS,
  bundleFromSectionedReport,
  decodeScenarioFinalOutput,
  decodeScenarioOutputBundle,
  decodeSectionedOutputBundle,
  mergeSectionedParseReports,
  parseScenarioSectionedOutput,
  type ScenarioOutputBundle,
} from '../../engine/runtime/ScenarioOutputBundleContract.js';

const outputPlan = {
  primaryDeliverable: 'Complete article',
  supportingArtifacts: ['Evidence table', 'Source ledger'],
  qualityCriteria: ['Every claim is traceable', 'Methods are reproducible'],
};

function validBundle(): ScenarioOutputBundle {
  return {
    primary: {
      name: 'Complete article',
      content: '# Complete article\n\nEvidence-grounded manuscript.',
    },
    supporting: [
      { name: 'Evidence table', content: '| Claim | Evidence |\n| --- | --- |' },
      { name: 'Source ledger', content: '1. Source A, locator 12.' },
    ],
    quality: [
      { criterion: 'Every claim is traceable', status: 'met', evidence: 'All pivotal claims map to the evidence table.' },
      { criterion: 'Methods are reproducible', status: 'partially_met', evidence: 'Code and parameters are present; environment lockfile is pending.' },
    ],
  };
}

function decode(value: unknown, plan: unknown = outputPlan) {
  return decodeScenarioOutputBundle(
    typeof value === 'string' ? value : JSON.stringify(value),
    plan,
  );
}

describe('ScenarioOutputBundleContract', () => {
  it('decodes a strict raw JSON bundle', () => {
    expect(decode(validBundle())).toEqual({ ok: true, bundle: validBundle() });
  });

  it('decodes exactly one lowercase json fenced block with surrounding whitespace and CRLF', () => {
    const fenced = ` \r\n\`\`\`json\r\n${JSON.stringify(validBundle(), null, 2)}\r\n\`\`\`\r\n `;
    expect(decodeScenarioOutputBundle(fenced, outputPlan)).toEqual({ ok: true, bundle: validBundle() });
  });

  it.each([
    ['prose before raw JSON', `Here is the result:\n${JSON.stringify(validBundle())}`],
    ['prose after raw JSON', `${JSON.stringify(validBundle())}\nDone.`],
    ['untyped fence', `\`\`\`\n${JSON.stringify(validBundle())}\n\`\`\``],
    ['uppercase fence', `\`\`\`JSON\n${JSON.stringify(validBundle())}\n\`\`\``],
    ['two fenced blocks', `\`\`\`json\n${JSON.stringify(validBundle())}\n\`\`\`\n\`\`\`json\n{}\n\`\`\``],
    ['trailing fenced prose', `\`\`\`json\n${JSON.stringify(validBundle())}\n\`\`\`\nDone.`],
  ])('rejects %s', (_label, text) => {
    expect(decodeScenarioOutputBundle(text, outputPlan)).toMatchObject({ ok: false, code: 'invalid_json' });
  });

  it.each([
    '',
    '{',
    'null',
    '[]',
    '"string"',
  ])('returns a decode failure instead of throwing for malformed or non-object JSON: %j', (text) => {
    expect(() => decodeScenarioOutputBundle(text, outputPlan)).not.toThrow();
    expect(decodeScenarioOutputBundle(text, outputPlan).ok).toBe(false);
  });

  it.each([
    ['root', { ...validBundle(), unexpected: true }],
    ['primary', { ...validBundle(), primary: { ...validBundle().primary, unexpected: true } }],
    ['supporting item', { ...validBundle(), supporting: [{ ...validBundle().supporting[0]!, unexpected: true }, validBundle().supporting[1]!] }],
    ['quality item', { ...validBundle(), quality: [{ ...validBundle().quality[0]!, unexpected: true }, validBundle().quality[1]!] }],
  ])('rejects extra keys at %s', (_label, bundle) => {
    expect(decode(bundle)).toMatchObject({ ok: false, code: 'invalid_shape' });
  });

  it.each([
    ['primary', { supporting: validBundle().supporting, quality: validBundle().quality }],
    ['supporting', { primary: validBundle().primary, quality: validBundle().quality }],
    ['quality', { primary: validBundle().primary, supporting: validBundle().supporting }],
    ['primary content', { ...validBundle(), primary: { name: validBundle().primary.name } }],
    ['supporting content', { ...validBundle(), supporting: [{ name: 'Evidence table' }, validBundle().supporting[1]!] }],
    ['quality evidence', { ...validBundle(), quality: [{ criterion: 'Every claim is traceable', status: 'met' }, validBundle().quality[1]!] }],
  ])('rejects missing %s', (_label, bundle) => {
    expect(decode(bundle)).toMatchObject({ ok: false, code: 'invalid_shape' });
  });

  it('rejects duplicate JSON object keys before JSON.parse can overwrite them', () => {
    const primary = JSON.stringify(validBundle().primary);
    const text = `{"primary":${primary},"primary":${primary},"supporting":${JSON.stringify(validBundle().supporting)},"quality":${JSON.stringify(validBundle().quality)}}`;
    expect(decodeScenarioOutputBundle(text, outputPlan)).toEqual({ ok: false, code: 'invalid_json' });
  });

  it('rejects duplicate nested JSON object keys', () => {
    const text = `{"primary":{"name":"Complete article","content":"one","content":"two"},"supporting":${JSON.stringify(validBundle().supporting)},"quality":${JSON.stringify(validBundle().quality)}}`;
    expect(decodeScenarioOutputBundle(text, outputPlan)).toEqual({ ok: false, code: 'invalid_json' });
  });

  it('requires primary.name to equal primaryDeliverable exactly', () => {
    expect(decode({ ...validBundle(), primary: { ...validBundle().primary, name: ' complete article' } }))
      .toMatchObject({ ok: false, code: 'plan_mismatch' });
  });

  it.each([
    ['missing supporting item', validBundle().supporting.slice(0, 1)],
    ['extra supporting item', [...validBundle().supporting, { name: 'Appendix', content: 'x' }]],
    ['reordered supporting items', [...validBundle().supporting].reverse()],
    ['renamed supporting item', [{ name: 'Evidence matrix', content: 'x' }, validBundle().supporting[1]!]],
    ['duplicate supporting name', [validBundle().supporting[0]!, { ...validBundle().supporting[1]!, name: 'Evidence table' }]],
  ])('rejects %s', (_label, supporting) => {
    expect(decode({ ...validBundle(), supporting })).toMatchObject({ ok: false });
  });

  it.each([
    ['missing quality item', validBundle().quality.slice(0, 1)],
    ['extra quality item', [...validBundle().quality, { criterion: 'No fabricated claims', status: 'met', evidence: 'Audited.' }]],
    ['reordered quality items', [...validBundle().quality].reverse()],
    ['renamed quality criterion', [{ ...validBundle().quality[0]!, criterion: 'Claims have sources' }, validBundle().quality[1]!]],
    ['duplicate quality criterion', [validBundle().quality[0]!, { ...validBundle().quality[1]!, criterion: 'Every claim is traceable' }]],
  ])('rejects %s', (_label, quality) => {
    expect(decode({ ...validBundle(), quality })).toMatchObject({ ok: false });
  });

  it.each([
    ['unknown quality status', { ...validBundle(), quality: [{ ...validBundle().quality[0]!, status: 'passed' }, validBundle().quality[1]!] }],
    ['empty primary content', { ...validBundle(), primary: { ...validBundle().primary, content: ' \n\t ' } }],
    ['empty supporting content', { ...validBundle(), supporting: [{ ...validBundle().supporting[0]!, content: '' }, validBundle().supporting[1]!] }],
    ['empty quality evidence', { ...validBundle(), quality: [{ ...validBundle().quality[0]!, evidence: '\n' }, validBundle().quality[1]!] }],
  ])('rejects %s', (_label, bundle) => {
    expect(decode(bundle)).toMatchObject({ ok: false, code: 'invalid_shape' });
  });

  it.each([
    ['primary template placeholder', {
      ...validBundle(),
      primary: { ...validBundle().primary, content: '<complete primary deliverable>' },
    }],
    ['supporting template placeholder', {
      ...validBundle(),
      supporting: [
        { ...validBundle().supporting[0]!, content: '<complete supporting artifact>' },
        validBundle().supporting[1]!,
      ],
    }],
    ['quality template placeholder', {
      ...validBundle(),
      quality: [
        { ...validBundle().quality[0]!, evidence: '<specific evidence from the generated deliverables>' },
        validBundle().quality[1]!,
      ],
    }],
  ])('rejects %s instead of persisting the prompt template', (_label, bundle) => {
    expect(decode(bundle)).toEqual({ ok: false, code: 'invalid_shape' });
  });

  it.each([
    ['primary name', { ...validBundle(), primary: { ...validBundle().primary, name: 'Complete\u0000 article' } }],
    ['primary content', { ...validBundle(), primary: { ...validBundle().primary, content: 'Unsafe\u0000content' } }],
    ['supporting name', { ...validBundle(), supporting: [{ ...validBundle().supporting[0]!, name: 'Evidence\u0085table' }, validBundle().supporting[1]!] }],
    ['supporting content', { ...validBundle(), supporting: [{ ...validBundle().supporting[0]!, content: 'Unsafe\u001fcontent' }, validBundle().supporting[1]!] }],
    ['quality criterion', { ...validBundle(), quality: [{ ...validBundle().quality[0]!, criterion: 'Every\u007fclaim is traceable' }, validBundle().quality[1]!] }],
    ['quality evidence', { ...validBundle(), quality: [{ ...validBundle().quality[0]!, evidence: 'Unsafe\u009fevidence' }, validBundle().quality[1]!] }],
  ])('rejects control characters in %s', (_label, bundle) => {
    expect(decode(bundle)).toMatchObject({ ok: false, code: 'invalid_shape' });
  });

  it('rejects an invalid OutputPlan before comparing bundle names', () => {
    expect(decode(validBundle(), { ...outputPlan, supportingArtifacts: ['Evidence table', 'Evidence table'] }))
      .toEqual({ ok: false, code: 'invalid_shape' });
    expect(decode(validBundle(), { ...outputPlan, extra: true }))
      .toEqual({ ok: false, code: 'invalid_shape' });
  });

  it('rejects raw agent text beyond the raw input limit', () => {
    const text = ' '.repeat(SCENARIO_OUTPUT_BUNDLE_LIMITS.rawTextChars + 1);
    expect(decodeScenarioOutputBundle(text, outputPlan)).toEqual({ ok: false, code: 'invalid_shape' });
  });

  it.each([
    ['primary content', { ...validBundle(), primary: { ...validBundle().primary, content: 'x'.repeat(SCENARIO_OUTPUT_BUNDLE_LIMITS.itemContentChars + 1) } }],
    ['supporting content', { ...validBundle(), supporting: [{ ...validBundle().supporting[0]!, content: 'x'.repeat(SCENARIO_OUTPUT_BUNDLE_LIMITS.itemContentChars + 1) }, validBundle().supporting[1]!] }],
    ['quality evidence', { ...validBundle(), quality: [{ ...validBundle().quality[0]!, evidence: 'x'.repeat(SCENARIO_OUTPUT_BUNDLE_LIMITS.evidenceChars + 1) }, validBundle().quality[1]!] }],
  ])('rejects oversized %s', (_label, bundle) => {
    expect(decode(bundle)).toMatchObject({ ok: false, code: 'invalid_shape' });
  });

  it('rejects a bundle whose aggregate body exceeds the total body limit while every item is within its own limit', () => {
    const plan = {
      primaryDeliverable: 'Primary',
      supportingArtifacts: ['Support A', 'Support B'],
      qualityCriteria: [],
    };
    const bundle = {
      primary: { name: 'Primary', content: 'p'.repeat(SCENARIO_OUTPUT_BUNDLE_LIMITS.itemContentChars) },
      supporting: [
        { name: 'Support A', content: 'a'.repeat(300_000) },
        { name: 'Support B', content: 'b'.repeat(300_000) },
      ],
      quality: [],
    };
    expect(decode(bundle, plan)).toEqual({ ok: false, code: 'invalid_shape' });
  });

  it('never throws for non-string input or hostile OutputPlan accessors', () => {
    expect(() => decodeScenarioOutputBundle({} as unknown as string, outputPlan)).not.toThrow();
    expect(decodeScenarioOutputBundle({} as unknown as string, outputPlan))
      .toEqual({ ok: false, code: 'invalid_json' });
    const hostile = Object.defineProperty({}, 'primaryDeliverable', {
      enumerable: true,
      get: () => { throw new Error('getter must not escape'); },
    });
    expect(() => decodeScenarioOutputBundle(JSON.stringify(validBundle()), hostile)).not.toThrow();
    expect(decodeScenarioOutputBundle(JSON.stringify(validBundle()), hostile))
      .toEqual({ ok: false, code: 'invalid_shape' });
  });
});

describe('decodeSectionedOutputBundle (sectioned wire format, 2026-08-30)', () => {
  function sectionedDocument(overrides?: {
    primaryName?: string;
    supportingLabels?: [string, string][];
    qualityLabels?: [string, string, string][];
  }): string {
    const supporting = overrides?.supportingLabels ?? [
      ['Evidence table', '| Claim | Evidence |\n| --- | --- |'],
      ['Source ledger', '1. Source A, locator 12.'],
    ];
    const quality = overrides?.qualityLabels ?? [
      ['Every claim is traceable', 'met', 'All pivotal claims map to the evidence table.'],
      ['Methods are reproducible', 'partially_met', 'Code and parameters are present.'],
    ];
    return [
      '===METIS-PRIMARY===',
      '# Complete article',
      '',
      'Evidence-grounded manuscript with ```json {"raw": true}``` fences inside.',
      ...supporting.flatMap(([name, content]) => [
        '',
        '===METIS-SUPPORTING===',
        `name: ${name}`,
        content,
      ]),
      ...quality.flatMap(([criterion, status, evidence]) => [
        '',
        '===METIS-QUALITY===',
        `criterion: ${criterion}`,
        `status: ${status}`,
        evidence,
      ]),
      '',
    ].join('\n');
  }

  it('decodes a full sectioned document, preserving raw content verbatim', () => {
    const result = decodeSectionedOutputBundle(sectionedDocument(), outputPlan);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bundle.primary.name).toBe('Complete article');
    expect(result.bundle.primary.content).toContain('```json {"raw": true}```');
    expect(result.bundle.supporting.map((item) => item.name)).toEqual(['Evidence table', 'Source ledger']);
    expect(result.bundle.quality.map((item) => item.status)).toEqual(['met', 'partially_met']);
  });

  it('assembles out-of-order sections in plan order', () => {
    const text = sectionedDocument({
      supportingLabels: [
        ['Source ledger', 'ledger first'],
        ['Evidence table', 'table second'],
      ],
      qualityLabels: [
        ['Methods are reproducible', 'unmet', 'no lockfile'],
        ['Every claim is traceable', 'met', 'traceable'],
      ],
    });
    const result = decodeSectionedOutputBundle(text, outputPlan);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bundle.supporting.map((item) => item.content)).toEqual(['table second', 'ledger first']);
    expect(result.bundle.quality.map((item) => item.criterion)).toEqual(outputPlan.qualityCriteria);
  });

  it('resolves paraphrased Chinese labels to canonical plan names', () => {
    const chinesePlan = {
      primaryDeliverable: '劳动社会学主题文献综述论文（含可复核检索与理论—经验综合）',
      supportingArtifacts: [
        '检索与筛选记录表（数据库、检索式、时间范围、纳入/排除理由）',
        '文献编码矩阵（作者、年份、研究问题、理论框架、方法、样本、核心发现与局限）',
      ],
      qualityCriteria: ['引用与参考文献逐条对应，书目信息完整统一，关键论断有可靠来源支撑，避免不可核验或重复引用。'],
    };
    const text = [
      '===METIS-PRIMARY===',
      '定稿正文。',
      '',
      '===METIS-SUPPORTING===',
      // 模型改写：半角括号 + 去掉顿号差异
      'name: 检索与筛选记录表(数据库、检索式、时间范围、纳入/排除理由)',
      '检索记录内容。',
      '',
      '===METIS-SUPPORTING===',
      // 模型改写：全角空格与换行差异
      'name: 文献编码矩阵 （作者、年份、研究问题、理论框架、方法、样本、核心发现与局限）',
      '编码矩阵内容。',
      '',
      '===METIS-QUALITY===',
      'criterion: 引用与参考文献逐条对应，书目信息完整统一，关键论断有可靠来源支撑，避免不可核验或重复引用。',
      'status: 部分满足',
      '抽查 20 条引用均可追溯。',
    ].join('\n');
    const result = decodeSectionedOutputBundle(text, chinesePlan);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bundle.primary.name).toBe(chinesePlan.primaryDeliverable);
    expect(result.bundle.supporting[0]?.name).toBe(chinesePlan.supportingArtifacts[0]);
    expect(result.bundle.quality[0]?.status).toBe('partially_met');
  });

  it('reports missing entries and unmatched labels in detail for correction retries', () => {
    const text = sectionedDocument({
      supportingLabels: [['Evidence table', 'only one artifact']],
    });
    const result = decodeSectionedOutputBundle(text, outputPlan);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('plan_mismatch');
    expect(result.detail).toContain('Source ledger');
  });

  it('rejects an invalid quality status with actionable detail', () => {
    const text = sectionedDocument({
      qualityLabels: [
        ['Every claim is traceable', 'mostly fine', 'evidence'],
        ['Methods are reproducible', 'met', 'evidence'],
      ],
    });
    const result = decodeSectionedOutputBundle(text, outputPlan);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('plan_mismatch');
    expect(result.detail).toContain('mostly fine');
  });

  it('returns invalid_json when the text has no section markers', () => {
    expect(decodeSectionedOutputBundle('# Just prose', outputPlan)).toEqual({ ok: false, code: 'invalid_json' });
  });

  it('decodeScenarioFinalOutput prefers strict JSON and falls back to sections', () => {
    expect(decodeScenarioFinalOutput(JSON.stringify(validBundle()), outputPlan))
      .toEqual({ ok: true, bundle: validBundle() });
    const sectioned = decodeScenarioFinalOutput(sectionedDocument(), outputPlan);
    expect(sectioned.ok).toBe(true);
    // 两种格式都失败且没有分段标记时，保留严格解码的失败码。
    expect(decodeScenarioFinalOutput('plain prose', outputPlan)).toEqual({ ok: false, code: 'invalid_json' });
    // 有分段标记但缺条目时，返回带 detail 的 plan_mismatch（纠偏反馈可用）。
    const partial = decodeScenarioFinalOutput(
      sectionedDocument({ supportingLabels: [['Evidence table', 'only one']] }),
      outputPlan,
    );
    expect(partial.ok).toBe(false);
    if (!partial.ok) {
      expect(partial.code).toBe('plan_mismatch');
      expect(partial.detail).toContain('Source ledger');
    }
  });
});

describe('sectioned index labels and incremental repair (2026-08-31)', () => {
  const indexDoc = [
    '===METIS-PRIMARY===',
    '定稿正文。',
    '',
    '===METIS-SUPPORTING===',
    'name: S1',
    '证据表内容。',
    '',
    '===METIS-SUPPORTING===',
    'name: S2 Source ledger',
    '来源台账内容。',
    '',
    '===METIS-QUALITY===',
    'criterion: Q2',
    'status: 未满足',
    '缺少锁文件。',
    '',
    '===METIS-QUALITY===',
    'criterion: Q1',
    'status: met',
    '全部论断可追溯到证据表。',
  ].join('\n');

  it('resolves S<n>/Q<n> index labels with optional name suffixes', () => {
    const result = decodeSectionedOutputBundle(indexDoc, outputPlan);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bundle.supporting.map((item) => item.name)).toEqual(['Evidence table', 'Source ledger']);
    expect(result.bundle.supporting[1]?.content).toBe('来源台账内容。');
    expect(result.bundle.quality.map((item) => item.status)).toEqual(['met', 'unmet']);
  });

  it('merges partial reports across attempts so corrections only fill the gaps', () => {
    // 第一轮：supporting 齐全，quality 错用了步骤自身标准（生产失败形态）。
    const first = [
      '===METIS-PRIMARY===',
      '定稿正文。',
      '',
      '===METIS-SUPPORTING===',
      'name: S1',
      '证据表内容。',
      '',
      '===METIS-SUPPORTING===',
      'name: S2',
      '来源台账内容。',
      '',
      '===METIS-QUALITY===',
      'criterion: 每条审校意见均有对应的处理决定。',
      'status: met',
      '步骤级标准的证据。',
    ].join('\n');
    const firstReport = parseScenarioSectionedOutput(first, outputPlan);
    expect(firstReport).toBeDefined();
    expect(firstReport!.supporting.size).toBe(2);
    expect(firstReport!.quality.size).toBe(0);
    const firstAssembled = bundleFromSectionedReport(firstReport!, outputPlan);
    expect(firstAssembled.ok).toBe(false);
    if (!firstAssembled.ok) {
      expect(firstAssembled.detail).toContain('Every claim is traceable');
    }
    // 第二轮：只补 Q1/Q2 两段；已交付的 primary/supporting 由合并保留。
    const second = [
      '===METIS-QUALITY===',
      'criterion: Q1',
      'status: met',
      '全部论断可追溯到证据表。',
      '',
      '===METIS-QUALITY===',
      'criterion: Q2',
      'status: partially_met',
      '参数齐全，锁文件待补。',
    ].join('\n');
    const secondReport = parseScenarioSectionedOutput(second, outputPlan);
    const merged = mergeSectionedParseReports(firstReport!, secondReport!);
    const assembled = bundleFromSectionedReport(merged, outputPlan);
    expect(assembled.ok).toBe(true);
    if (!assembled.ok) return;
    expect(assembled.bundle.primary.content).toBe('定稿正文。');
    expect(assembled.bundle.supporting).toHaveLength(2);
    expect(assembled.bundle.quality.map((item) => item.criterion)).toEqual(outputPlan.qualityCriteria);
  });
});

describe('paged delivery with CONTINUED markers (2026-08-31 output-cap fix)', () => {
  it('appends PRIMARY-CONTINUED content across pages via merge', () => {
    const page1 = [
      '===METIS-PRIMARY===',
      '第一章。引言部分。',
      '',
      '===METIS-SUPPORTING===',
      'name: S1',
      '证据表内容。',
    ].join('\n');
    const page2 = [
      '===METIS-PRIMARY-CONTINUED===',
      '第二章。综述综合部分。',
      '',
      '===METIS-SUPPORTING===',
      'name: S2',
      '来源台账内容。',
      '',
      '===METIS-QUALITY===',
      'criterion: Q1',
      'status: met',
      '论断可溯源。',
      '',
      '===METIS-QUALITY===',
      'criterion: Q2',
      'status: met',
      '方法可复现。',
    ].join('\n');
    const report1 = parseScenarioSectionedOutput(page1, outputPlan)!;
    const report2 = parseScenarioSectionedOutput(page2, outputPlan)!;
    expect(report1.primary?.mode).toBe('replace');
    expect(report2.primary?.mode).toBe('append');
    const merged = mergeSectionedParseReports(report1, report2);
    const assembled = bundleFromSectionedReport(merged, outputPlan);
    expect(assembled.ok).toBe(true);
    if (!assembled.ok) return;
    expect(assembled.bundle.primary.content).toBe('第一章。引言部分。\n第二章。综述综合部分。');
    expect(assembled.bundle.supporting).toHaveLength(2);
    expect(assembled.bundle.quality).toHaveLength(2);
  });

  it('concatenates PRIMARY and PRIMARY-CONTINUED within a single response', () => {
    const text = [
      '===METIS-PRIMARY===',
      '上半。',
      '===METIS-PRIMARY-CONTINUED===',
      '下半。',
      '===METIS-SUPPORTING===',
      'name: S1',
      '证据表。',
      '===METIS-SUPPORTING===',
      'name: S2',
      '台账。',
      '===METIS-QUALITY===',
      'criterion: Q1',
      'status: met',
      '证据。',
      '===METIS-QUALITY===',
      'criterion: Q2',
      'status: met',
      '证据。',
    ].join('\n');
    const result = decodeSectionedOutputBundle(text, outputPlan);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bundle.primary.content).toBe('上半。\n下半。');
  });

  it('plain re-sent sections replace carried content while CONTINUED appends', () => {
    const page1 = ['===METIS-SUPPORTING===', 'name: S1', '旧内容。'].join('\n');
    const page2 = ['===METIS-SUPPORTING===', 'name: S1', '修正内容。'].join('\n');
    const page3 = ['===METIS-SUPPORTING-CONTINUED===', 'name: S1', '追加段落。'].join('\n');
    let report = parseScenarioSectionedOutput(page1, outputPlan)!;
    report = mergeSectionedParseReports(report, parseScenarioSectionedOutput(page2, outputPlan)!);
    expect(report.supporting.get('Evidence table')?.content).toBe('修正内容。');
    report = mergeSectionedParseReports(report, parseScenarioSectionedOutput(page3, outputPlan)!);
    expect(report.supporting.get('Evidence table')?.content).toBe('修正内容。\n追加段落。');
  });

  it('keeps the first status when a QUALITY-CONTINUED section omits it', () => {
    const page1 = ['===METIS-QUALITY===', 'criterion: Q1', 'status: partially_met', '证据一。'].join('\n');
    const page2 = ['===METIS-QUALITY-CONTINUED===', 'criterion: Q1', '补充证据。'].join('\n');
    let report = parseScenarioSectionedOutput(page1, outputPlan)!;
    report = mergeSectionedParseReports(report, parseScenarioSectionedOutput(page2, outputPlan)!);
    const entry = report.quality.get('Every claim is traceable');
    expect(entry?.status).toBe('partially_met');
    expect(entry?.evidence).toBe('证据一。\n补充证据。');
  });

  it('flags a quality entry that never received a status line', () => {
    const text = [
      '===METIS-PRIMARY===', '正文。',
      '===METIS-SUPPORTING===', 'name: S1', '证据表。',
      '===METIS-SUPPORTING===', 'name: S2', '台账。',
      '===METIS-QUALITY===', 'criterion: Q1', 'status: met', '证据。',
      '===METIS-QUALITY-CONTINUED===', 'criterion: Q2', '只有证据没有状态行。',
    ].join('\n');
    const result = decodeSectionedOutputBundle(text, outputPlan);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('plan_mismatch');
    expect(result.detail).toContain('missing a status line');
  });
});
