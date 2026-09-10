/**
 * TerminalPanel — xterm.js terminal panel for Metis.
 *
 * Connects to a node-pty instance in the main process via IPC.
 * Shell is cmd.exe (Windows) or bash (Linux/macOS).
 * Renders as a collapsible bottom panel in the Chat page.
 */

import { useEffect, useRef, useCallback, useState, useMemo } from 'react';
import { Terminal, type ITheme } from '@xterm/xterm';
import { TerminalIcon } from './Icons';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { useTranslation } from '../i18n';
import {
  decodeTerminalCreateResult,
  decodeTerminalDataEvent,
  decodeTerminalExitEvent,
  decodeTerminalGrantResult,
  decodeTerminalOperationResult,
  TERMINAL_RUNTIME_LIMITS,
  type TerminalCreateRequest,
  type TerminalKillRequest,
  type TerminalResizeRequest,
  type TerminalWriteRequest,
} from '../../engine/runtime/TerminalRuntimeContract';

// ─── Theme ────────────────────────────────────────────────

/**
 * The terminal sits on the app's warm dark code-block surface in both themes,
 * so the ANSI palette is curated data (a terminal color scheme), while the
 * surface/cursor colors follow the active AcademicTheme tokens. The palette
 * is read once at terminal creation; a theme switch applies on next mount.
 */
function buildTerminalTheme(): ITheme {
  const style = getComputedStyle(document.documentElement);
  const dark = document.documentElement.dataset.theme === 'dark';
  // Raw, non-throwing token reads: the terminal must still mount when the
  // theme stylesheet is absent (tests, early boot).
  const read = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  const background = read('--bg-code-block', dark ? '#171613' : '#201e19');
  // ANSI hues: in dark mode the status/chart tokens are already bright enough
  // for the code-block surface; in light mode they are dark surface colors, so
  // fall back to a curated warm-bright set (terminal scheme data, not UI chrome).
  const red = dark ? read('--status-failed', '#fc8181') : '#f0939a';
  const green = dark ? read('--status-completed', '#68d391') : '#a6d3a0';
  const yellow = dark ? read('--evidence-pending', '#f0bd84') : '#ecd3a0';
  const blue = dark ? read('--chart-4', '#7aa2d4') : '#8faed4';
  const foreground = dark ? '#e8e4da' : '#ede8dd';
  const magenta = dark ? '#cba6f7' : '#c4b5fd';
  const cyan = dark ? '#94e2d5' : '#7fc8bd';
  return {
    background,
    foreground,
    cursor: read('--accent', dark ? '#d3c6a6' : '#263a59'),
    selectionBackground: dark ? '#585b7066' : '#e8e4da44',
    black: dark ? '#45475a' : '#3a382f',
    red,
    green,
    yellow,
    blue,
    magenta,
    cyan,
    white: dark ? '#bac2de' : '#c9c2b2',
    brightBlack: dark ? '#585b70' : '#57534a',
    brightRed: red,
    brightGreen: green,
    brightYellow: yellow,
    brightBlue: blue,
    brightMagenta: magenta,
    brightCyan: cyan,
    brightWhite: read('--text-muted', dark ? '#99937f' : '#6b6659'),
  };
}

// ─── Props ────────────────────────────────────────────────

interface TerminalPanelProps {
  visible: boolean;
  onToggle: () => void;
}

interface TargetTerminalAPI {
  requestTerminalGrant(): Promise<unknown>;
  createTerminal(request: TerminalCreateRequest): Promise<unknown>;
  writeTerminal(request: TerminalWriteRequest): Promise<unknown>;
  resizeTerminal(request: TerminalResizeRequest): Promise<unknown>;
  killTerminal(request: TerminalKillRequest): Promise<unknown>;
  onTerminalData(callback: (event: unknown) => void): () => void;
  onTerminalExit(callback: (event: unknown) => void): () => void;
}

