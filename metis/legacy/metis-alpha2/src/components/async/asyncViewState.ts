/**
 * 统一 Async View State（任务4 第三节）。
 *
 * 共享语义：idle / loading / ready / empty / partial / stale / error / retrying。
 *
 * 规则（与任务书一致）：
 * - 首次加载失败 → `error`（必须可重试），绝不冒充空列表；
 * - 已有数据刷新失败 → 保留旧数据 + `stale`（提示"当前显示上次成功加载的数据"）；
 * - 成功但无数据 → `empty`，与 error 严格区分；
 * - 禁止 catch 后什么都不说。
 */

import { useCallback, useEffect, useRef, useState } from 'react';

export type AsyncViewStatus =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'empty'
  | 'partial'
  | 'stale'
  | 'error'
  | 'retrying';

export interface AsyncViewError {
  /** 面向用户的"发生了什么/影响什么/下一步"主文案。 */
  message: string;
  /** 开发者诊断用错误码；不在普通用户界面突出展示。 */
  code?: string;
}

export interface AsyncViewState<T> {
  status: AsyncViewStatus;
  /** 最近一次成功加载的数据；stale/error 下可能仍是旧数据（isFromLastSuccess=true）。 */
  data: T | null;
  error: AsyncViewError | null;
  /** 数据是否来自上一次成功加载（stale 语义的判定依据）。 */
  isFromLastSuccess: boolean;
}

export interface AsyncViewResult<T> extends AsyncViewState<T> {
  /** 触发一次（重）加载。加载期间重复调用会被忽略。 */
  reload: () => void;
  /** 是否有加载在途（loading 或 retrying）。 */
  isLoading: boolean;
}

export interface UseAsyncViewOptions<T> {
  /** 空判定：success 且 isEmpty(data) → empty 而非 ready。 */
  isEmpty?: (data: T) => boolean;
  /** 依赖变化时自动重新加载；为 undefined 时仅在 mount 后加载一次。 */
  deps?: readonly unknown[];
  /** 失败文案（可携带 code）。 */
  errorMessage?: string;
  errorCode?: string;
  /** 传 enabled=false 时不自动开始加载（idle）。 */
  enabled?: boolean;
}

/**
 * 把"这次结果 + 是否已有成功历史"归约为统一的视图状态。
 * 纯函数，便于直接单测状态矩阵。
 */
export function deriveAsyncViewState<T>(
  input: {
    phase: 'initial' | 'refresh';
    succeeded: boolean;
    hasEverSucceeded: boolean;
    data: T | null;
    isEmptyData: boolean;
    error: AsyncViewError | null;
    reloading: boolean;
  },
): AsyncViewState<T> {
  const { phase, succeeded, hasEverSucceeded, data, isEmptyData, error, reloading } = input;
  if (reloading) {
    // 重试在途：已有数据则保持可见（stale→retrying），否则进入首次 loading。
    return {
      status: hasEverSucceeded ? 'retrying' : 'loading',
      data,
      error: null,
      isFromLastSuccess: hasEverSucceeded,
    };
  }
  if (succeeded) {
    if (isEmptyData) {
      // 空结果不等于 error；也覆盖"上次失败后这次成功但为空"。
      return { status: 'empty', data, error: null, isFromLastSuccess: false };
    }
    return { status: phase === 'initial' || !hasEverSucceeded ? 'ready' : 'ready', data, error: null, isFromLastSuccess: false };
  }
  // 失败：
  if (hasEverSucceeded && data !== null) {
    // 已有数据刷新失败：保留旧数据 + stale notice。
    return { status: 'stale', data, error, isFromLastSuccess: true };
  }
  // 首次加载失败（或无任何历史成功数据）：error + retry，绝不显示成空列表。
  return { status: 'error', data: null, error, isFromLastSuccess: false };
}

/**
 * 统一的列表/视图加载 hook。
 *
 * ```tsx
 * const view = useAsyncView(() => metis.listOutcomes({ projectId }), {
 *   isEmpty: (items) => items.length === 0,
 *   deps: [projectId],
 *   errorMessage: '无法加载成果列表。',
 * });
 * if (view.status === 'error') return <InlineError ... onRetry={view.reload} />;
 * ```
 */
