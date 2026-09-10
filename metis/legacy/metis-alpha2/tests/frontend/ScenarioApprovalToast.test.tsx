/**
 * ScenarioApprovalToast — 场景步骤审批页内界面测试。
 * 覆盖：主进程推送后弹窗、批准/拒绝回传、无请求时不渲染。
 *
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('ScenarioApprovalToast', () => {
  let listeners: Record<string, Array<(payload: unknown) => void>>;
  let respondScenarioApproval: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    listeners = {};
    respondScenarioApproval = vi.fn().mockResolvedValue({ ok: true });
    Object.defineProperty(window, 'metis', {
      configurable: true,
      writable: true,
      value: {
        onScenarioApprovalRequired: (callback: (payload: unknown) => void) => {
          listeners['scenario:approval:required'] = [callback];
          return () => { delete listeners['scenario:approval:required']; };
        },
        respondScenarioApproval,
      },
    });
  });

  afterEach(() => {
    Object.defineProperty(window, 'metis', { configurable: true, writable: true, value: undefined });
  });

  function push(payload: unknown) {
    for (const callback of listeners['scenario:approval:required'] ?? []) callback(payload);
  }

  it('无审批请求时不渲染', async () => {
    const { default: Toast } = await import('../../src/components/ScenarioApprovalToast.js');
    render(<Toast />);
    expect(screen.queryByTestId('scenario-approval-dialog')).toBeNull();
  });

  it('主进程推送后显示审批卡并可拒绝（回传 approve=false）', async () => {
    const { default: Toast } = await import('../../src/components/ScenarioApprovalToast.js');
    render(<Toast />);
    push({ requestId: 'req-1', hookId: 'hook-1', stepId: 'step-1', instruction: '请审批本步骤', runId: 'run-1' });
    expect(await screen.findByTestId('scenario-approval-dialog')).toBeTruthy();
    expect(screen.getByText(/step-1/u)).toBeTruthy();
    fireEvent.click(screen.getByTestId('scenario-approval-reject'));
    await waitFor(() => expect(respondScenarioApproval).toHaveBeenCalledWith('req-1', false));
    await waitFor(() => expect(screen.queryByTestId('scenario-approval-dialog')).toBeNull());
  });

  it('批准回传 approve=true', async () => {
    const { default: Toast } = await import('../../src/components/ScenarioApprovalToast.js');
    render(<Toast />);
    push({ requestId: 'req-2', hookId: 'hook-1', stepId: 'step-2', instruction: '', runId: 'run-1' });
    fireEvent.click(await screen.findByTestId('scenario-approval-approve'));
    await waitFor(() => expect(respondScenarioApproval).toHaveBeenCalledWith('req-2', true));
    await waitFor(() => expect(screen.queryByTestId('scenario-approval-dialog')).toBeNull());
  });

  it('忽略无 requestId 的非法推送', async () => {
    const { default: Toast } = await import('../../src/components/ScenarioApprovalToast.js');
    render(<Toast />);
    push({ stepId: 'x' });
    await waitFor(() => expect(respondScenarioApproval).not.toHaveBeenCalled());
    expect(screen.queryByTestId('scenario-approval-dialog')).toBeNull();
  });
});