function getTargetTerminalAPI(): TargetTerminalAPI | null {
  const candidate = window.metis as unknown as Partial<TargetTerminalAPI> | undefined;
  return candidate
    && typeof candidate.requestTerminalGrant === 'function'
    && typeof candidate.createTerminal === 'function'
    && typeof candidate.writeTerminal === 'function'
    && typeof candidate.resizeTerminal === 'function'
    && typeof candidate.killTerminal === 'function'
    && typeof candidate.onTerminalData === 'function'
    && typeof candidate.onTerminalExit === 'function'
    ? candidate as TargetTerminalAPI
    : null;
}

// ─── Component ────────────────────────────────────────────

export default function TerminalPanel({ visible, onToggle }: TerminalPanelProps) {
  const { locale } = useTranslation();
  const copy = useMemo(() => locale === 'zh' ? {
    title: '受控终端',
    drag: '拖动调整大小',
    collapse: '收起终端',
    expand: '展开终端',
    requesting: '正在请求终端授权…',
    denied: '未获得终端授权。请确认授权后重试。',
    unavailable: '受控终端暂不可用。请稍后重试。',
    ended: (code: number) => `终端会话已结束（退出码 ${code}）。`,
  } : {
    title: 'Controlled terminal',
    drag: 'Drag to resize',
    collapse: 'Collapse terminal',
    expand: 'Expand terminal',
    requesting: 'Requesting terminal authorization…',
    denied: 'Terminal authorization was not granted. Confirm the request and retry.',
    unavailable: 'The controlled terminal is unavailable. Please retry.',
    ended: (code: number) => `Terminal session ended (exit code ${code}).`,
  }, [locale]);
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const terminalIdRef = useRef<string | null>(null);
  const sessionGrantIdRef = useRef<string | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const disposedRef = useRef(false);
  const failureShownRef = useRef(false);
  const lastDataSequenceRef = useRef(-1);
  const lastExitSequenceRef = useRef(-1);
  const writeQueueRef = useRef<Promise<void>>(Promise.resolve());
  const [height, setHeight] = useState(280);

  const showSafeFailure = useCallback((message: string) => {
    if (failureShownRef.current) return;
    failureShownRef.current = true;
    termRef.current?.write(`\r\n\x1b[31m${message}\x1b[0m\r\n`);
  }, []);

  const clearTerminalSession = useCallback(() => {
    cleanupRef.current?.();
    cleanupRef.current = null;
    terminalIdRef.current = null;
    sessionGrantIdRef.current = null;
    lastDataSequenceRef.current = -1;
    lastExitSequenceRef.current = -1;
    writeQueueRef.current = Promise.resolve();
  }, []);

  // ─── Initialize terminal ────────────────────────────────

  useEffect(() => {
    if (!visible || !containerRef.current || termRef.current) return;
    disposedRef.current = false;

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: '"Cascadia Code", "Fira Code", "JetBrains Mono", Consolas, monospace',
      theme: buildTerminalTheme(),
      allowProposedApi: true,
      scrollback: 5000,
      convertEol: true,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);
    fitAddon.fit();

    termRef.current = term;
    fitAddonRef.current = fitAddon;

    return () => {
      disposedRef.current = true;
      const terminalId = terminalIdRef.current;
      const sessionAccessGrantId = sessionGrantIdRef.current;
      const api = getTargetTerminalAPI();
      if (api && terminalId && sessionAccessGrantId) {
        void api.killTerminal({ terminalId, sessionAccessGrantId }).catch(() => undefined);
      }
      clearTerminalSession();
      term.dispose();
      termRef.current = null;
      fitAddonRef.current = null;
    };
  }, [visible, clearTerminalSession]);

  // ─── Spawn PTY when terminal becomes visible ────────────

  useEffect(() => {
    if (!visible || !termRef.current || terminalIdRef.current !== null) return;

    const term = termRef.current;
    const fitAddon = fitAddonRef.current;
    if (!fitAddon) return;
    let cancelled = false;
    failureShownRef.current = false;
    term.write(`\r\n\x1b[90m${copy.requesting}\x1b[0m\r\n`);

    void (async () => {
      const api = getTargetTerminalAPI();
      if (!api) {
        showSafeFailure(copy.unavailable);
        return;
      }

      let grantResult: ReturnType<typeof decodeTerminalGrantResult>;
      try {
        grantResult = decodeTerminalGrantResult(await api.requestTerminalGrant());
      } catch {
        showSafeFailure(copy.unavailable);
        return;
      }
      if (!grantResult.success) {
        showSafeFailure(copy.denied);
        return;
      }
      if (cancelled || disposedRef.current) return;

      const createRequest: TerminalCreateRequest = {
        executionGrantId: grantResult.grant.grantId,
        cols: Math.max(
          TERMINAL_RUNTIME_LIMITS.minimumColumns,
          Math.min(TERMINAL_RUNTIME_LIMITS.maximumColumns, term.cols || 80),
        ),
        rows: Math.max(
          TERMINAL_RUNTIME_LIMITS.minimumRows,
          Math.min(TERMINAL_RUNTIME_LIMITS.maximumRows, term.rows || 24),
        ),
      };
      let createResult: ReturnType<typeof decodeTerminalCreateResult>;
      try {
        createResult = decodeTerminalCreateResult(await api.createTerminal(createRequest));
      } catch {
        showSafeFailure(copy.unavailable);
        return;
      }
      if (!createResult.success) {
        showSafeFailure(copy.unavailable);
        return;
      }

      if (cancelled || disposedRef.current) {
        void api.killTerminal({
          terminalId: createResult.terminalId,
          sessionAccessGrantId: createResult.sessionAccessGrantId,
        }).catch(() => undefined);
        return;
      }

      terminalIdRef.current = createResult.terminalId;
      sessionGrantIdRef.current = createResult.sessionAccessGrantId;
      lastDataSequenceRef.current = -1;
      lastExitSequenceRef.current = -1;
      const cleanupParts: Array<() => void> = [];
      try {
        const inputDisposable = term.onData((data: string) => {
          const terminalId = terminalIdRef.current;
          const sessionAccessGrantId = sessionGrantIdRef.current;
          if (!terminalId || !sessionAccessGrantId) return;
          for (
            let offset = 0;
            offset < data.length;
            offset += TERMINAL_RUNTIME_LIMITS.writeChars
          ) {
            const chunk = data.slice(offset, offset + TERMINAL_RUNTIME_LIMITS.writeChars);
            writeQueueRef.current = writeQueueRef.current.then(async () => {
              if (
                terminalIdRef.current !== terminalId
                || sessionGrantIdRef.current !== sessionAccessGrantId
              ) {
                return;
              }
              const request: TerminalWriteRequest = {
                terminalId,
                sessionAccessGrantId,
                data: chunk,
              };
              try {
                const result = decodeTerminalOperationResult(await api.writeTerminal(request));
                if (!result.success) showSafeFailure(copy.unavailable);
              } catch {
                showSafeFailure(copy.unavailable);
              }
            });
          }
        });
        cleanupParts.push(() => inputDisposable.dispose());

        const unsubscribeData = api.onTerminalData((rawEvent) => {
          const event = decodeTerminalDataEvent(rawEvent);
          if (
            event
            && event.terminalId === terminalIdRef.current
            && event.sequence > lastDataSequenceRef.current
          ) {
            lastDataSequenceRef.current = event.sequence;
            term.write(event.data);
          }
        });
        cleanupParts.push(unsubscribeData);

        const unsubscribeExit = api.onTerminalExit((rawEvent) => {
          const event = decodeTerminalExitEvent(rawEvent);
          if (
            !event
            || event.terminalId !== terminalIdRef.current
            || event.sequence <= lastExitSequenceRef.current
          ) return;
          lastExitSequenceRef.current = event.sequence;
          term.write(`\r\n\x1b[90m${copy.ended(event.exitCode)}\x1b[0m\r\n`);
          clearTerminalSession();
        });
        cleanupParts.push(unsubscribeExit);

        cleanupRef.current = () => {
          for (const cleanup of cleanupParts.splice(0).reverse()) {
            try { cleanup(); } catch { /* subscription already released */ }
          }
        };
      } catch {
        for (const cleanup of cleanupParts.splice(0).reverse()) {
          try { cleanup(); } catch { /* subscription already released */ }
        }
        void api.killTerminal({
          terminalId: createResult.terminalId,
          sessionAccessGrantId: createResult.sessionAccessGrantId,
        }).catch(() => undefined);
        clearTerminalSession();
        showSafeFailure(copy.unavailable);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [visible, copy, showSafeFailure, clearTerminalSession]);

  // ─── Resize handling ────────────────────────────────────

  useEffect(() => {
    if (!visible || !fitAddonRef.current) return;

    const observer = new ResizeObserver(() => {
      try {
        fitAddonRef.current?.fit();
        const terminalId = terminalIdRef.current;
        const sessionAccessGrantId = sessionGrantIdRef.current;
        const api = getTargetTerminalAPI();
        if (api && terminalId && sessionAccessGrantId && termRef.current) {
          const request: TerminalResizeRequest = {
            terminalId,
            sessionAccessGrantId,
            cols: Math.max(
              TERMINAL_RUNTIME_LIMITS.minimumColumns,
              Math.min(TERMINAL_RUNTIME_LIMITS.maximumColumns, termRef.current.cols),
            ),
            rows: Math.max(
              TERMINAL_RUNTIME_LIMITS.minimumRows,
              Math.min(TERMINAL_RUNTIME_LIMITS.maximumRows, termRef.current.rows),
            ),
          };
          void api.resizeTerminal(request).then((rawResult) => {
            if (!decodeTerminalOperationResult(rawResult).success) {
              showSafeFailure(copy.unavailable);
            }
          }).catch(() => showSafeFailure(copy.unavailable));
        }
      } catch {
        // Terminal may be disposed during resize
      }
    });

    if (containerRef.current) {
      observer.observe(containerRef.current);
    }

    // Fit immediately
    setTimeout(() => {
      try { fitAddonRef.current?.fit(); } catch { /* ignore */ }
    }, 100);

    return () => observer.disconnect();
  }, [visible, height, copy.unavailable, showSafeFailure]);

  // ─── Drag to resize ─────────────────────────────────────

  const handleDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = height;

    const onMouseMove = (ev: MouseEvent) => {
      const delta = startY - ev.clientY;
      const newH = Math.max(120, Math.min(600, startH + delta));
      setHeight(newH);
    };

    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, [height]);

  // ─── Render ─────────────────────────────────────────────

  return (
    <div className={`terminal-panel ${visible ? 'visible' : ''}`}>
      {/* Drag handle */}
      {visible && (
        <div
          className="terminal-panel-drag-handle"
          onMouseDown={handleDragStart}
          title={copy.drag}
        />
      )}

      {/* Header bar */}
      <div className="terminal-panel-header" onClick={onToggle}>
        <div className="terminal-panel-title">
          <span className="terminal-icon"><TerminalIcon size={14} /></span>
          <span>{copy.title}</span>
        </div>
        <button className="terminal-panel-toggle" title={visible ? copy.collapse : copy.expand}>
          {visible ? (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 15 12 9 18 15" /></svg>
          ) : (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9" /></svg>
          )}
        </button>
      </div>

      {/* Terminal container */}
      {visible && (
        <div
          className="terminal-panel-content"
          ref={containerRef}
          style={{ height: height - 32 }}
        />
      )}
    </div>
  );
}
