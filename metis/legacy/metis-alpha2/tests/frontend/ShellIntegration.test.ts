/**
 * METIS-505/506/507/508 — Shell integration tests.
 *
 * 505: ChatPlanIntegration stream + narrative summary.
 * 506: nav config hides technical entries in normal mode.
 * 507: design tokens cover all required categories + light/dark differ.
 * 508: keyboard shortcuts match + locale defaults.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect } from 'vitest';
import { setDiagnosticMode } from '../../engine/capabilities/DiagnosticMode.js';
import { getVisibleNav, getTopLevelNav, isTechnicalNavEntry } from '../../src/shell/navConfig.js';
import { createChatPlanStream, appendItem, narrativeSummary, type ChatStreamItem } from '../../src/shell/ChatPlanIntegration.js';
import { DESIGN_TOKEN_PROPERTIES } from '../../src/shell/designTokens.js';
import { SHORTCUTS, matchShortcut, modeForAction, detectLocale, DEFAULT_LOCALE, shortcutLabel } from '../../src/shell/keyboardShortcuts.js';

// ── METIS-505 ChatPlanIntegration ──

describe('METIS-505 ChatPlanIntegration — unified message + execution stream', () => {
  it('appends items in chronological order', () => {
    let s = createChatPlanStream();
    const a: ChatStreamItem = { id: '1', kind: 'message', at: 200, message: { role: 'user', content: 'hi' } };
    const b: ChatStreamItem = { id: '2', kind: 'message', at: 100, message: { role: 'assistant', content: 'hello' } };
    s = appendItem(appendItem(s, a), b);
    expect(s.items[0]!.id).toBe('2'); // at=100 first
    expect(s.items[1]!.id).toBe('1');
  });

  it('narrativeSummary describes the latest item in user language', () => {
    let s = createChatPlanStream();
    s = appendItem(s, { id: '1', kind: 'progress', at: 1, progress: { stepName: '检索文献', completed: 2, total: 5 } });
    expect(narrativeSummary(s)).toMatch(/检索文献.*2\/5/);
    s = appendItem(s, { id: '2', kind: 'approval', at: 2, approval: { requestId: 'r', toolName: 'execute_command', argsSummary: '...', status: 'pending' } });
    expect(narrativeSummary(s)).toMatch(/需要您确认/);
    s = appendItem(s, { id: '3', kind: 'artifact', at: 3, artifact: { artifactId: 'a', title: '综述', reviewStatus: 'draft' } });
    expect(narrativeSummary(s)).toMatch(/生成了成果.*综述/);
    s = appendItem(s, { id: '4', kind: 'failure_recovery', at: 4, failure: { error: '断网', recovered: true, recoveryAction: '已重试' } });
    expect(narrativeSummary(s)).toMatch(/遇到错误并已恢复/);
  });
});

// ── METIS-506 nav visibility ──

describe('METIS-506 navConfig — technical entries hidden in normal mode', () => {
  it('normal mode shows only the three top-level + one mode entry', () => {
    setDiagnosticMode('normal');
    const ids = getVisibleNav().map((n) => n.id);
    // 协同对话一级工作区已取消（2026-09-05 刘总规格）。
    expect(ids).toEqual([
      'projects',
      'settings',
    ]);
    // technical entries absent
    expect(ids).not.toContain('evals');
    expect(ids).not.toContain('mcp_admin');
    expect(ids).not.toContain('skill_admin');
    expect(ids).not.toContain('terminal');
  });

  it('there are exactly three top-level entries in fixed order', () => {
    expect(getTopLevelNav().map((entry) => entry.id)).toEqual([
      'projects',
      'settings',
    ]);
  });

  it('diagnostic mode reveals the technical entries', () => {
    setDiagnosticMode('diagnostic');
    const ids = getVisibleNav().map((n) => n.id);
    expect(ids).toContain('evals');
    expect(ids).toContain('mcp_admin');
    setDiagnosticMode('normal'); // restore
  });

  it('isTechnicalNavEntry classifies correctly', () => {
    expect(isTechnicalNavEntry('evals')).toBe(true);
    expect(isTechnicalNavEntry('projects')).toBe(false);
  });
});

// ── METIS-507 design tokens ──

describe('METIS-507 designTokens — academic visual system', () => {
  it('the typed CSS adapter covers all required categories', () => {
    const properties = DESIGN_TOKEN_PROPERTIES;
    expect(properties.bgMain).toBe('--bg-main');
    expect(properties.textHeading).toBe('--text-heading');
    expect(properties.accentPrimary).toBe('--accent');
    // evidence status colors present
    for (const k of ['evidenceVerified', 'evidencePending', 'evidenceContested', 'evidenceStale', 'evidenceRefuted'] as const) {
      expect(properties[k]).toMatch(/^--evidence-/u);
    }
    // chart palette has enough distinct CSS properties
    expect(properties.chartPalette.length).toBeGreaterThanOrEqual(6);
    expect(new Set(properties.chartPalette).size).toBe(properties.chartPalette.length);
    // typography + spacing + borders + focus ring
    expect(properties.fontSerif).toBe('--font-serif');
    expect(properties.focusRingColor).toBe('--focus-ring-color');
    expect(properties.focusRingShadow).toBe('--focus-ring-shadow');
    expect(properties.borderLight).toBe('--border-light');
  });

  it('contains property names only, never visual values', () => {
    for (const property of Object.values(DESIGN_TOKEN_PROPERTIES).flat()) {
      expect(property).toMatch(/^--[a-z][a-z0-9-]+$/u);
    }
  });
});

// ── METIS-508 keyboard + locale ──

describe('METIS-508 keyboardShortcuts + locale', () => {
  it('Ctrl+1/2 switch modes (windows)', () => {
    expect(matchShortcut({ key: '1', metaKey: false, ctrlKey: true, shiftKey: false, altKey: false }, 'Win32')?.action).toBe('switch_converse');
    expect(matchShortcut({ key: '2', metaKey: false, ctrlKey: true, shiftKey: false, altKey: false }, 'Win32')?.action).toBe('switch_write');
  });

  it('Cmd+K opens global search (mac uses metaKey)', () => {
    expect(matchShortcut({ key: 'k', metaKey: true, ctrlKey: false, shiftKey: false, altKey: false }, 'MacIntel')?.action).toBe('global_search');
    // On Windows, Ctrl+K
    expect(matchShortcut({ key: 'k', metaKey: false, ctrlKey: true, shiftKey: false, altKey: false }, 'Win32')?.action).toBe('global_search');
  });

  it('Ctrl+[ and Ctrl+] toggle the panels', () => {
    expect(matchShortcut({ key: '[', metaKey: false, ctrlKey: true, shiftKey: false, altKey: false }, 'Win32')?.action).toBe('toggle_left');
    expect(matchShortcut({ key: ']', metaKey: false, ctrlKey: true, shiftKey: false, altKey: false }, 'Win32')?.action).toBe('toggle_right');
  });

  it('modeForAction maps switch actions to modes', () => {
    expect(modeForAction('switch_write')).toBe('write');
    expect(modeForAction('global_search')).toBeNull();
  });

  it('every shortcut has both zh and en descriptions (full i18n coverage)', () => {
    for (const s of SHORTCUTS) {
      expect(s.description.length).toBeGreaterThan(0);
      expect(s.descriptionEn.length).toBeGreaterThan(0);
    }
  });

  it('default locale is Chinese', () => {
    expect(DEFAULT_LOCALE).toBe('zh');
  });

  it('detectLocale honors browser languages, defaults to zh', () => {
    expect(detectLocale(['zh-CN', 'zh', 'en'])).toBe('zh');
    expect(detectLocale(['en-US'])).toBe('en');
    expect(detectLocale([])).toBe('zh');
  });

  it('shortcutLabel returns the locale-appropriate text', () => {
    const s = SHORTCUTS[0]!;
    expect(shortcutLabel(s, 'zh')).toBe(s.description);
    expect(shortcutLabel(s, 'en')).toBe(s.descriptionEn);
  });
});
