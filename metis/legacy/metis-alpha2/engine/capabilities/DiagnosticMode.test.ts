/**
 * METIS-209 — Diagnostic Mode + marketplace hiding tests.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  getDiagnosticMode,
  setDiagnosticMode,
  isNavVisible,
  isTechnicalNav,
  scanForTechnicalLeakage,
  TECHNICAL_NAV_IDS,
} from './DiagnosticMode.js';

describe('METIS-209 DiagnosticMode — default hidden', () => {
  beforeEach(() => setDiagnosticMode('normal'));

  it('defaults to normal mode', () => {
    expect(getDiagnosticMode()).toBe('normal');
  });

  it('technical nav ids are hidden in normal mode', () => {
    for (const id of TECHNICAL_NAV_IDS) {
      expect(isNavVisible(id), `${id} should be hidden`).toBe(false);
    }
  });

  it('normal research nav ids are always visible', () => {
    expect(isNavVisible('projects')).toBe(true);
    expect(isNavVisible('library')).toBe(true);
    expect(isNavVisible('settings')).toBe(true);
  });
});

describe('METIS-209 DiagnosticMode — diagnostic mode reveals technical nav', () => {
  beforeEach(() => setDiagnosticMode('diagnostic'));

  it('technical nav ids become visible in diagnostic mode', () => {
    for (const id of TECHNICAL_NAV_IDS) {
      expect(isNavVisible(id), `${id} should be visible`).toBe(true);
    }
  });
});

describe('METIS-209 DiagnosticMode — leakage scan', () => {
  it('flags technical terms in visible strings without case sensitivity', () => {
    const leaked = scanForTechnicalLeakage([
      '管理你的 skill',
      'mcp 服务器列表',
      'Provider runtime error',
      '打开终端',
      '研究项目',
    ]);
    expect(leaked).toContain('Skill');
    expect(leaked).toContain('MCP');
    expect(leaked).toContain('Provider');
    expect(leaked).toContain('Runtime');
    expect(leaked).toContain('终端');
    expect(leaked).not.toContain('研究项目');
  });

  it('clean user-facing strings and ordinary research uses of 目标 produce no leaks', () => {
    const leaked = scanForTechnicalLeakage([
      '研究项目',
      '资料库',
      '设置',
      '对话',
      '阅读目标',
      '分析',
      '写作',
    ]);
    expect(leaked).toHaveLength(0);
  });

  it('isTechnicalNav correctly classifies', () => {
    expect(isTechnicalNav('evals')).toBe(true);
    expect(isTechnicalNav('projects')).toBe(false);
  });
});
