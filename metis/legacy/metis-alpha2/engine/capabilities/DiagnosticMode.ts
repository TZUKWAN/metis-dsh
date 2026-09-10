/**
 * Diagnostic Mode gate (METIS-209).
 *
 * Keeps Skill/MCP/Marketplace/terminal/sandbox/eval底层概念 OUT of the normal user flow,
 * visible only under an explicit "高级 > 开发者诊断" toggle. The capability layer itself is
 * NOT removed (METIS-201/203 still use MCP connectors internally) — only the USER-FACING
 * entry points are hidden by default.
 *
 * The renderer reads `getDiagnosticMode()` to decide whether to show technical nav items;
 * METIS-506 wires this into the actual App shell.
 */

export type UIMode = 'normal' | 'diagnostic';

/** User-facing technical entries that must NOT appear in normal mode (METIS-107 dictionary). */
export const TECHNICAL_NAV_IDS = [
  'evals',
  'mcp_admin',
  'skill_admin',
  'terminal',
  'runtime',
  'logs',
  'audit_raw',
] as const;

export type TechnicalNavId = (typeof TECHNICAL_NAV_IDS)[number];

const STORAGE_KEY = 'metis-diagnostic-mode';

let currentMode: UIMode = 'normal';

export function getDiagnosticMode(): UIMode {
  // In renderer, hydrate from localStorage once.
  if (currentMode === 'normal' && typeof localStorage !== 'undefined') {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored === 'diagnostic') currentMode = 'diagnostic';
    } catch {
      /* ignore */
    }
  }
  return currentMode;
}

export function setDiagnosticMode(mode: UIMode): void {
  currentMode = mode;
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(STORAGE_KEY, mode);
    } catch {
      /* ignore */
    }
  }
}

/** Whether a given nav id is visible under the current mode. */
export function isNavVisible(navId: string): boolean {
  if (!isTechnicalNav(navId)) return true; // normal research nav always visible
  return getDiagnosticMode() === 'diagnostic';
}

export function isTechnicalNav(navId: string): navId is TechnicalNavId {
  return (TECHNICAL_NAV_IDS as readonly string[]).includes(navId);
}

/**
 * Scan a list of user-visible strings for technical-concept leakage (METIS-107/209).
 * Returns the leaked terms found. Used by the UI audit (METIS-506 visual scan).
 */
export const LEAKED_TERMS = [
  'Agent',
  'Goal',
  'Workflow',
  'Skill',
  'Tool',
  'MCP',
  'Runtime',
  'Eval',
  'Provider',
  'HITL',
  'Terminal',
  '代理',
  '工作流',
  '技能',
  '工具',
  '运行时',
  '评估',
  '提供商',
  '终端',
] as const;

export function scanForTechnicalLeakage(visibleStrings: string[]): string[] {
  const found = new Set<string>();
  for (const visibleString of visibleStrings) {
    const normalized = visibleString.toLocaleLowerCase();
    for (const term of LEAKED_TERMS) {
      if (normalized.includes(term.toLocaleLowerCase())) found.add(term);
    }
  }
  return [...found];
}
