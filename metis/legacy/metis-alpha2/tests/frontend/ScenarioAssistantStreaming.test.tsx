/**
 * Scenario Builder 流式接入统一框架的回归测试（2026-09-06 P0 遗留清理）。
 * 验证：streamTail 不再 400/220 字截断——完整累积内容通过 StreamingMarkdown
 * 呈现；reasoning 走 details 折叠（轻量形态保留）。
 *
 * @vitest-environment jsdom
 */

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PersonalizationDefinition, ScenarioDefinition } from '../../engine/runtime/PersonalizationRuntimeContract.js';

function scenario(): ScenarioDefinition {
  return {
    contractVersion: 1,
    id: 'user:scenario/research-paper',
    kind: 'scenario',
    name: '实证论文',
    description: '',
    enabled: true,
    tags: [],
    revision: 3,
    provenance: { origin: 'user', author: 'test', version: '1.0.0', license: null, sourceUrl: null, sourceRevision: null, installedDigest: null, parentId: null, parentVersion: null, locallyModified: true, createdAt: 1, updatedAt: 1 },
    agentIds: [],
    skillIds: [],
    mcpIds: [],
    rulesIds: [],
    workflow: [{
      id: 'outline', name: '设计提纲', description: '', goal: '', prompt: '根据资料设计提纲。', inputs: [], outputs: [],
      completionCriteria: ['提纲覆盖全部交付章节。'], condition: null, skillIds: [], mcpIds: [], toolIds: [], dependsOn: [], maxTurns: 12,
    }],
    fullAccess: { mode: 'full_access', perActionConfirmation: false, liveSteering: true, silentCheckpoints: true, rollbackOnFailure: false, persistAcrossRestart: true },
    memory: { scope: 'project', retainDecisions: true, retainArtifacts: true, maxSummaryChars: 4_000 },
    output: { format: 'markdown', schema: null, plan: { primaryDeliverable: '实证论文', supportingArtifacts: [], qualityCriteria: [] }, requireEvidenceEnvelope: false, includeIntegrityReport: false },
    triggerPhrases: [],
    capability: 'research',
    deliverable: {
      type: 'empirical_paper', language: 'zh', globalLength: '', secondarySections: { min: 2, max: 4 },
      structurePolicy: { defaultSections: 1, suggestedMin: 1, suggestedMax: 1 },
      sections: [],
    },
  } as ScenarioDefinition;
}

type StreamChunk = { content?: string; reasoning?: string };

function installMetis(): { pushChunk: (chunk: StreamChunk) => void } {
  let streamListener: ((chunk: StreamChunk) => void) | undefined;
  const metis = {
    // never-resolving：让助手进入持续 busy（streamTail 常驻显示），供流式断言。
    compileScenarioHarness: vi.fn().mockImplementation(() => new Promise<void>(() => {})),
    scenarioConversationUnits: vi.fn().mockResolvedValue([]),
    scenarioConversationCreate: vi.fn(),
    scenarioConversationDelete: vi.fn(),
    scenarioConversationMessages: vi.fn().mockResolvedValue([]),
    onScenarioStreamChunk: vi.fn().mockImplementation((listener: (chunk: StreamChunk) => void) => {
      streamListener = listener;
      return () => {
        streamListener = undefined;
      };
    }),
    onScenarioCompileEvent: vi.fn().mockReturnValue(() => {}),
  };
  window.metis = metis as unknown as typeof window.metis;
  return {
    pushChunk(chunk: StreamChunk): void {
      streamListener?.(chunk);
    },
  };
}

async function renderAssistant(): Promise<void> {
  const current = scenario();
  const props = {
    zh: true,
    definitions: [current] as PersonalizationDefinition[],
    selectedId: current.id,
    onSelect: vi.fn(),
    save: vi.fn().mockImplementation(async (definition: PersonalizationDefinition) => ({
      ok: true, code: 'saved', definition: { ...definition, revision: definition.revision + 1 },
    })),
    createScenario: vi.fn(),
    onActivateScenario: vi.fn(),
    onDeleteScenario: vi.fn(),
    reload: vi.fn().mockResolvedValue(undefined),
    projectId: 'project-1',
  };
  const { default: ScenarioWorkbench } = await import('../../src/personalization/ScenarioWorkbench.js');
  render(<ScenarioWorkbench {...props} />);
  await waitFor(() => expect(screen.getByTestId('sw-configuration-assistant')).toBeTruthy());
}

describe('ScenarioConfigurationAssistant unified streaming (P0 Phase 7)', () => {
  beforeEach(() => {
    window.metis = undefined;
  });

  it('renders the full accumulated stream content without 220-char truncation', async () => {
    const stream = installMetis();
    await renderAssistant();

    // 发送一条指令（harness 挂起不返回）→ 助手进入持续 busy，streamTail 常驻显示。
    fireEvent.change(screen.getByPlaceholderText(/例如：我要写一篇/), { target: { value: '开始编译' } });
    fireEvent.click(screen.getByTestId('sw-assistant-send'));

    // 第一段超过 220 字：旧实现 slice(-220) 只剩尾巴，完整内容必然丢失。
    const longPart = `${'流式内容完整保留验证。'.repeat(30)}【第一段落结束标记】`;
    act(() => stream.pushChunk({ content: longPart }));
    await waitFor(() => expect(screen.getByTitle('输出流')).toBeTruthy());

    const rendered = screen.getByTitle('输出流').textContent ?? '';
    expect(rendered).toContain('【第一段落结束标记】');
    expect(rendered.length).toBeGreaterThan(220);

    // 第二段追加：增量渲染继续保留第一段内容。
    act(() => stream.pushChunk({ content: '\n\n第二段落追加内容。' }));
    await waitFor(() => expect(screen.getByTitle('输出流')!.textContent).toContain('第二段落追加内容'));
    expect(screen.getByTitle('输出流').textContent).toContain('【第一段落结束标记】');
  });

  it('shows reasoning behind a lightweight disclosure with the full text', async () => {
    const stream = installMetis();
    await renderAssistant();

    fireEvent.change(screen.getByPlaceholderText(/例如：我要写一篇/), { target: { value: '开始编译' } });
    fireEvent.click(screen.getByTestId('sw-assistant-send'));

    const reasoning = `${'推理过程完整可回看。'.repeat(20)}【推理结束标记】`;
    act(() => stream.pushChunk({ reasoning, content: '' }));

    const details = await screen.findByTitle('模型推理流');
    expect(details).toBeTruthy();
    // 轻量形态：默认收起（summary 行），展开后可见完整推理文本（不再 slice(-220)）。
    expect((details as HTMLDetailsElement).open).toBe(false);
    fireEvent.click(details.querySelector('summary')!);
    expect((details as HTMLDetailsElement).open).toBe(true);
    expect(details.textContent).toContain('【推理结束标记】');
  });
});

function actLike(fn: () => void): void {
  act(fn);
}
