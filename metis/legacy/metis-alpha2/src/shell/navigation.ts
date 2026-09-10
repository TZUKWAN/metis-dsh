/**
 * Typed navigation contract (任务4：Navigation Inventory 收敛).
 *
 * 现状问题：导航意图以 16 个 `metis:*` 字符串 CustomEvent 散布在各页面，
 * payload 形状无处声明，新代码继续复制 event string。
 *
 * 目标：所有导航意图收敛为可判别的 `NavigationIntent` 联合类型，
 * 通过单一 `metis:navigate` 总线事件进入 App 的 reducer。
 * 旧的 `metis:*` 事件由 App 内的 compatibility listener 继续受理
 * （内部翻译为同一 intent），存量调用点无需一次性迁移；
 * 新代码一律使用 `navigate(intent)`，不再散落 event string。
 */

/** 科研项目工作台内的模式页签（与 ProjectsPage 的 ProjectViewMode 对齐）。 */
export type ProjectWorkspaceTab = 'chat' | 'kanban' | 'materials';

export type NavigationIntent =
  | { kind: 'workspace'; tab?: ProjectWorkspaceTab }
  | { kind: 'settings' }
  | { kind: 'personalization' }
  /** 顶层独立工作区：topics / outcomes / submissions。 */
  | { kind: 'standalone'; page: 'topics' | 'outcomes' | 'submissions' }
  /** 诊断/深链可达的次级页面（GlobalSearch / 页内跳转）。 */
  | { kind: 'diagnostic'; page: 'dashboard' | 'goal' | 'timeline' | 'latex' | 'experiments' | 'evals' }
  /** 打开某篇论文（可选定位到页码）——落在科研项目「资料」页签。 */
  | { kind: 'paper'; paperId: string; page?: number }
  /** 打开某个科研项目（可选定位到工作区 section）。 */
  | { kind: 'project'; projectId: string; section?: string }
  /** 从任务卡片继续某个目标（落在当前项目对话，可聚焦目标卡）。 */
  | { kind: 'goal'; goalId: string }
  /** 打开任务看板（可选聚焦目标卡）。 */
  | { kind: 'kanban'; goalId?: string }
  /** 打开全局搜索 / 快捷键帮助。 */
  | { kind: 'search' }
  | { kind: 'shortcuts' }
  /** 外部链接：交给系统浏览器，永远不在应用内打开。 */
  | { kind: 'external-url'; url: string };

/** App 层监听的单一导航总线事件名。 */
export const NAVIGATE_EVENT = 'metis:navigate';

/**
 * 旧 `metis:*` 事件 → intent 的兼容别名表（任务4 第九节 Reachability）：
 * - `autonomous` 已退出产品，持久化链接统一迁移到 outcomes；
 * - `chat`/`pdf`/`kanban` 等旧 Page id 映射为工作台模式页签；
 * - `graph`/`artifacts` 从未实现路由，属 dead nav id（已从 GlobalSearch 移除）。
 */
export const LEGACY_PAGE_ALIASES: Readonly<Record<string, NavigationIntent>> = {
  autonomous: { kind: 'standalone', page: 'outcomes' },
  chat: { kind: 'workspace', tab: 'chat' },
  // 任务看板已退出产品（2026-09 刘总规格）：旧 kanban 深链一律落到聊天页签。
  kanban: { kind: 'workspace', tab: 'chat' },
  pdf: { kind: 'workspace', tab: 'materials' },
};

/** 类型收窄用的合法 intent kind 集合（运行时校验用）。 */
const INTENT_KINDS: ReadonlySet<string> = new Set([
  'workspace', 'settings', 'personalization', 'standalone', 'diagnostic',
  'paper', 'project', 'goal', 'kanban', 'search', 'shortcuts', 'external-url',
]);

/**
 * 运行时校验未知来源的 payload（跨进程/持久化数据一律不可信）。
 * 只做 kind 白名单 + 关键字段类型检查，不做深校验。
 */
export function decodeNavigationIntent(input: unknown): NavigationIntent | null {
  if (typeof input !== 'object' || input === null) return null;
  const candidate = input as { kind?: unknown; page?: unknown; url?: unknown; paperId?: unknown; projectId?: unknown; goalId?: unknown; tab?: unknown };
  if (typeof candidate.kind !== 'string' || !INTENT_KINDS.has(candidate.kind)) return null;
  switch (candidate.kind) {
    case 'standalone':
      return candidate.page === 'topics' || candidate.page === 'outcomes' || candidate.page === 'submissions'
        ? { kind: 'standalone', page: candidate.page }
        : null;
    case 'diagnostic':
      return typeof candidate.page === 'string'
        && ['dashboard', 'goal', 'timeline', 'latex', 'experiments', 'evals'].includes(candidate.page)
        ? { kind: 'diagnostic', page: candidate.page as 'dashboard' | 'goal' | 'timeline' | 'latex' | 'experiments' | 'evals' }
        : null;
    case 'paper':
      return typeof candidate.paperId === 'string' && candidate.paperId
        ? { kind: 'paper', paperId: candidate.paperId, ...(typeof (input as { page?: unknown }).page === 'number' ? { page: (input as { page: number }).page } : {}) }
        : null;
    case 'project':
      return typeof candidate.projectId === 'string' && candidate.projectId
        ? { kind: 'project', projectId: candidate.projectId }
        : null;
    case 'goal':
      return typeof candidate.goalId === 'string' && candidate.goalId
        ? { kind: 'goal', goalId: candidate.goalId }
        : null;
    case 'kanban':
      return { kind: 'kanban', ...(typeof candidate.goalId === 'string' && candidate.goalId ? { goalId: candidate.goalId } : {}) };
    case 'workspace':
      return candidate.tab === 'chat' || candidate.tab === 'kanban' || candidate.tab === 'materials'
        ? { kind: 'workspace', tab: candidate.tab }
        : { kind: 'workspace' };
    case 'external-url':
      return typeof candidate.url === 'string' && candidate.url ? { kind: 'external-url', url: candidate.url } : null;
    case 'settings':
      return { kind: 'settings' };
    case 'personalization':
      return { kind: 'personalization' };
    case 'search':
      return { kind: 'search' };
    case 'shortcuts':
      return { kind: 'shortcuts' };
    default:
      return null;
  }
}

/** 发布导航意图。App 挂载后监听 `metis:navigate` 并应用。 */
export function navigate(intent: NavigationIntent): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(NAVIGATE_EVENT, { detail: intent }));
}
