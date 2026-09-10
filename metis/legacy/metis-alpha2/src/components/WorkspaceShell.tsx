import { useCallback, useEffect, useRef, useState } from 'react';
import './WorkspaceShell.css';

/**
 * WorkspaceShell（T7，2026-09-08）：METIS 复杂工作区统一三栏布局系统。
 *
 * Left = Navigation/Context；Primary = 中央主工作区（最高宽度优先级，永不挤坏）；
 * Right = Inspector（空间不足优先折叠为 drawer）。
 *
 * 响应式基线（提示词 4.2）：
 *   ≥1600: 220-260 / fluid / 320-360
 *   1200-1599: 190-220 / ≥650 / 280-320
 *   960-1199: 左 compact，右默认折叠
 *   <960: 左右均 drawer
 * 拒绝 App 级横向滚动；不用 overflow-x:hidden 掩盖布局错误。
 */

export interface WorkspaceShellPanelConfig {
  /** localStorage 持久化键前缀（宽度/折叠态）。 */
  storageKey: string;
  defaultLeftWidth?: number;
  defaultRightWidth?: number;
  /** 右栏窄屏自动折叠的断点（默认 1200）。 */
  collapseBreakpoint?: number;
}

const MIN_LEFT = 180;
const MAX_LEFT = 420;
const MIN_RIGHT = 260;
const MAX_RIGHT = 620;
const MIN_PRIMARY = 560;

function readNumber(key: string, fallback: number): number {
  try {
    const raw = window.localStorage.getItem(key);
    const value = raw ? Number(raw) : NaN;
    return Number.isFinite(value) ? value : fallback;
  } catch { return fallback; }
}

function readBool(key: string, fallback: boolean): boolean {
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? fallback : raw === '1';
  } catch { return fallback; }
}

export function useWorkspaceShell(config: WorkspaceShellPanelConfig) {
  const { storageKey, defaultLeftWidth = 232, defaultRightWidth = 336, collapseBreakpoint = 1200 } = config;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [leftWidth, setLeftWidth] = useState(() => Math.min(MAX_LEFT, Math.max(MIN_LEFT, readNumber(`${storageKey}:left`, defaultLeftWidth))));
  const [rightWidth, setRightWidth] = useState(() => Math.min(MAX_RIGHT, Math.max(MIN_RIGHT, readNumber(`${storageKey}:right`, defaultRightWidth))));
  const [leftCollapsed, setLeftCollapsed] = useState(() => readBool(`${storageKey}:left-collapsed`, false));
  const [rightCollapsed, setRightCollapsed] = useState(() => readBool(`${storageKey}:right-collapsed`, false));
  const [windowWidth, setWindowWidth] = useState(() => window.innerWidth);

  useEffect(() => {
    const onResize = () => setWindowWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // 窄屏自动折叠右栏（用户手动展开的 drawer 态不在此列——窄屏用 drawer 渲染）。
  const narrow = windowWidth < collapseBreakpoint;
  const veryNarrow = windowWidth < 960;
  const rightEffectiveCollapsed = rightCollapsed || (narrow && !readBool(`${storageKey}:right-pinned`, false));

  const applyLeftDrag = useCallback((clientX: number) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const primaryWidth = rect.width - (leftCollapsed ? 0 : leftWidth) - (rightEffectiveCollapsed ? 0 : rightWidth);
    if (primaryWidth - (clientX - rect.left) < MIN_PRIMARY) return; // 保护中央区
    setLeftWidth(Math.min(MAX_LEFT, Math.max(MIN_LEFT, Math.round(clientX - rect.left))));
  }, [leftCollapsed, leftWidth, rightEffectiveCollapsed, rightWidth]);

  const applyRightDrag = useCallback((clientX: number) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    if (clientX - rect.left < MIN_PRIMARY) return; // 保护中央区
    setRightWidth(Math.min(MAX_RIGHT, Math.max(MIN_RIGHT, Math.round(rect.right - clientX))));
  }, []);

  const persist = useCallback(() => {
    try {
      window.localStorage.setItem(`${storageKey}:left`, String(leftWidth));
      window.localStorage.setItem(`${storageKey}:right`, String(rightWidth));
      window.localStorage.setItem(`${storageKey}:left-collapsed`, leftCollapsed ? '1' : '0');
      window.localStorage.setItem(`${storageKey}:right-collapsed`, rightCollapsed ? '1' : '0');
    } catch { /* best-effort */ }
  }, [leftCollapsed, leftWidth, rightCollapsed, rightWidth, storageKey]);

  return {
    containerRef,
    windowWidth,
    narrow,
    veryNarrow,
    leftWidth,
    rightWidth,
    leftCollapsed,
    rightCollapsed: rightEffectiveCollapsed,
    setLeftCollapsed,
    setRightCollapsed,
    applyLeftDrag,
    applyRightDrag,
    persist,
  };
}

