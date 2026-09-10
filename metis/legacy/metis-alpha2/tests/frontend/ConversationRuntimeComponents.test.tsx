/**
 * 对话渲染组件测试（2026-09-05 P0 Phase 3/5）：
 * LiveAssistantNode 单实例三态 + DOM identity + TurnProcessDisclosure 折叠语义。
 *
 * @vitest-environment jsdom
 */

import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ConversationController } from '../../src/conversation/runtime/ConversationController.js';
import { LiveAssistantNode } from '../../src/conversation/components/ConversationNodeSeat';
import { TurnProcessDisclosure } from '../../src/conversation/components/TurnProcessDisclosure';
import type { TurnProcessEntry } from '../../src/conversation/runtime/turnProcess.js';

afterEach(() => cleanup());

describe('LiveAssistantNode', () => {
  it('keeps one DOM node across streaming → settled (same identity)', () => {
    const controller = new ConversationController();
    controller.beginTurn('t1');
    controller.acceptDelta('t1', '生成中的内容');
    const { container } = render(<LiveAssistantNode controller={controller} attemptId="t1" locale="zh" />);

    const nodeBefore = container.querySelector('.conversation-assistant-node');
    expect(nodeBefore).not.toBeNull();
    expect(nodeBefore?.getAttribute('data-status')).toBe('streaming');

    act(() => {
      controller.settleTurn('t1', '完整最终回答', '', 'completed');
    });
    const nodeAfter = container.querySelector('.conversation-assistant-node');
    expect(nodeAfter).toBe(nodeBefore);
    expect(nodeAfter?.getAttribute('data-status')).toBe('completed');
    expect(container.textContent).toContain('完整最终回答');
  });

  it('shows the interrupted marker and keeps partial content on interrupt', () => {
    const controller = new ConversationController();
    controller.beginTurn('t2');
    controller.acceptDelta('t2', '已生成的前半');
    act(() => {
      controller.settleTurn('t2', '已生成的前半', '', 'interrupted');
    });

    const { container } = render(<LiveAssistantNode controller={controller} attemptId="t2" locale="zh" />);
    expect(container.querySelector('[data-status="interrupted"]')).not.toBeNull();
    expect(container.textContent).toContain('已停止');
    expect(container.textContent).toContain('已生成的前半');
  });

  it('renders nothing for an abandoned attempt', () => {
    const controller = new ConversationController();
    controller.beginTurn('t3');
    controller.acceptDelta('t3', '将被撤销');
    act(() => {
      controller.abandonTurn('t3');
    });
    const { container } = render(<LiveAssistantNode controller={controller} attemptId="t3" locale="zh" />);
    expect(container.querySelector('.conversation-assistant-node')).toBeNull();
  });
});

describe('TurnProcessDisclosure', () => {
  const entries: TurnProcessEntry[] = [
    { id: 'e1', kind: 'tool', label: '搜索文献', status: 'completed' },
    { id: 'e2', kind: 'tool', label: '阅读来源', status: 'running' },
  ];

  it('stays expanded while running and folds into a summary line when settled', () => {
    const running = render(<TurnProcessDisclosure entries={entries} settled={false} />);
    expect(running.container.querySelector('details')?.open).toBe(true);
    expect(running.container.textContent).toContain('正在工作…');
    running.unmount();

    const settledEntries: TurnProcessEntry[] = entries.map((entry) => ({
      ...entry,
      status: 'completed',
    }));
    const settled = render(<TurnProcessDisclosure entries={settledEntries} settled defaultOpen={false} />);
    const details = settled.container.querySelector('details');
    expect(details?.open).toBe(false);
    expect(settled.container.textContent).toContain('2 次工具调用');
  });
});
