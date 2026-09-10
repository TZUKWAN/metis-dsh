import { describe, expect, it } from 'vitest';
import { FakeProvider } from '../../engine/providers/FakeProvider.js';
import {
  ResearchMethodSpecSchema,
  selectResearchMethod,
  selectResearchMethodWithProvider,
} from '../../engine/research/researchMethods.js';

describe('humanities and social-science research method selection', () => {
  it('selects a theoretical chain without falling back to an experiment workflow', () => {
    const spec = selectResearchMethod('比较哈贝马斯与福柯的权力概念，重构公共领域的理论解释');

    expect(spec.family).toBe('theoretical');
    expect(spec.phases.map((phase) => phase.action)).toEqual([
      'question_formulation',
      'literature_review',
      'conceptual_analysis',
      'argumentation',
      'synthesis',
      'quality_audit',
      'writing',
    ]);
    expect(spec.phases.some((phase) => String(phase.action) === 'experiment')).toBe(false);
  });

  it('selects a qualitative chain that includes research design, collection, coding and triangulation', () => {
    const spec = selectResearchMethod('通过半结构访谈和田野观察研究平台劳动者的职业认同');

    expect(spec.family).toBe('qualitative');
    expect(spec.phases.map((phase) => phase.action)).toEqual(expect.arrayContaining([
      'research_design',
      'data_collection',
      'coding',
      'triangulation',
      'quality_audit',
    ]));
  });

  it('selects a historical chain with source discovery and source criticism', () => {
    const spec = selectResearchMethod('利用地方档案、报刊与口述史研究民国时期城市救济制度的演变');

    expect(spec.family).toBe('historical');
    expect(spec.phases.map((phase) => phase.action)).toEqual(expect.arrayContaining([
      'source_discovery',
      'source_criticism',
      'triangulation',
    ]));
  });

  it('selects a quantitative chain with data preparation and statistics', () => {
    const spec = selectResearchMethod('使用问卷数据和多元回归检验教育程度对政治参与的影响');

    expect(spec.family).toBe('quantitative');
    expect(spec.phases.map((phase) => phase.action)).toEqual(expect.arrayContaining([
      'research_design',
      'data_collection',
      'data_preparation',
      'statistics',
      'quality_audit',
    ]));
  });

  it('builds a mixed-method chain when the goal explicitly combines qualitative and quantitative evidence', () => {
    const spec = selectResearchMethod('采用混合研究：访谈教师并分析全国问卷数据，综合解释政策执行差异');

    expect(spec.family).toBe('mixed');
    expect(spec.phases.map((phase) => phase.action)).toEqual(expect.arrayContaining([
      'coding',
      'statistics',
      'triangulation',
    ]));
  });

  it('uses a provider classification when valid and keeps the trusted built-in method chain', async () => {
    const provider = new FakeProvider({
      response: JSON.stringify({
        family: 'historical',
        confidence: 0.91,
        rationale: '研究问题关注制度的历时变化，并明确依赖档案材料。',
      }),
    });

    const spec = await selectResearchMethodWithProvider('研究某项制度的形成过程', provider);

    expect(spec.family).toBe('historical');
    expect(spec.confidence).toBeCloseTo(0.91);
    expect(spec.rationale).toContain('历时变化');
    expect(spec.phases.some((phase) => phase.action === 'source_criticism')).toBe(true);
  });

  it('returns a schema-valid general research chain for an ambiguous goal', () => {
    const spec = selectResearchMethod('研究数字平台与社会生活之间的关系');

    expect(spec.family).toBe('general');
    expect(spec.phases.some((phase) => String(phase.action) === 'experiment')).toBe(false);
    expect(ResearchMethodSpecSchema.safeParse(spec).success).toBe(true);
  });
});