export function useAsyncView<T>(load: () => Promise<T>, options: UseAsyncViewOptions<T> = {}): AsyncViewResult<T> {
  const { isEmpty, deps, errorMessage = '加载失败，请稍后重试。', errorCode, enabled = true } = options;
  const loadRef = useRef(load);
  loadRef.current = load;
  const isEmptyRef = useRef(isEmpty);
  isEmptyRef.current = isEmpty;

  const [state, setState] = useState<AsyncViewState<T>>(() => ({
    status: enabled ? 'loading' : 'idle',
    data: null,
    error: null,
    isFromLastSuccess: false,
  }));
  const hasEverSucceededRef = useRef(false);
  const inFlightRef = useRef(false);
  const runIdRef = useRef(0);
  // 记录"启用状态经历过变化"，使 disabled→enabled 转变能触发首载。
  const everEnabledRef = useRef(enabled);
  everEnabledRef.current = everEnabledRef.current || enabled;

  // P0-5 race fix: a scope switch that lands while a load is in flight used
  // to be silently dropped (`if (inFlightRef.current) return`), so the NEW
  // scope never loaded and the OLD scope's response would settle into the new
  // view — a cross-scope stale render. Now the switch is queued and replayed
  // the moment the in-flight load settles; the generation guard below still
  // discards whichever response is superseded.
  const pendingPhaseRef = useRef<'initial' | 'refresh' | null>(null);
  const run = useCallback((phase: 'initial' | 'refresh') => {
    if (inFlightRef.current) {
      // 展示层立即进入 loading/retrying，完成后按 pending 阶段重启加载。
      pendingPhaseRef.current = phase;
      setState((prev) => deriveAsyncViewState({
        phase,
        succeeded: false,
        hasEverSucceeded: hasEverSucceededRef.current,
        data: prev.data,
        isEmptyData: false,
        error: null,
        reloading: true,
      }));
      return;
    }
    inFlightRef.current = true;
    const runId = ++runIdRef.current;
    setState((prev) => deriveAsyncViewState({
      phase,
      succeeded: false,
      hasEverSucceeded: hasEverSucceededRef.current,
      data: prev.data,
      isEmptyData: false,
      error: null,
      reloading: true,
    }));
    void (async () => {
      let succeeded = false;
      let nextData: T | null = null;
      let failure: AsyncViewError | null = null;
      try {
        nextData = await loadRef.current();
        succeeded = true;
      } catch (err) {
        failure = {
          message: errorMessage,
          ...(errorCode !== undefined ? { code: errorCode } : {}),
        };
        // 错误细节只进 console 诊断，不冒充成功，也不吞掉。
        console.error('[asyncView] load failed:', err);
      }
      if (runId !== runIdRef.current) return; // 已有更新的加载接管（本次响应被丢弃）
      inFlightRef.current = false;
      if (succeeded) hasEverSucceededRef.current = true;
      setState((prev) => deriveAsyncViewState({
        phase,
        succeeded,
        hasEverSucceeded: hasEverSucceededRef.current,
        data: succeeded ? nextData : prev.data,
        isEmptyData: succeeded ? (isEmptyRef.current?.(nextData as T) ?? false) : false,
        error: failure,
        reloading: false,
      }));
      // 被排队的作用域切换：in-flight 结束后立即以最新加载器重放。
      const pendingPhase = pendingPhaseRef.current;
      if (pendingPhase !== null) {
        pendingPhaseRef.current = null;
        run(pendingPhase === 'refresh' || hasEverSucceededRef.current ? 'refresh' : 'initial');
      }
    })();
   
  }, [errorMessage, errorCode]);

  const reload = useCallback(() => {
    run(hasEverSucceededRef.current ? 'refresh' : 'initial');
  }, [run]);

  useEffect(() => {
    if (!enabled) return;
    run(hasEverSucceededRef.current ? 'refresh' : 'initial');
    return () => { runIdRef.current += 1; inFlightRef.current = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deps 由调用方声明
  }, deps ?? []);

  return {
    status: state.status,
    data: state.data,
    error: state.error,
    isFromLastSuccess: state.isFromLastSuccess,
    isLoading: state.status === 'loading' || state.status === 'retrying',
    reload,
  };
}

/**
 * Mutation 防双击守卫（任务4 第五节）。
 *
 * pending 期间所有后续 run() 直接忽略（双击保护）；
 * run() 本身永不向调用方抛错（调用点多为 `void run(...)`，重抛会变成
 * unhandled rejection）——但绝不静默吞错：失败记入 console 诊断并返回 false，
 * 用户可见的失败提示由调用方在操作内部负责给出。
 *
 * ```tsx
 * const act = usePendingAction();
 * <button disabled={act.pending} onClick={() => act.run(async () => {
 *   const ok = await metis.archiveProject(id);
 *   if (!ok) setNotice({ kind: 'error', text: '归档未完成' });
 * })}>归档</button>
 * ```
 */
export interface PendingAction {
  pending: boolean;
  /** 执行一个受守卫的异步操作；pending 期间的重复调用返回 false 且不执行。 */
  run: (operation: () => Promise<void>) => Promise<boolean>;
}

export function usePendingAction(): PendingAction {
  const [pending, setPending] = useState(false);
  const inFlightRef = useRef(false);
  const run = useCallback(async (operation: () => Promise<void>): Promise<boolean> => {
    if (inFlightRef.current) return false;
    inFlightRef.current = true;
    setPending(true);
    try {
      await operation();
      return true;
    } catch (error) {
      // 不吞错（任务4 第八节）：留下诊断日志；界面提示由调用方负责。
      console.error('[pendingAction] operation failed:', error);
      return false;
    } finally {
      inFlightRef.current = false;
      setPending(false);
    }
  }, []);
  return { pending, run };
}
