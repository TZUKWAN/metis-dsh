/**
 * O17: GoalPage 挂载 WorkflowGraph——选中带工作流的 goal 时渲染 DAG 节点图；
 * 无工作流（或接口不可用）时页面其余部分照常展示。
 *
 * @vitest-environment jsdom
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import GoalPage from '../../src/pages/GoalPage';

const GOAL = {
  goalId: 'goal-1',
  label: 'Research goal',
  status: 'running',
  createdAt: 1,
};

const WORKFLOW_VIEW = {
  success: true as const,
  goalId: 'goal-1',
  workflow: {
    id: 'wf-1',
    name: '综述工作流',
    description: '两步工作流',
    version: '1',
    steps: [
      { id: 'step-a', name: '检索', description: '', prompt: '检索文献', tools: [], maxTurns: 3 },
      { id: 'step-b', name: '归纳', description: '', prompt: '归纳结果', tools: [], maxTurns: 2 },
    ],
    dependencies: { 'step-b': ['step-a'] },
  },
  stepResults: {
    'step-a': { status: 'completed' as const, output: '完成', retryCount: 0 },
  },
};

function mockMetis(overrides: Record<string, unknown> = {}) {
  const metis = {
    listGoals: vi.fn(async () => ({ success: true, goals: [GOAL] })),
    getGoalWorkflow: vi.fn(async () => WORKFLOW_VIEW),
    ...overrides,
  };
  (window as unknown as { metis: unknown }).metis = metis;
  return metis;
}

afterEach(() => {
  cleanup();
  (window as unknown as { metis: unknown }).metis = undefined;
});

describe('GoalPage workflow graph (O17)', () => {
  it('选中 goal 后渲染工作流节点图（节点 + 依赖连线）', async () => {
    mockMetis();
    render(<GoalPage />);

    // 侧边栏 goal 条目（genericLabel「研究目标」可能多处出现，按 class 精确定位）。
    const goalItem = await screen.findByText('研究目标', { selector: '.goal-item-title' });
    fireEvent.click(goalItem.closest('button')!);

    await waitFor(() => expect(screen.getByTestId('workflow-graph')).toBeDefined());
    expect(screen.getByTestId('workflow-node-step-a')).toBeDefined();
    expect(screen.getByTestId('workflow-node-step-b')).toBeDefined();
    expect(screen.getAllByTestId('workflow-edge')).toHaveLength(1);
  });

  it('goal 没有工作流时不渲染图，其余详情照常', async () => {
    mockMetis({
      getGoalWorkflow: vi.fn(async () => ({ success: false, code: 'goal_workflow_unavailable' })),
    });
    render(<GoalPage />);

    const goalItem = await screen.findByText('研究目标', { selector: '.goal-item-title' });
    fireEvent.click(goalItem.closest('button')!);

    await waitFor(() => expect(screen.getByTestId('goal-socratic-plan')).toBeDefined());
    await waitFor(() => {
      const metis = (window as unknown as { metis: { getGoalWorkflow: ReturnType<typeof vi.fn> } }).metis;
      expect(metis.getGoalWorkflow).toHaveBeenCalledWith('goal-1');
    });
    expect(screen.queryByTestId('workflow-graph')).toBeNull();
  });
});

describe('GoalPage workflow drag-reorder (O17)', () => {
  it('dragging a node onto another calls updatePlan with swapped steps', async () => {
    const updatePlan = vi.fn(async () => ({ valid: true, errors: [], warnings: [] }));
    mockMetis({ updatePlan });
    render(<GoalPage />);

    const goalItem = await screen.findByText('研究目标', { selector: '.goal-item-title' });
    fireEvent.click(goalItem.closest('button')!);
    await waitFor(() => expect(screen.getByTestId('workflow-node-step-a')).toBeDefined());

    const nodeA = screen.getByTestId('workflow-node-step-a');
    const nodeB = screen.getByTestId('workflow-node-step-b');

    // HTML5 DnD simulation: drag A onto B.
    fireEvent.dragStart(nodeA, { dataTransfer: { setData: vi.fn(), getData: () => 'step-a', effectAllowed: 'move' } as unknown as DataTransfer });
    fireEvent.dragOver(nodeB, { dataTransfer: { preventDefault: vi.fn() } as unknown as DataTransfer });
    fireEvent.drop(nodeB, { dataTransfer: { getData: () => 'step-a' } as unknown as DataTransfer });

    await waitFor(() => expect(updatePlan).toHaveBeenCalled());
    const [goalId, workflow] = updatePlan.mock.calls[0] as [string, { steps: Array<{ id: string }> }];
    expect(goalId).toBe('goal-1');
    // Steps swapped: first step is now step-b.
    expect(workflow.steps[0]?.id).toBe('step-b');
    expect(workflow.steps[1]?.id).toBe('step-a');
  });
});
