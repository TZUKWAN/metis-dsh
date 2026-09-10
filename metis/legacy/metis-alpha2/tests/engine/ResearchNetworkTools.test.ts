/**
 * research-network-tools — QA 门与对抗审查（T34/T35）。
 * fetch_citation_network 走真实 OpenAlex（live 可选），此处测确定性部分。
 */

import { describe, expect, it } from 'vitest';
import { getResearchNetworkToolHandlers } from '../../engine/tools/builtin/research-network-tools.js';

const handlers = getResearchNetworkToolHandlers();

describe('adversarial_review（T34）', () => {
  it('输出对抗审查指令且含"不得编造攻击点"约束', async () => {
    const run = handlers.get('adversarial_review')!;
    const raw = await run({ content: '回归显示 X 对 Y 有显著正效应（p<0.01）。', stakes: '论文核心结论' }, { projectId: 'p1' });
    const parsed = JSON.parse(raw as string);
    expect(parsed.instruction).toContain('红队');
    expect(parsed.instruction).toContain('不得为了输出而编造攻击点');
    expect(parsed.contentLength).toBeGreaterThan(10);
  });

  it('空内容拒绝', async () => {
    const run = handlers.get('adversarial_review')!;
    expect(await run({ content: '' }, { projectId: 'p1' })).toContain('Error');
  });
});

describe('run_qa_gate（T35）', () => {
  it('数字与事实冲突 → blocked + 红灯项', async () => {
    const run = handlers.get('run_qa_gate')!;
    const raw = await run({
      manuscriptText: '女性占比 58%，样本量 N=1,200。',
      computedFacts: [{ label: '女性占比', value: 55.2, unit: '%' }, { label: '样本量', value: 1200, unit: '个' }],
    }, { projectId: 'p1' });
    const parsed = JSON.parse(raw as string);
    expect(parsed.verdict).toBe('blocked');
    expect(parsed.redItems.join(' ')).toContain('数字与计算事实冲突');
  });

  it('全部一致且无行为声称 → pass', async () => {
    const run = handlers.get('run_qa_gate')!;
    const raw = await run({
      manuscriptText: '女性占比 55.2%，样本量 N=1,200。',
      computedFacts: [{ label: '女性占比', value: 55.2, unit: '%' }, { label: '样本量', value: 1200, unit: '个' }],
    }, { projectId: 'p1' });
    const parsed = JSON.parse(raw as string);
    expect(parsed.verdict).toBe('pass');
    expect(parsed.checks.numericConsistency.ok).toBe(true);
  });

  it('引用真实性以 CitationTruth 清单提示衔接', async () => {
    const run = handlers.get('run_qa_gate')!;
    const raw = await run({ manuscriptText: '无数字文本。' }, { projectId: 'p1' });
    const parsed = JSON.parse(raw as string);
    expect(parsed.checks.citationTruth.note).toContain('claim_manifest_verify');
  });
});
