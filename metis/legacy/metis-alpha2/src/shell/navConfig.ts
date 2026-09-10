/**
 * Navigation visibility config (METIS-506).
 *
 * Builds the user-facing nav list from the diagnostic-mode gate (METIS-209). In normal mode
 * only research actions appear; technical entries (Skill/MCP/Sandbox/Eval/Terminal/Runtime)
 * are hidden and reachable only under 设置 > 高级 > 开发者诊断.
 */

/**
 * 任务4 注释收敛：本文件历史上同时残留过「三个 top-level」「两个 top-level」
 * 等互相矛盾的注释。当前实际结构（2026-09-05 刘总规格）：
 * - TopLevelEntry 持久化入口只有两个：projects / settings；
 * - 顶层可见导航 = 科研项目（workspace）+ 选题/成果/投稿（research）+ 场景中心（preference toggle）；
 * - 「协同对话」一级工作区已取消，Chatbot 迁入选题工作区。
 */

import { isNavVisible } from '../../engine/capabilities/DiagnosticMode.js';

export interface NavEntry {
  id: string;
  /** User-facing label key (METIS-107 dictionary — no technical jargon). */
  labelKey: string;
  /** 持久化 top-level 入口（projects/settings）；research/preference 目的地同样是顶层视觉位置。 */
  isTopLevel: boolean;
  /**
   * Optional one-line "what is this workspace for" tooltip key (O11). When
   * present the top bar renders it as the hover title so new users can tell
   * the workspaces apart without trial-and-error. Falls back to labelKey.
   */
  descriptionKey?: string;
}

/**
 * The canonical normal-mode nav：两个持久化 top-level 入口（projects/settings）。
 * 注释收敛说明见文件头（任务4）。 */
const NORMAL_NAV: NavEntry[] = [
  { id: 'projects', labelKey: 'nav.projects', descriptionKey: 'nav.projectsDesc', isTopLevel: true },
  { id: 'settings', labelKey: 'nav.settings', descriptionKey: 'nav.settingsDesc', isTopLevel: true },
  // 「协同对话」一级工作区已取消（2026-09-05 刘总规格）：第三方 AI 能力迁入
  // 选题 Topic Workspace 的「打开 Chatbot」临时协作视图，不再占用一级导航。
];

/**
 * Technical entries that ONLY appear in diagnostic mode. Their label keys intentionally
 * use technical terms — they are developer-facing, never shown to a researcher.
 */
const DIAGNOSTIC_NAV: NavEntry[] = [
  { id: 'evals', labelKey: 'nav.evals', isTopLevel: false },
  { id: 'mcp_admin', labelKey: 'nav.mcpAdmin', isTopLevel: false },
  { id: 'skill_admin', labelKey: 'nav.skillAdmin', isTopLevel: false },
  { id: 'terminal', labelKey: 'nav.terminal', isTopLevel: false },
  { id: 'runtime', labelKey: 'nav.runtime', isTopLevel: false },
  { id: 'logs', labelKey: 'nav.logs', isTopLevel: false },
];

/** The full nav list for the current mode (filters technical entries when normal). */
export function getVisibleNav(): NavEntry[] {
  return [...NORMAL_NAV, ...DIAGNOSTIC_NAV].filter((e) => isNavVisible(e.id));
}

/** Only the three legacy top-level entries (kept for session compatibility). */
export function getTopLevelNav(): NavEntry[] {
  return NORMAL_NAV.filter((e) => e.isTopLevel);
}

/**
 * Primary top-bar modes. These are deliberately separate from TopLevelEntry:
 * the persisted app entry remains projects/library/settings while researchers
 * navigate directly between the four workspaces.
 */
export function getPrimaryWorkspaceNav(): NavEntry[] {
  // 协同对话取消后，workspace 一级仅剩科研项目（2026-09-05 刘总规格）。
  const byId = new Map(NORMAL_NAV.map((entry) => [entry.id, entry]));
  return ['projects']
    .map((id) => byId.get(id))
    .filter((entry): entry is NavEntry => entry !== undefined);
}

/** Standalone research destinations promoted into the visible top bar. */
export function getPrimaryResearchNav(): NavEntry[] {
  return [
    // 选题(2026-09-04 刘总要求):一级目的地,先于成果/投稿(科研链条起点)。
    { id: 'topics', labelKey: 'nav.topics', descriptionKey: 'nav.topicsDesc', isTopLevel: true },
    { id: 'outcomes', labelKey: 'nav.outcomes', descriptionKey: 'nav.outcomesDesc', isTopLevel: true },
    { id: 'submissions', labelKey: 'nav.submissions', descriptionKey: 'nav.submissionsDesc', isTopLevel: true },
  ];
}

/**
 * Preference destinations shown beside the top-level entries. Scenarios is a
 * toggle entry (opens the scenario center) rather than a persisted app entry,
 * so App owns its click behavior while the label/ID live here with the rest
 * of the navigation configuration.
 */
export function getPreferenceNav(): NavEntry[] {
  return [{ id: 'personalization', labelKey: 'personalization.title', descriptionKey: 'nav.personalizationDesc', isTopLevel: true }];
}

/** Whether a given nav id is a technical (hidden-by-default) entry. */
export function isTechnicalNavEntry(id: string): boolean {
  return DIAGNOSTIC_NAV.some((e) => e.id === id);
}
