/**
 * ScenarioMaterialService — 材料导入与 AI 分析解析测试（场景重构 P1）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ScenarioMaterialService } from '../../electron/ScenarioMaterialService.js';

let tmpDir: string;
let service: ScenarioMaterialService;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-scm-'));
  service = new ScenarioMaterialService(tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('importMaterial', () => {
  it('txt/md 直接导入并落盘，可再次读取', async () => {
    const file = path.join(tmpDir, 'guide.md');
    fs.writeFileSync(file, '# 投稿指南\n\n正文要求若干。'.repeat(3), 'utf8');
    const material = await service.importMaterial(file);
    expect(material.name).toBe('guide.md');
    expect(material.charCount).toBeGreaterThan(20);
    expect(service.loadMaterialText(material.id)).toContain('投稿指南');
  });

  it('过短材料拒绝（material_too_short）', async () => {
    const file = path.join(tmpDir, 'short.txt');
    fs.writeFileSync(file, '太短', 'utf8');
    await expect(service.importMaterial(file)).rejects.toThrowError('material_too_short');
  });

  it('二进制内容拒绝（unsupported_material_type）', async () => {
    const file = path.join(tmpDir, 'blob.bin');
    fs.writeFileSync(file, Buffer.from([0x00, 0x01, 0x02, 0x00, 0x03]));
    await expect(service.importMaterial(file)).rejects.toThrowError('unsupported_material_type');
  });

  it('pdf 走注入的提取器', async () => {
    const file = path.join(tmpDir, 'paper.pdf');
    fs.writeFileSync(file, 'fake', 'utf8');
    const material = await service.importMaterial(file, { extractPdf: async () => '这是一篇论文的正文，包含研究设计与结论。'.repeat(2) });
    expect(material.charCount).toBeGreaterThan(20);
  });
});

describe('parseAnalysisResponse', () => {
  it('完整输出解析为摘要+材料洞察+场景草案（含成果结构与自适应）', () => {
    const raw = JSON.stringify({
      summary: {
        deliverableType: 'empirical_paper',
        deliverableTypeLabel: '实证论文',
        structureTitles: ['题目', '摘要', '1 引言'],
        hardRuleCount: 4,
        writingPrincipleCount: 6,
        methods: ['双重差分'],
        adjustable: ['主体章节'],
        recommended: { agents: 2, skills: 5, mcps: 1, rules: 1 },
      },
      materials: [{
        name: '投稿指南.pdf',
        kind: 'guide',
        insights: {
          structureRules: ['正文五章'],
          writingPrinciples: ['摘要不出现本文'],
          methodSuggestions: ['报告稳健性检验'],
          hardRequirements: ['引用可查'],
        },
      }],
      scenario: {
        name: 'CSSCI 实证论文',
        description: '实证研究',
        triggerPhrases: ['实证'],
        deliverable: {
          type: 'empirical_paper',
          typeLabel: '实证论文',
          sections: [
            { id: 'title', title: '题目', kind: 'title', status: 'locked' },
            { id: 'c1', title: '1 引言', kind: 'chapter', status: 'required', purpose: '提出问题', requirements: ['研究缺口'], lengthTarget: '1500字' },
            { id: 'r1', title: '稳健性检验', kind: 'section', status: 'conditional', condition: '有政策冲击时' },
          ],
          structurePolicy: { defaultSections: 5, suggestedMin: 4, suggestedMax: 7 },
          globalLength: '10000-12000 字',
          language: 'zh',
          journalTier: 'core',
        },
        adaptivity: {
          structure: { addSections: true, deleteUnlockedSections: true, splitSections: false, mergeSections: false, reorderSections: true, adjustLength: true },
          content: { reviseQuestion: true, addQuestion: false, reviseHypothesis: true, dropUnsupportedHypothesis: true, adjustFramework: true },
          method: { addMethod: true, replaceUnsuitableMethod: true, addRobustness: true, addHeterogeneity: false, addMechanism: false },
          allowedBacktracks: ['analysis->literature'],
          majorAdjustmentTriggers: ['新证据推翻原假设'],
        },
        writingRules: ['摘要禁止出现本文'],
        methodPolicy: { recommended: ['双重差分'], allowed: [], conditional: [], forbidden: ['纯思辨'] },
        agents: [{ name: '分析智能体', role: '分析', systemPrompt: '负责分析', skillIds: [], toolIds: [], mcpIds: [], maxTurns: 12 }],
        workflow: [{ name: '分析', description: '跑模型', agent: '分析智能体', skillIds: [], toolIds: [], mcpIds: [], maxTurns: 12 }],
        rules: '# 记忆\n引用必须真实',
      },
    });
    const result = service.parseAnalysisResponse(raw);
    expect(result).not.toBeNull();
    expect(result!.summary.deliverableType).toBe('empirical_paper');
    expect(result!.materials[0]!.insights.hardRequirements).toEqual(['引用可查']);
    expect(result!.draft.sections).toHaveLength(3);
    expect(result!.draft.sections[2]!.condition).toBe('有政策冲击时');
    expect(result!.draft.adaptivity?.allowedBacktracks).toEqual(['analysis->literature']);
    expect(result!.draft.agents[0]!.name).toBe('分析智能体');
  });

  it('容错裁剪：非法枚举回退、数量超限截断、条件缺说明降级', () => {
    const raw = JSON.stringify({
      scenario: {
        name: 'X',
        deliverable: {
          type: 'not_a_type',
          sections: [
            { title: '章节A', kind: 'chapter', status: 'weird' },
            { title: '条件项', status: 'conditional' },
          ],
        },
        writingRules: Array.from({ length: 100 }, (_, i) => '规则' + i),
        agents: [{ name: 'A', systemPrompt: 'x' }, { name: 'B' }, { name: 'C', systemPrompt: 'y' }, { name: 'D', systemPrompt: 'z' }, { name: 'E', systemPrompt: 'w' }],
      },
    });
    const result = service.parseAnalysisResponse(raw)!;
    expect(result.draft.deliverableType).toBe('custom');
    expect(result.draft.sections[0]!.status).toBe('required');
    expect(result.draft.sections[1]!.status).toBe('optional');
    expect(result.draft.writingRules).toHaveLength(64);
    expect(result.draft.agents).toHaveLength(3); // 5 个截断到 4，再过滤无 systemPrompt 的 B
  });

  it('无 JSON 时返回 null', () => {
    expect(service.parseAnalysisResponse('抱歉我无法输出')).toBeNull();
  });
});

describe('buildAnalysisPrompts / buildRefinePrompts', () => {
  it('分析提示词包含需求、材料与清单；仅材料时也允许', () => {
    const prompts = service.buildAnalysisPrompts('理论论文场景', [{ name: 'book.pdf', text: '写作方法'.repeat(50) }], '- skill「检索」 id=s1');
    expect(prompts.system).toContain('deliverable');
    expect(prompts.user).toContain('理论论文场景');
    expect(prompts.user).toContain('book.pdf');
    const materialOnly = service.buildAnalysisPrompts('', [{ name: 'a.txt', text: 'x'.repeat(50) }], '');
    expect(materialOnly.user).toContain('完全依据参考材料');
  });

  it('精简提示词按目标类型给出输出结构说明', () => {
    const prompts = service.buildRefinePrompts({ targetKind: 'section', targetTitle: '研究设计', currentValue: '{"purpose":""}', instruction: '按顶刊标准完善' });
    expect(prompts.system).toContain('章节配置字段');
    expect(prompts.user).toContain('研究设计');
  });
});
