/**
 * O17: WorkflowGraph 工作流可视化节点图——N 步工作流渲染 N 个节点、依赖
 * 连线数量与 DAG 一致、空工作流不崩溃、点击节点可查看步骤详情。
 *
 * @vitest-environment jsdom
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import WorkflowGraph, { type WorkflowGraphData } from '../../src/components/WorkflowGraph';

function makeStep(id: string, name: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name,
    description: `${name} 描述`,
    prompt: `${name} 的提示词`,
    tools: ['search_papers'],
    maxTurns: 3,
    ...overrides,
  };
}

function makeWorkflow(overrides: Partial<WorkflowGraphData> = {}): WorkflowGraphData {
  return {
    id: 'wf-1',
    name: '文献综述工作流',
    description: '测试用工作流',
    version: '1',
    steps: [
      makeStep('step-a', '检索文献'),
      makeStep('step-b', '筛选文献'),
      makeStep('step-c', '综合归纳'),
    ],
    dependencies: {
      'step-b': ['step-a'],
      'step-c': ['step-a', 'step-b'],
    },
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
});

describe('WorkflowGraph (O17)', () => {
  it('N 步工作流渲染 N 个节点', () => {
    render(<WorkflowGraph workflow={makeWorkflow()} />);
    expect(screen.getByTestId('workflow-node-step-a')).toBeDefined();
    expect(screen.getByTestId('workflow-node-step-b')).toBeDefined();
    expect(screen.getByTestId('workflow-node-step-c')).toBeDefined();
    expect(screen.getByText('检索文献')).toBeDefined();
    expect(screen.getByText('筛选文献')).toBeDefined();
    expect(screen.getByText('综合归纳')).toBeDefined();
  });

  it('依赖连线数量与 DAG 一致', () => {
    render(<WorkflowGraph workflow={makeWorkflow()} />);
    // step-b←step-a、step-c←step-a、step-c←step-b 共 3 条。
    const edges = screen.getAllByTestId('workflow-edge');
    expect(edges).toHaveLength(3);
    const pairs = edges.map((edge) => `${edge.getAttribute('data-from')}->${edge.getAttribute('data-to')}`);
    expect(pairs).toContain('step-a->step-b');
    expect(pairs).toContain('step-a->step-c');
    expect(pairs).toContain('step-b->step-c');
  });

  it('忽略指向不存在步骤的悬空依赖', () => {
    render(<WorkflowGraph workflow={makeWorkflow({
      dependencies: { 'step-b': ['step-a', 'ghost-step'], 'ghost-step': ['step-a'] },
    })} />);
    expect(screen.getAllByTestId('workflow-edge')).toHaveLength(1);
  });

  it('空工作流渲染占位提示而不崩溃', () => {
    render(<WorkflowGraph workflow={makeWorkflow({ steps: [], dependencies: {} })} />);
    expect(screen.getByTestId('workflow-graph-empty')).toBeDefined();
    expect(screen.queryByTestId('workflow-graph')).toBeNull();
  });

  it('点击节点展示该步详情（prompt / tools / maxTurns / 验收标准 / 运行结果）', () => {
    render(<WorkflowGraph
      workflow={makeWorkflow({
        steps: [makeStep('step-a', '检索文献', {
          prompt: '检索近五年关于 X 的文献',
          maxTurns: 5,
          acceptanceCriteria: ['输出不少于 200 字 (minLength: 200)'],
        })],
        dependencies: {},
      })}
      stepResults={{
        'step-a': {
          status: 'completed',
          output: '检索到 42 篇文献',
          retryCount: 1,
        },
      }}
    />);

    fireEvent.click(screen.getByTestId('workflow-node-step-a'));

    const detail = screen.getByTestId('workflow-step-detail');
    expect(detail).toBeDefined();
    expect(screen.getByTestId('workflow-detail-prompt').textContent).toBe('检索近五年关于 X 的文献');
    expect(screen.getByTestId('workflow-detail-tools').textContent).toBe('search_papers');
    expect(screen.getByTestId('workflow-detail-maxturns').textContent).toBe('5');
    expect(screen.getByTestId('workflow-detail-acceptance').textContent).toContain('minLength');
    expect(screen.getByTestId('workflow-detail-output').textContent).toBe('检索到 42 篇文献');

    // 再点一次收起详情。
    fireEvent.click(screen.getByTestId('workflow-node-step-a'));
    expect(screen.queryByTestId('workflow-step-detail')).toBeNull();
  });

  it('按 run 状态给节点上色并展示失败原因', () => {
    render(<WorkflowGraph
      workflow={makeWorkflow()}
      stepResults={{
        'step-a': { status: 'completed', output: 'done', retryCount: 0 },
        'step-b': { status: 'failed', output: '', retryCount: 2, failureReasons: ['输出过短'], decisionRequired: true },
      }}
    />);

    fireEvent.click(screen.getByTestId('workflow-node-step-b'));
    expect(screen.getByTestId('workflow-detail-failures').textContent).toContain('输出过短');
    expect(screen.getByTestId('workflow-detail-result').textContent).toContain('人工决策');
  });
});
