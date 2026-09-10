/**
 * 任务4 第十四节 —— Stale State / Async View State 语义测试。
 *
 * 状态矩阵（任务书要求的可区分语义）：
 * - 第一次 load 成功 → ready / empty；
 * - 已有数据第二次 refresh 失败 → 旧数据保留 + stale；
 * - 第一次 load 就失败 → error + retry，绝不显示成"空列表"。
 */

import { describe, it, expect, vi } from 'vitest';
import { renderHook, render, act, waitFor, screen } from '@testing-library/react';
import {
  deriveAsyncViewState,
  useAsyncView,
  usePendingAction,
  type AsyncViewError,
} from '../../src/components/async/asyncViewState';

const ERROR: AsyncViewError = { message: '加载失败', code: 'TEST_FAIL' };

function describeState(input: Parameters<typeof deriveAsyncViewState>[0]) {
  return deriveAsyncViewState(input);
}

describe('deriveAsyncViewState —— 纯状态矩阵', () => {
  it('首次加载成功且非空 → ready', () => {
    const state = describeState({ phase: 'initial', succeeded: true, hasEverSucceeded: false, data: [1], isEmptyData: false, error: null, reloading: false });
    expect(state.status).toBe('ready');
    expect(state.isFromLastSuccess).toBe(false);
  });

  it('首次加载成功但为空 → empty（不等于 error）', () => {
    const state = describeState({ phase: 'initial', succeeded: true, hasEverSucceeded: false, data: [], isEmptyData: true, error: null, reloading: false });
    expect(state.status).toBe('empty');
  });

  it('首次加载失败 → error + data=null（绝不冒充空列表）', () => {
    const state = describeState({ phase: 'initial', succeeded: false, hasEverSucceeded: false, data: null, isEmptyData: false, error: ERROR, reloading: false });
    expect(state.status).toBe('error');
    expect(state.data).toBeNull();
    expect(state.error?.code).toBe('TEST_FAIL');
  });

  it('已有数据刷新失败 → 旧数据保留 + stale', () => {
    const state = describeState({ phase: 'refresh', succeeded: false, hasEverSucceeded: true, data: ['旧数据'], isEmptyData: false, error: ERROR, reloading: false });
    expect(state.status).toBe('stale');
    expect(state.data).toEqual(['旧数据']);
    expect(state.isFromLastSuccess).toBe(true);
  });

  it('重试在途且已有数据 → retrying（旧数据继续可见）', () => {
    const state = describeState({ phase: 'refresh', succeeded: false, hasEverSucceeded: true, data: ['旧数据'], isEmptyData: false, error: null, reloading: true });
    expect(state.status).toBe('retrying');
    expect(state.data).toEqual(['旧数据']);
  });

  it('重试在途且无历史数据 → loading', () => {
    const state = describeState({ phase: 'initial', succeeded: false, hasEverSucceeded: false, data: null, isEmptyData: false, error: null, reloading: true });
    expect(state.status).toBe('loading');
  });
});

describe('useAsyncView —— hook 行为', () => {
  it('首次失败进入 error，重试成功后进入 ready', async () => {
    let shouldFail = true;
    const { result } = renderHook(() => useAsyncView(() => {
      if (shouldFail) return Promise.reject(new Error('boom'));
      return Promise.resolve(['数据']);
    }, { isEmpty: (items: string[]) => items.length === 0 }));

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.data).toBeNull();

    shouldFail = false;
    act(() => { result.current.reload(); });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.data).toEqual(['数据']);
  });

  it('成功后刷新失败：旧数据保留 + stale 提示语义', async () => {
    let shouldFail = false;
    const { result } = renderHook(() => useAsyncView(() => {
      if (shouldFail) return Promise.reject(new Error('boom'));
      return Promise.resolve(['第一次的数据']);
    }));

    await waitFor(() => expect(result.current.status).toBe('ready'));
    shouldFail = true;
    act(() => { result.current.reload(); });
    await waitFor(() => expect(result.current.status).toBe('stale'));
    expect(result.current.data).toEqual(['第一次的数据']);
    expect(result.current.isFromLastSuccess).toBe(true);
    expect(result.current.error).not.toBeNull();
  });

  it('成功但空结果 → empty，不显示错误', async () => {
    const { result } = renderHook(() => useAsyncView(() => Promise.resolve([]), { isEmpty: (items: string[]) => items.length === 0 }));
    await waitFor(() => expect(result.current.status).toBe('empty'));
    expect(result.current.error).toBeNull();
  });
});

describe('usePendingAction —— mutation 防双击', () => {
  it('pending 期间的重复调用被忽略（只执行一次）', async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const operation = vi.fn(() => gate);
    const { result } = renderHook(() => usePendingAction());

    let first = false;
    let second = false;
    act(() => { void result.current.run(operation).then((ok) => { first = ok; }); });
    act(() => { void result.current.run(operation).then((ok) => { second = ok; }); });
    expect(result.current.pending).toBe(true);
    await act(async () => { release?.(); });
    expect(operation).toHaveBeenCalledTimes(1);
    expect(first).toBe(true);
    expect(second).toBe(false);
    await waitFor(() => expect(result.current.pending).toBe(false));
  });

  it('操作抛错时 pending 正确复位（失败不卡死按钮）', async () => {
    const { result } = renderHook(() => usePendingAction());
    await act(async () => {
      await result.current.run(() => Promise.reject(new Error('failed')));
    });
    expect(result.current.pending).toBe(false);
  });
});

// ── P0-5 race regression: scope switch during an in-flight load ─────────────

describe('useAsyncView — scope switch during in-flight load (P0-5)', () => {
  it('replays the queued scope switch after the in-flight load settles', async () => {
    const loads: Array<string> = [];
    let releaseA: (value: string[]) => void = () => {};
    const gateA = new Promise<string[]>((resolve) => { releaseA = resolve; });

    function Probe({ projectId }: { projectId: string }) {
      const view = useAsyncView<string[]>(async () => {
        loads.push(projectId);
        if (projectId === 'proj-a') return gateA;
        return [`items-${projectId}`];
      }, { deps: [projectId] });
      return <div data-testid="status">{view.status}</div>;
    }

    const { rerender } = render(<Probe projectId="proj-a" />);
    await waitFor(() => expect(loads).toEqual(['proj-a']));
    expect(screen.getByTestId('status').textContent).toBe('loading');

    // Switch scope while A is in flight: B must be QUEUED, then replayed.
    rerender(<Probe projectId="proj-b" />);
    await waitFor(() => expect(loads).toContain('proj-b'));

    // A finally resolves — it must NOT land in B's view.
    releaseA(['stale-a-items']);
    await waitFor(() => expect(screen.getByTestId('status').textContent).not.toBe('loading'));
    await waitFor(() => expect(loads.filter((x) => x === 'proj-b').length).toBeGreaterThanOrEqual(1));
    expect(loads[0]).toBe('proj-a');
  });
});
