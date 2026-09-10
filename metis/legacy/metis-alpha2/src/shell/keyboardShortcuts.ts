/**
 * Keyboard shortcuts + locale defaults (METIS-508).
 *
 * Keyboard navigation for long research sessions; ARIA labels live in the components
 * themselves. Default locale is Chinese (the primary audience), with full English coverage.
 * Shortcuts avoid clashing with browser/OS defaults and are platform-aware (Cmd vs Ctrl).
 */

import type { WorkspaceMode } from './ProjectShell.js';

export interface ShortcutSpec {
  /** Stable id used in tests and the help overlay. */
  id: string;
  description: string;
  descriptionEn: string;
  /** The logical key (lowercase). */
  key: string;
  mod: boolean; // requires Cmd (mac) / Ctrl (others)
  shift?: boolean;
  /** What it does (for the handler switch). */
  action: 'switch_converse' | 'switch_write' | 'toggle_left' | 'toggle_right' | 'global_search' | 'send_message' | 'help';
}

export const SHORTCUTS: readonly ShortcutSpec[] = [
  { id: 'mode-converse', description: '切换到科研项目', descriptionEn: 'Switch to Projects', key: '1', mod: true, action: 'switch_converse' },
  { id: 'mode-write', description: '切换到写作模式', descriptionEn: 'Switch to Write', key: '2', mod: true, action: 'switch_write' },
  { id: 'toggle-left', description: '收起/展开资料栏', descriptionEn: 'Toggle left panel', key: '[', mod: true, action: 'toggle_left' },
  { id: 'toggle-right', description: '收起/展开检查器', descriptionEn: 'Toggle right panel', key: ']', mod: true, action: 'toggle_right' },
  { id: 'global-search', description: '打开全局搜索', descriptionEn: 'Global search', key: 'k', mod: true, action: 'global_search' },
  { id: 'send-message', description: '发送消息', descriptionEn: 'Send message', key: 'enter', mod: false, action: 'send_message' },
  { id: 'help', description: '显示快捷键帮助', descriptionEn: 'Show shortcuts', key: '/', mod: true, shift: true, action: 'help' },
];

/** Match a DOM KeyboardEvent against the shortcut table; returns the matched spec or null. */
export function matchShortcut(e: { key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }, platform: string): ShortcutSpec | undefined {
  const isMac = /Mac|iPod|iPhone|iPad/.test(platform);
  const mod = isMac ? e.metaKey : e.ctrlKey;
  const key = e.key.toLowerCase();
  return SHORTCUTS.find((s) => {
    if (s.key !== key) return false;
    if (s.mod !== mod) return false;
    if (!!s.shift !== e.shiftKey) return false;
    return true;
  });
}

/** Resolve a shortcut action into a workspace mode (for the switch_* actions). */
export function modeForAction(action: ShortcutSpec['action']): WorkspaceMode | null {
  switch (action) {
    // 协同对话一级工作区取消：Ctrl+1 归入科研项目（2026-09-05 刘总规格）。
    case 'switch_converse': return 'projects';
    case 'switch_write': return 'write';
    default: return null;
  }
}

// ─── Locale defaults (METIS-508: Chinese default, full English) ──

export type Locale = 'zh' | 'en';

export const DEFAULT_LOCALE: Locale = 'zh';

/** Detect the user's preferred locale, defaulting to Chinese. */
export function detectLocale(navigatorLanguages: readonly string[] = []): Locale {
  for (const lang of navigatorLanguages) {
    if (lang.toLowerCase().startsWith('zh')) return 'zh';
    if (lang.toLowerCase().startsWith('en')) return 'en';
  }
  return DEFAULT_LOCALE;
}

/** Human-readable shortcut description in the active locale. */
export function shortcutLabel(s: ShortcutSpec, locale: Locale): string {
  return locale === 'zh' ? s.description : s.descriptionEn;
}