export interface WorkspaceShellProps {
  left: React.ReactNode;
  primary: React.ReactNode;
  right?: React.ReactNode;
  shell: ReturnType<typeof useWorkspaceShell>;
  labels?: { left?: string; right?: string };
}

/** 三栏 Shell 组件：中央 flex:1/min-width:0 永不挤坏；左右可折叠。 */
export function WorkspaceShell({ left, primary, right, shell, labels }: WorkspaceShellProps) {
  const { narrow, veryNarrow, leftWidth, rightWidth, leftCollapsed, rightCollapsed } = shell;
  const [leftDrawerOpen, setLeftDrawerOpen] = useState(false);
  const [rightDrawerOpen, setRightDrawerOpen] = useState(false);

  return (
    <div ref={shell.containerRef} className="workspace-shell" data-narrow={narrow || undefined} data-very-narrow={veryNarrow || undefined}>
      {/* Left：正常栏 或 抽屉触发 */}
      {!veryNarrow && !leftCollapsed && (
        <aside className="workspace-shell__left" style={{ width: leftWidth, flex: `0 0 ${leftWidth}px` }} aria-label={labels?.left ?? 'Navigation'}>
          {left}
        </aside>
      )}
      {!veryNarrow && leftCollapsed && (
        <button type="button" className="workspace-shell__rail workspace-shell__rail--left" onClick={() => shell.setLeftCollapsed(false)} aria-label={labels?.left ? `展开${labels.left}` : 'Expand left panel'}>»</button>
      )}
      {veryNarrow && (
        <button type="button" className="workspace-shell__rail workspace-shell__rail--left" onClick={() => setLeftDrawerOpen(true)} aria-label={labels?.left ? `打开${labels.left}` : 'Open left drawer'}>»</button>
      )}

      {/* Primary：flex:1 min-width:0 */}
      <main className="workspace-shell__primary">{primary}</main>

      {/* Right */}
      {right !== undefined && !veryNarrow && !rightCollapsed && (
        <aside className="workspace-shell__right" style={{ width: rightWidth, flex: `0 0 ${rightWidth}px` }} aria-label={labels?.right ?? 'Inspector'}>
          {right}
        </aside>
      )}
      {right !== undefined && (veryNarrow || rightCollapsed) && !veryNarrow && (
        <button type="button" className="workspace-shell__rail workspace-shell__rail--right" onClick={() => shell.setRightCollapsed(false)} aria-label={labels?.right ? `展开${labels.right}` : 'Expand right panel'}>«</button>
      )}
      {right !== undefined && veryNarrow && (
        <button type="button" className="workspace-shell__rail workspace-shell__rail--right" onClick={() => setRightDrawerOpen(true)} aria-label={labels?.right ? `打开${labels.right}` : 'Open right drawer'}>«</button>
      )}

      {/* Narrow drawers */}
      {veryNarrow && leftDrawerOpen && (
        <div className="workspace-shell__drawer-mask" onClick={() => setLeftDrawerOpen(false)} role="presentation">
          <aside className="workspace-shell__drawer workspace-shell__drawer--left" onClick={(event) => event.stopPropagation()} aria-label={labels?.left ?? 'Navigation'}>
            {left}
          </aside>
        </div>
      )}
      {veryNarrow && rightDrawerOpen && (
        <div className="workspace-shell__drawer-mask" onClick={() => setRightDrawerOpen(false)} role="presentation">
          <aside className="workspace-shell__drawer workspace-shell__drawer--right" onClick={(event) => event.stopPropagation()} aria-label={labels?.right ?? 'Inspector'}>
            {right}
          </aside>
        </div>
      )}
    </div>
  );
}
