import { useState, useEffect, useRef, Suspense, lazy } from 'react'
import { LayoutGrid, Settings, Search, Command, HelpCircle, Monitor, Moon, Sun } from 'lucide-react'
import './App.css'
import ChatPage from './pages/ChatPage'
import { useTranslation } from './i18n'
import type { Page, TopLevelEntry, ThemeMode, AccentSetting } from './store'
import { useMetisStore, applyCustomAccent, isCustomAccent } from './store'
import GlobalSearch from './components/GlobalSearch'
import JobsIndicator from './components/JobsIndicator'
import ToastHost from './components/ToastHost'
import ShortcutsHelp from './components/ShortcutsHelp'
import ErrorBoundary from './components/ErrorBoundary'
import type { WorkspaceMode } from './shell/ProjectShell'
import { getPreferenceNav, getPrimaryResearchNav, getPrimaryWorkspaceNav, getTopLevelNav } from './shell/navConfig'
import { decodeNavigationIntent, LEGACY_PAGE_ALIASES, NAVIGATE_EVENT, navigate, type NavigationIntent } from './shell/navigation'
import CommandBar, { type CommandItem, type CommandGroup } from './shell/CommandBar'
import { getDiagnosticMode, setDiagnosticMode, type UIMode } from '../engine/capabilities/DiagnosticMode'
import {
  useResearchWorkspaceStore,
  researchWorkspaceStore,
  type ResearchWorkspaceSection,
} from './research/researchWorkspaceStore'
import { setPendingChatIntent } from './lib/chatIntent'
import { confirmLeaveScenario } from './lib/scenarioDirtyGuard'
import type { ProjectViewMode } from './pages/ProjectsPage'

// ─── Lazyloaded pages to reduce initial bundle size ───

const DashboardPage = lazy(() => import('./pages/DashboardPage'));
const ProjectShell = lazy(() => import('./shell/ProjectShell'));
const NotesPage = lazy(() => import('./pages/NotesPage'));
const ProjectsPage = lazy(() => import('./pages/ProjectsPage'));
const ExperimentsPage = lazy(() => import('./pages/ExperimentsPage'));
const ResearchTimelinePage = lazy(() => import('./pages/ResearchTimelinePage'));
const LatexPreviewPage = lazy(() => import('./pages/LatexPreviewPage'));
const TaskBoardPage = lazy(() => import('./pages/TaskBoardPage'));
const OutcomesPage = lazy(() => import('./pages/OutcomesPage'));
const SubmissionsPage = lazy(() => import('./pages/SubmissionWorkspacePage'));
const ScenarioApprovalToast = lazy(() => import('./components/ScenarioApprovalToast'));

/**
 * 全局审批互斥：页内审批（场景步骤）一打开，就必须隐藏原生嵌入视图，
 * 否则第三方 webview 会盖在审批弹窗之上；关闭后恢复。
 */
function ApprovalToastGate() {
  useEffect(() => {
    const metis = window.metis;
    if (!metis?.onScenarioApprovalRequired) return;
    const dispose = metis.onScenarioApprovalRequired(() => {
      void metis.collabHide?.();
      void metis.browserHide?.();
    });
    return dispose;
  }, []);
  return <ScenarioApprovalToast />;
}
const GoalPage = lazy(() => import('./pages/GoalPage'));
const ProjectWorkspaceSidebar = lazy(() => import('./research/ProjectWorkspaceSidebar'));
const ResearchInspectorPanels = lazy(() => import('./research/ResearchInspectorPanels'));
const ResearchExportCenter = lazy(() => import('./export/ResearchExportCenter'));
const ScenarioLauncher = lazy(() => import('./research/ScenarioLauncher'));
const PersonalizationCenter = lazy(() => import('./personalization/PersonalizationCenter'));
const TopicWorkspacePage = lazy(() => import('./pages/TopicWorkspacePage'));
import SettingsPanel from './components/SettingsPanel';

// ─── Theme Toggle Component ───

const THEME_CYCLE: ThemeMode[] = ['light', 'dark', 'system'];

function ThemeToggle() {
  const { t } = useTranslation();
  const theme = useMetisStore((s) => s.theme)
  const setTheme = useMetisStore((s) => s.setTheme)

  const nextTheme = THEME_CYCLE[(THEME_CYCLE.indexOf(theme || 'light') + 1) % THEME_CYCLE.length]!;
  const label = theme === 'system' ? t('common.themeSystem') : theme === 'dark' ? t('common.dark') : t('common.light');
  const icon = theme === 'system' ? (
    <Monitor size={14} aria-hidden="true" />
  ) : theme === 'dark' ? (
    <Moon size={14} aria-hidden="true" />
  ) : (
    <Sun size={14} aria-hidden="true" />
  );

  return (
    <button
      className="theme-toggle"
      onClick={() => setTheme(nextTheme)}
      title={label}
    >
      {icon}
      <span>{label}</span>
    </button>
  )
}

// ─── Navigation ───

interface NavItem { id: TopLevelEntry; labelKey: string; descriptionKey?: string; icon: React.ReactNode }

const dashboardIcon = <LayoutGrid size={16} strokeWidth={1.5} />;
const settingsIcon = <Settings size={16} strokeWidth={1.5} />;

const TOP_LEVEL_ICONS: Record<TopLevelEntry, React.ReactNode> = {
  projects: dashboardIcon,
  settings: settingsIcon,
};

const NAV_ITEMS: NavItem[] = getTopLevelNav().map((entry) => ({
  id: entry.id as TopLevelEntry,
  labelKey: entry.labelKey,
  descriptionKey: entry.descriptionKey,
  icon: TOP_LEVEL_ICONS[entry.id as TopLevelEntry],
}));

const WORKSPACE_NAV_ITEMS = getPrimaryWorkspaceNav();
const RESEARCH_NAV_ITEMS = getPrimaryResearchNav();
const PREFERENCE_NAV_ITEMS = getPreferenceNav();

function legacyPageToEntry(page: Page): { entry: TopLevelEntry; mode: WorkspaceMode } {
  switch (page) {
    case 'settings':
      return { entry: 'settings', mode: 'projects' };
    case 'kanban':
    case 'outcomes':
    case 'timeline':
    case 'experiments':
      return { entry: 'projects', mode: 'projects' };
    case 'latex':
    case 'notes':
      return { entry: 'projects', mode: 'write' };
    default:
      return { entry: 'projects', mode: 'projects' };
  }
}

// ─── Evals Page ───

type StandalonePage = 'dashboard' | 'goal' | 'timeline' | 'latex' | 'experiments' | 'evals' | 'kanban' | 'outcomes' | 'submissions' | 'topics';

function resolveStandalonePage(page: Page, diagnosticMode: boolean): StandalonePage | null {
  switch (page) {
    case 'dashboard':
    case 'goal':
    case 'timeline':
    case 'latex':
    case 'experiments':
    case 'kanban':
      return page;
    // 旧 'autonomous' 深链已在 LEGACY_PAGE_ALIASES 统一迁移为 outcomes，
    // 这里不再出现已移除的自主研究产品面。Goals/workflows remain in the
    // project runtime; the user-facing destination is Outcomes.
    case 'outcomes':
      return 'outcomes';
    case 'submissions':
      return 'submissions';
    case 'topics':
      return 'topics';
    case 'evals':
      return diagnosticMode ? page : null;
    default:
      return null;
  }
}

function EvalsPage() {
  const { t } = useTranslation();
  const [isRunning, setIsRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [profile, setProfile] = useState<'dev' | 'candidate' | 'release'>('dev')
  const [suiteResult, setSuiteResult] = useState<{
    summary?: { taskCount: number; passed: number; failed: number; successRate: number };
    gate?: { passed: boolean; profile: string; failures: string[]; failedTasks: string[] };
    results?: Array<{
      taskId: string;
      success: boolean;
      status: string;
      turnsUsed: number;
      toolCalls: number;
      latencyMs: number;
      toolFailures: number;
      qualityFailures: number;
      errors: string[];
    }>;
  } | null>(null)
  const [lastRun, setLastRun] = useState<string | null>(null)

  const handleRunSuite = async () => {
    if (isRunning) return
    setIsRunning(true)
    setError(null)

    try {
      const metis = window.metis
      if (!metis || !metis.runEvalSuite) {
        throw new Error('Eval API not available')
      }
      const response = await metis.runEvalSuite(profile)
      if (response.status === 'error' || response.status === 'cancelled') {
        throw new Error(response.code || 'Eval failed')
      }
      setSuiteResult({
        summary: response.summary,
        gate: { passed: response.gate.passed, profile: response.gate.profile, failures: response.gate.failedTaskIds, failedTasks: response.gate.failedTaskIds },
        results: response.results.map((r) => ({ ...r, errors: [] as string[] })),
      })
      setLastRun(new Date().toLocaleString())
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(msg)
    } finally {
      setIsRunning(false)
    }
  }

  return (
    <div className="placeholder-page">
      <h2>{t('evals.pageTitle')}</h2>
      <p>{t('evals.pageDescription')}</p>

      <div className="action-bar" style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <select
          className="select-field"
          value={profile}
          onChange={(e) => setProfile(e.target.value as 'dev' | 'candidate' | 'release')}
          disabled={isRunning}
          style={{ padding: '6px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-card)', color: 'var(--text-primary)' }}
        >
          <option value="dev">{t('evals.profileDev')}</option>
          <option value="candidate">{t('evals.profileCandidate')}</option>
          <option value="release">{t('evals.profileRelease')}</option>
        </select>
        <button className="btn-primary" onClick={handleRunSuite} disabled={isRunning}>
          {isRunning ? t('evals.running') : t('evals.runSuite')}
        </button>
        {lastRun && (
          <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
            {t('evals.lastRun', { time: lastRun })}
          </span>
        )}
      </div>

      {error && (
        <div style={{ marginTop: 16, padding: 12, borderRadius: 6, background: 'var(--status-failed-bg)', color: 'var(--status-failed)', border: '1px solid var(--status-failed)' }}>
          {error}
        </div>
      )}

      {suiteResult && suiteResult.summary && (
        <div style={{ marginTop: 20 }}>
          <h3 style={{ marginBottom: 8 }}>{t('evals.summaryTitle')}</h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12, marginBottom: 16 }}>
            <div className="stat-card" style={{ padding: 12, borderRadius: 8, background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{t('evals.summaryTasks', { count: suiteResult.summary.taskCount })}</div>
            </div>
            <div className="stat-card" style={{ padding: 12, borderRadius: 8, background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
              <div style={{ fontSize: 12, color: 'var(--status-completed)' }}>{t('evals.summaryPassed', { count: suiteResult.summary.passed })}</div>
            </div>
            <div className="stat-card" style={{ padding: 12, borderRadius: 8, background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
              <div style={{ fontSize: 12, color: 'var(--status-failed)' }}>{t('evals.summaryFailed', { count: suiteResult.summary.failed })}</div>
            </div>
            <div className="stat-card" style={{ padding: 12, borderRadius: 8, background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
              <div style={{ fontSize: 12, color: 'var(--text-primary)' }}>{t('evals.summaryRate', { rate: suiteResult.summary.successRate.toFixed(1) })}</div>
            </div>
          </div>

          {suiteResult.gate && (
            <div
              style={{
                marginBottom: 16,
                padding: 12,
                borderRadius: 6,
                background: suiteResult.gate.passed ? 'var(--status-completed-bg)' : 'var(--status-failed-bg)',
                color: suiteResult.gate.passed ? 'var(--status-completed)' : 'var(--status-failed)',
                border: `1px solid ${suiteResult.gate.passed ? 'var(--status-completed)' : 'var(--status-failed)'}`,
              }}
            >
              <strong>{suiteResult.gate.passed ? t('evals.gatePassed') : t('evals.gateFailed')}</strong>
              <span style={{ marginLeft: 12, fontSize: 13 }}>
                {t('evals.gateProfile', { profile: suiteResult.gate.profile })}
              </span>
              {suiteResult.gate.failures.length > 0 && (
                <div style={{ marginTop: 6, fontSize: 12 }}>
                  {t('evals.gateFailures')}: {suiteResult.gate.failures.join(', ')}
                </div>
              )}
            </div>
          )}

          {suiteResult.results && suiteResult.results.length > 0 && (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={{ textAlign: 'left', padding: 8, borderBottom: '2px solid var(--border)', fontSize: 13 }}>{t('evals.taskId')}</th>
                  <th style={{ textAlign: 'left', padding: 8, borderBottom: '2px solid var(--border)', fontSize: 13 }}>{t('evals.taskStatus')}</th>
                  <th style={{ textAlign: 'left', padding: 8, borderBottom: '2px solid var(--border)', fontSize: 13 }}>{t('evals.taskTurns')}</th>
                  <th style={{ textAlign: 'left', padding: 8, borderBottom: '2px solid var(--border)', fontSize: 13 }}>{t('evals.taskTools')}</th>
                  <th style={{ textAlign: 'left', padding: 8, borderBottom: '2px solid var(--border)', fontSize: 13 }}>{t('evals.taskLatency')}</th>
                  <th style={{ textAlign: 'left', padding: 8, borderBottom: '2px solid var(--border)', fontSize: 13 }}>{t('evals.taskErrors')}</th>
                </tr>
              </thead>
              <tbody>
                {suiteResult.results.map((r) => (
                  <tr key={r.taskId}>
                    <td style={{ padding: 8, borderBottom: '1px solid var(--border)', fontSize: 13 }}>{r.taskId}</td>
                    <td style={{ padding: 8, borderBottom: '1px solid var(--border)', fontSize: 13, color: r.success ? 'var(--status-completed)' : 'var(--status-failed)' }}>
                      {r.success ? t('evals.statusPass') : t('evals.statusFail')}
                    </td>
                    <td style={{ padding: 8, borderBottom: '1px solid var(--border)', fontSize: 13 }}>{r.turnsUsed}</td>
                    <td style={{ padding: 8, borderBottom: '1px solid var(--border)', fontSize: 13 }}>{r.toolCalls}</td>
                    <td style={{ padding: 8, borderBottom: '1px solid var(--border)', fontSize: 13 }}>{r.latencyMs}ms</td>
                    <td style={{ padding: 8, borderBottom: '1px solid var(--border)', fontSize: 13, color: r.errors.length > 0 ? 'var(--status-failed)' : 'inherit' }}>
                      {r.errors.length > 0 ? r.errors.join('; ') : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {!suiteResult && !isRunning && !error && (
        <div style={{ marginTop: 24, padding: 24, textAlign: 'center', color: 'var(--text-secondary)', fontSize: 14 }}>
          {t('evals.noResults')}
        </div>
      )}
    </div>
  )
}

/**
 * METIS-OPT-4: the main process now shows the window before heavy startup
 * initialization finishes. Wait (with a 15s cap) for the startup signal so
 * settings/config checks and data hydration never see a half-initialized
 * main process.
 */
async function waitForStartup(metis: { startupStatus?: () => Promise<{ ready: boolean }> }): Promise<void> {
  if (!metis.startupStatus) return;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const status = await metis.startupStatus();
      if (status?.ready) return;
    } catch {
      /* transient — keep polling */
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

// ─── Session restore (navigation + last active project) ────────
// The last workspace location is remembered in localStorage so a restart
// lands where the user left off. Project restore is best-effort: it only
// wins when the project still exists (loadProjects re-validates it).

const SESSION_STORAGE_KEY = 'metis-session';
const VALID_SESSION_ENTRIES: ReadonlySet<string> = new Set(['projects', 'settings']);
const VALID_SESSION_MODES: ReadonlySet<string> = new Set(['converse', 'write', 'projects']);

interface SavedSession {
  entry: TopLevelEntry;
  mode: WorkspaceMode;
  projectId: string | null;
}

function readSavedSession(): SavedSession | null {
  try {
    const raw = localStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { entry, mode, projectId } = parsed as { entry?: unknown; mode?: unknown; projectId?: unknown };
    // 旧版本存在过 'browser'（浏览器页）与 'library'（独立文献库）入口；
    // 两者都已并入科研项目工作台，统一迁移到 'projects'。
    const normalizedEntry = entry === 'browser' || entry === 'library' ? 'projects' : entry;
    if (typeof normalizedEntry !== 'string' || !VALID_SESSION_ENTRIES.has(normalizedEntry)) return null;
    if (typeof mode !== 'string' || !VALID_SESSION_MODES.has(mode)) return null;
    return {
      entry: normalizedEntry as TopLevelEntry,
      mode: mode as WorkspaceMode,
      projectId: typeof projectId === 'string' ? projectId : null,
    };
  } catch {
    return null;
  }
}

function saveSession(entry: TopLevelEntry, mode: WorkspaceMode, projectId: string | null): void {
  try {
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ entry, mode, projectId }));
  } catch {
    // Session persistence is best-effort; navigation still works without it.
  }
}

function App({ initialPage = 'projects' as Page }: { initialPage?: Page } = {}) {
  const { t, locale } = useTranslation();
  const initialLocation = legacyPageToEntry(initialPage);
  const [currentEntry, setCurrentEntry] = useState<TopLevelEntry>(initialLocation.entry)
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>(initialLocation.mode)
  const [uiMode, setUIMode] = useState<UIMode>(() => getDiagnosticMode())
  const [standalonePage, setStandalonePage] = useState<StandalonePage | null>(() =>
    resolveStandalonePage(initialPage, getDiagnosticMode() === 'diagnostic'))
  const [projectLeftCollapsed, setProjectLeftCollapsed] = useState(false)
  const [projectRightCollapsed, setProjectRightCollapsed] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [commandBarOpen, setCommandBarOpen] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [personalizationOpen, setPersonalizationOpen] = useState(false);
  const [chatIntentRevision, setChatIntentRevision] = useState(0)
  // 科研项目工作台内的模式页签（聊天/任务看板/研究成果）。
  const [projectViewMode, setProjectViewMode] = useState<ProjectViewMode>('chat')
  const [setupState, setSetupState] = useState<'checking' | 'ready'>('checking')
  // Page-owned dialogs can be opened by IPC rather than an App state flag.
  // Keep the known App overlay state in a ref so the modal observer below can
  // restore native views only when both layers are clear.
  const appOwnedOverlayOpenRef = useRef(false)
  const isHydrated = useMetisStore((s) => s.isHydrated)
  const hydrateFromPersistence = useMetisStore((s) => s.hydrateFromPersistence)
  const activeResearchProjectId = useResearchWorkspaceStore((state) => state.activeProjectId)
  const activeResearchSection = useResearchWorkspaceStore((state) => state.activeSection)

  // Restore the last navigation location once, before any child mounts. The
  // project id is seeded into the workspace store; loadProjects keeps it only
  // when the project still exists.
  const sessionRestoredRef = useRef(false)
  useEffect(() => {
    if (sessionRestoredRef.current) return
    const saved = readSavedSession()
    if (!saved) return
    sessionRestoredRef.current = true
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot session restore on launch
    setCurrentEntry(saved.entry)
    // 协同对话一级工作区已取消（2026-09-05）：历史会话里的 converse 归入 projects。
    setWorkspaceMode(saved.mode === 'converse' ? 'projects' : saved.mode)
    setStandalonePage(null)
    if (saved.projectId) {
      researchWorkspaceStore.setState({ activeProjectId: saved.projectId })
    }
  }, [])

  // Persist the navigation location (skipping the initial render so a stale
  // saved session is not overwritten before the restore effect above lands).
  const sessionSaveSkippedRef = useRef(false)
  useEffect(() => {
    if (!sessionSaveSkippedRef.current) {
      sessionSaveSkippedRef.current = true
      return
    }
    saveSession(currentEntry, workspaceMode, activeResearchProjectId)
  }, [currentEntry, workspaceMode, activeResearchProjectId])

  useEffect(() => {
    const metis = window.metis
    if (!metis?.getSettings) {
  // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional initialization
      setSetupState('ready')
      return
    }
    // METIS-OPT-4: wait for the main process to finish startup (the window now
    // appears before heavy initialization completes). Poll with a timeout so a
    // stuck main process degrades to the previous behavior instead of hanging.
    // 首次启动不再拦截进入 API 配置向导：应用永远直接进入可用状态，
    // Provider 可在「设置」里随时配置。
    let cancelled = false
    void waitForStartup(metis).then(() => {
      if (cancelled) return
      return metis.getSettings!().then(() => {
        setSetupState('ready')
      }).catch(() => {
        setSetupState('ready')
      })
    }).catch(() => {
      setSetupState('ready')
    })
    return () => { cancelled = true }
  }, [])

  // Hydrate from SQLite on mount
  useEffect(() => {
    const metis = window.metis
    if (metis && metis.loadAllData) {
      void waitForStartup(metis).then(() => metis.loadAllData!()).then((data) => {
        hydrateFromPersistence({
          papers: data.papers ?? [],
          notes: data.notes ?? [],
          experiments: data.experiments ?? [],
          collections: data.collections ?? [],
        })
        // Restore theme and reading goal from settings
        if (metis.getSettings) {
          metis.getSettings().then((settings) => {
            if (settings?.theme) {
              useMetisStore.getState().setTheme(settings.theme as ThemeMode)
            }
            if (settings?.accent) {
              useMetisStore.getState().setAccent(settings.accent as AccentSetting)
            }
          }).catch(() => {})
        }
      }).catch((err: unknown) => {
        console.error('Failed to hydrate from persistence:', err)
        hydrateFromPersistence({ papers: [], notes: [], experiments: [] })
      })
      // Listen for OS theme changes when in 'system' mode
      const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
      if (mq) {
        const handler = () => {
          if (useMetisStore.getState().theme === 'system') {
            const resolved = mq.matches ? 'dark' : 'light';
            document.documentElement.dataset.theme = resolved;
            // Re-derive a custom accent for the newly resolved mode.
            const accent = useMetisStore.getState().accent;
            if (isCustomAccent(accent)) applyCustomAccent(accent, resolved);
          }
        };
        mq.addEventListener('change', handler);
        return () => { mq.removeEventListener('change', handler); };
      }
    } else {
      // Not in Electron 鈥?mark as hydrated immediately without wiping in-memory state
      useMetisStore.setState({ isHydrated: true })
    }
  }, [hydrateFromPersistence])

  // Global search keyboard shortcut (Cmd/Ctrl+K) and slash-command bus.
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
        // O1: Ctrl/Cmd+Shift+P opens the command palette; plain Ctrl/Cmd+K stays as search.
        if (e.shiftKey) {
          if (document.querySelector('[aria-modal="true"]')) return
          e.preventDefault()
          setCommandBarOpen((open) => !open)
          return
        }
        if (document.querySelector('[aria-modal="true"]')) return
        e.preventDefault()
        setSearchOpen((open) => !open)
      }
      if (e.key.toLowerCase() === 'p' && e.shiftKey && (e.metaKey || e.ctrlKey)) {
        if (document.querySelector('[aria-modal="true"]')) return
        e.preventDefault()
        setCommandBarOpen((open) => !open)
      }
    }
    function handleOpenSearch() {
      setSearchOpen(true);
    }
    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('metis:open-search', handleOpenSearch)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('metis:open-search', handleOpenSearch)
    }
  }, [])

  // Board ↔ chat goal handoff. The navigation functions are recreated every
  // render, so latest versions are tracked through refs updated in an effect;
  // the listeners below are bound once and always call the current version.
  const navigateLegacyRef = useRef(navigateLegacy);
  const navigateWorkspaceModeRef = useRef(navigateWorkspaceMode);
  useEffect(() => {
    navigateLegacyRef.current = navigateLegacy;
    navigateWorkspaceModeRef.current = navigateWorkspaceMode;
    applyNavigationIntentRef.current = applyNavigationIntent;
  });

  /**
   * 任务4 typed navigation contract：唯一的导航状态应用入口。
   * 新代码用 `navigate(intent)`（shell/navigation.ts）发起；
   * 旧 `metis:*` 事件由下方兼容层翻译成同一 intent 后也走这里。
   */
  function applyNavigationIntent(intent: NavigationIntent) {
    switch (intent.kind) {
      case 'workspace':
        leavePersonalizationGuard(() => {
          setPersonalizationOpen(false);
          setCurrentEntry('projects');
          setStandalonePage(null);
          if (intent.tab) {
            setWorkspaceMode('projects');
            setProjectViewMode(intent.tab);
          }
        });
        break;
      case 'settings':
        leavePersonalizationGuard(() => {
          setPersonalizationOpen(false);
          setStandalonePage(null);
          setCurrentEntry('settings');
        });
        break;
      case 'personalization':
        leavePersonalizationGuard(() => {
          setStandalonePage(null);
          setPersonalizationOpen(true);
        });
        break;
      case 'standalone':
      case 'diagnostic':
        navigateLegacyRef.current(intent.page);
        break;
      case 'paper': {
        if (intent.paperId) useMetisStore.setState({ selectedPaperId: intent.paperId });
        if (typeof intent.page === 'number') useMetisStore.setState({ pendingPaperPage: intent.page });
        navigateLegacyRef.current('pdf');
        break;
      }
      case 'project': {
        const workspace = researchWorkspaceStore.getState();
        void workspace.setActiveProject(intent.projectId).then(() => {
          const validSections = new Set<ResearchWorkspaceSection>([
            'project', 'sources', 'evidence', 'note_codes', 'claims',
            'artifacts', 'runs', 'goals', 'recycle_bin',
          ]);
          const section = intent.section as ResearchWorkspaceSection | undefined;
          if (section && validSections.has(section)) {
            researchWorkspaceStore.getState().setActiveSection(section);
          }
        });
        navigateWorkspaceModeRef.current('projects');
        break;
      }
      case 'goal': {
        const goalId = intent.goalId;
        try { window.sessionStorage.setItem('metis-pending-goal', goalId); } catch { /* session storage unavailable */ }
        // 任务卡片的“在对话中继续”回到当前科研项目的对话（2026-08-29 刘总要求）。
        if (researchWorkspaceStore.getState().activeProjectId) {
          leavePersonalizationGuard(() => {
            setPersonalizationOpen(false);
            setCurrentEntry('projects');
            setStandalonePage(null);
            setWorkspaceMode('projects');
            setProjectViewMode('chat');
          });
        } else {
          setWorkspaceMode('projects');
          setProjectViewMode('chat');
        }
        // ChatPage may already be mounted; if not, its mount effect consumes
        // the sessionStorage fallback.
        window.dispatchEvent(new CustomEvent('metis:goal-focus', { detail: { goalId } }));
        break;
      }
      case 'kanban': {
        if (intent.goalId) {
          try { window.sessionStorage.setItem('metis-pending-goal-focus', intent.goalId); } catch { /* session storage unavailable */ }
        }
        navigateLegacyRef.current('kanban');
        break;
      }
      case 'search':
        setSearchOpen(true);
        break;
      case 'shortcuts':
        setShortcutsOpen(true);
        break;
      case 'external-url':
        void window.metis?.openExternal?.(intent.url);
        break;
    }
  }
  const applyNavigationIntentRef = useRef(applyNavigationIntent);

  // Typed navigation bus（任务4）：`navigate(intent)` 的唯一入口。
  useEffect(() => {
    function handleNavigateIntent(event: Event) {
      const intent = decodeNavigationIntent((event as CustomEvent).detail);
      if (!intent) {
        // 未知的导航载荷：拒绝应用（fail-closed），但留下诊断日志而非静默。
        console.warn('[navigation] rejected invalid navigation intent payload');
        return;
      }
      applyNavigationIntentRef.current(intent);
    }
    window.addEventListener(NAVIGATE_EVENT, handleNavigateIntent);
    return () => window.removeEventListener(NAVIGATE_EVENT, handleNavigateIntent);
  }, []);

  useEffect(() => {
    function handleOpenGoal(event: Event) {
      const goalId = (event as CustomEvent<{ goalId?: string }>).detail?.goalId;
      if (!goalId) return;
      // 兼容层：旧 metis:open-goal → typed intent（任务4，行为不变）。
      applyNavigationIntentRef.current({ kind: 'goal', goalId });
    }
    function handleOpenKanban(event: Event) {
      const goalId = (event as CustomEvent<{ goalId?: string }>).detail?.goalId;
      // 兼容层：旧 metis:open-kanban → typed intent（任务4，行为不变）。
      applyNavigationIntentRef.current({ kind: 'kanban', ...(goalId ? { goalId } : {}) });
    }
    function handleOpenProject(event: Event) {
      const detail = (event as CustomEvent<{ projectId?: string; section?: string }>).detail;
      const projectId = detail?.projectId;
      if (!projectId) return;
      // 兼容层：旧 metis:open-project → typed intent（任务4，行为不变）。
      applyNavigationIntentRef.current({ kind: 'project', projectId, ...(detail?.section ? { section: detail.section } : {}) });
    }
    function handleOpenPaper(event: Event) {
      const detail = (event as CustomEvent<{ paperId?: string; page?: number }>).detail;
      if (!detail?.paperId) return;
      // 兼容层：旧 metis:open-paper → typed intent（任务4，行为不变）。
      applyNavigationIntentRef.current({ kind: 'paper', paperId: detail.paperId, ...(typeof detail.page === 'number' ? { page: detail.page } : {}) });
    }
    function handleOpenMcpInstaller() {
      setPersonalizationOpen(true);
      setStandalonePage(null);
    }
    function handleNavigateProjects() {
      navigateWorkspaceModeRef.current('projects');
    }
    window.addEventListener('metis:open-goal', handleOpenGoal);
    window.addEventListener('metis:open-kanban', handleOpenKanban);
    window.addEventListener('metis:open-project', handleOpenProject);
    window.addEventListener('metis:open-paper', handleOpenPaper);
    window.addEventListener('metis:navigate-projects', handleNavigateProjects);
  // 选题 → 场景 handoff:从选题页一键打开场景中心(场景工作台自行消费 pendingScenarioHandoff)。
  const handleOpenPersonalization = () => {
    leavePersonalizationGuard(() => {
      setStandalonePage(null);
      setPersonalizationOpen(true);
    });
  };
  window.addEventListener('metis:open-personalization', handleOpenPersonalization);
    function handleOpenBrowserUrl(event: Event) {
      // 浏览器页已移除：外链统一走系统浏览器。
      const url = (event as CustomEvent<{ url?: string }>).detail?.url;
      if (!url) return;
      void window.metis?.openExternal?.(url);
    }
    function handleOpenExternalUrl(event: Event) {
      const url = (event as CustomEvent<{ url?: string }>).detail?.url;
      if (!url) return;
      void window.metis?.openExternal?.(url);
    }
    window.addEventListener('metis:open-browser-url', handleOpenBrowserUrl);
    window.addEventListener('metis:open-external-url', handleOpenExternalUrl);
    window.addEventListener('metis:open-mcp-installer', handleOpenMcpInstaller);
    return () => {
      window.removeEventListener('metis:open-goal', handleOpenGoal);
      window.removeEventListener('metis:open-kanban', handleOpenKanban);
      window.removeEventListener('metis:open-project', handleOpenProject);
      window.removeEventListener('metis:open-paper', handleOpenPaper);
      window.removeEventListener('metis:navigate-projects', handleNavigateProjects);
      window.removeEventListener('metis:open-personalization', handleOpenPersonalization);
      window.removeEventListener('metis:open-browser-url', handleOpenBrowserUrl);
      window.removeEventListener('metis:open-external-url', handleOpenExternalUrl);
      window.removeEventListener('metis:open-mcp-installer', handleOpenMcpInstaller);
    };
  }, [])

  // Shortcuts help (Shift+/)
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === '?' && e.shiftKey) {
        if (document.querySelector('[aria-modal="true"]')) return
        const target = e.target as HTMLElement | null
        if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
          return
        }
        e.preventDefault()
        setShortcutsOpen(true)
      }
      if (e.key === 'Escape' && shortcutsOpen) {
        setShortcutsOpen(false)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [shortcutsOpen])

  function updateUIMode(mode: UIMode) {
    setDiagnosticMode(mode);
    setUIMode(mode);
  }

  // 场景未保存守卫（2026-08-23 刘总要求）：任何离开场景工作台的导航
  // 都必须先通过确认；用户取消则中止本次导航。
  function leavePersonalizationGuard(action: () => void) {
    if (confirmLeaveScenario(action)) action();
  }

  function navigateLegacy(page: Page) {
    // 任务4：旧 Page id 的兼容别名（autonomous/chat/kanban/pdf）收敛到
    // navigation.ts 的 LEGACY_PAGE_ALIASES，不再散落各自的迁移分支。
    const aliased = LEGACY_PAGE_ALIASES[page];
    if (aliased) {
      applyNavigationIntent(aliased);
      return;
    }
    const location = legacyPageToEntry(page);
    leavePersonalizationGuard(() => {
      setPersonalizationOpen(false);
      setCurrentEntry(location.entry);
      setWorkspaceMode(location.mode);
      setStandalonePage(resolveStandalonePage(page, uiMode === 'diagnostic'));
    });
  }

  function navigateWorkspaceMode(mode: WorkspaceMode) {
    leavePersonalizationGuard(() => {
      setPersonalizationOpen(false);
      setCurrentEntry('projects');
      setStandalonePage(null);
      setWorkspaceMode(mode);
    });
  }

  function activatePersonalizationScenario(scenarioId: string) {
    setPendingChatIntent({
      scenarioId,
      projectId: activeResearchProjectId ?? 'global',
      message: '',
      autoSend: false,
    });
    setChatIntentRevision((revision) => revision + 1);
    // 使用场景后必须离开个人化中心，回到科研项目聊天工作区。
    setPersonalizationOpen(false);
    setStandalonePage(null);
    setCurrentEntry('projects');
    setWorkspaceMode('projects');
    setProjectViewMode('chat');
  }

  function projectShellStateProps() {
    return {
      leftCollapsed: projectLeftCollapsed,
      rightCollapsed: projectRightCollapsed,
      onLeftCollapsedChange: setProjectLeftCollapsed,
      onRightCollapsedChange: setProjectRightCollapsed,
    };
  }

  function renderNonChatWorkspace() {
    switch (workspaceMode) {
      case 'write': return <NotesPage uiMode={uiMode} onNavigate={(page) => navigateLegacy(page as Page)} />;
    }
  }

  function renderStandalonePage() {
    switch (standalonePage) {
      case 'dashboard': return <DashboardPage onNavigate={navigateLegacy} />;
      case 'goal': return <GoalPage onNavigate={(page) => navigateLegacy(page as Page)} />;
      case 'timeline': return <ResearchTimelinePage />;
      case 'latex': return <LatexPreviewPage />;
      case 'experiments': return <ExperimentsPage />;
      case 'kanban': return <TaskBoardPage />;
      case 'outcomes': return <OutcomesPage onNavigateToSubmissions={() => navigateLegacy('submissions')} />;
      case 'submissions': return <SubmissionsPage />;
      case 'topics': return <TopicWorkspacePage />;
      case 'evals': return uiMode === 'diagnostic' ? <EvalsPage /> : null;
      default: return null;
    }
  }

  function renderPage() {
    if (personalizationOpen) {
      return <PersonalizationCenter onActivateScenario={activatePersonalizationScenario} />;
    }
    const standalone = renderStandalonePage();
    if (standalone) return standalone;
    if (currentEntry === 'settings') {
      return <SettingsPanel uiMode={uiMode} onUIModeChange={updateUIMode} />;
    }

    return (
      <ChatPage
        uiMode={uiMode}
        intentRevision={chatIntentRevision}
        previewMode={workspaceMode === 'projects' ? 'pane' : 'inline'}
        renderLayout={({ leftPanel, workspace, rightPanel, previewPanel }) => {
          // 科研项目工作台：左侧项目列表 + 聊天/任务看板/研究成果三模式。
          // ChatPage 保持常驻挂载，因此切换模式或导航不会丢失对话草稿。
          if (workspaceMode === 'projects') {
            return (
              <ProjectsPage
                mode={projectViewMode}
                onModeChange={setProjectViewMode}
                chatContent={projectViewMode === 'chat' || projectViewMode === 'kanban' ? workspace : null}
                chatRightPanel={projectViewMode === 'chat' || projectViewMode === 'kanban' ? rightPanel : null}
                previewPanel={projectViewMode === 'chat' || projectViewMode === 'kanban' ? previewPanel : null}
              />
            );
          }
          // 协同对话一级工作区已取消（2026-09-05 刘总规格）：第三方 AI 协作
          // 视图迁入选题 Topic Workspace（TopicWorkspacePage 内「打开 Chatbot」）。
          const isConversation = false;
          void leftPanel;
          return (
            <ProjectShell
              {...projectShellStateProps()}
              mode={workspaceMode}
              onModeChange={navigateWorkspaceMode}
              showModeSwitcher={false}
              leftPanel={isConversation ? leftPanel : (
                <div className="research-shell-navigation">
                  <ProjectWorkspaceSidebar />
                </div>
              )}
              rightPanel={isConversation ? rightPanel : undefined}
              inspector={isConversation ? undefined : {
                metis: (
                  <div className="research-shell-inspector-stack">
                    <ResearchInspectorPanels />
                    {activeResearchProjectId && activeResearchSection === 'artifacts' && (
                      <ResearchExportCenter projectId={activeResearchProjectId} />
                    )}
                  </div>
                ),
                plan: (
                  <ScenarioLauncher
                    projectId={activeResearchProjectId ?? undefined}
                    onOpenPersonalization={() => { setPersonalizationOpen(true); setStandalonePage(null); }}
                  />
                ),
                evidence: <ResearchInspectorPanels />,
              }}
              workspaceClassName={isConversation ? 'shell-workspace--chat' : undefined}
            >
              {isConversation ? workspace : renderNonChatWorkspace()}
            </ProjectShell>
          );
        }}
      />
    );
  }

  // 原生嵌入视图（协同对话的第三方 AI、研究浏览器）渲染在 DOM 之上：任何全局
  // 弹层（含场景步骤审批）打开时必须先隐藏它们，否则弹窗与遮罩会被裁切；
  // 关闭后通知各页恢复。
  // WebContentsView is a native child view and always paints above renderer
  // DOM, so every App-owned overlay must participate in the same exclusion rule.
  const appOwnedOverlayOpen = searchOpen
    || commandBarOpen
    || shortcutsOpen
    || personalizationOpen;
  useEffect(() => {
    appOwnedOverlayOpenRef.current = appOwnedOverlayOpen;
    const metis = window.metis;
    if (appOwnedOverlayOpen) {
      void metis?.collabHide?.();
      void metis?.browserHide?.();
    } else {
      window.dispatchEvent(new CustomEvent('metis:restore-embedded-views'));
    }
  }, [appOwnedOverlayOpen]);

  useEffect(() => {
    let observedModalOpen: boolean | undefined;
    const syncRendererModal = () => {
      const next = document.querySelector('[aria-modal="true"]') !== null;
      if (next === observedModalOpen) return;
      observedModalOpen = next;
      if (next) {
        void window.metis?.collabHide?.();
        void window.metis?.browserHide?.();
      } else if (!appOwnedOverlayOpenRef.current) {
        // CollabPage only restores while its host remains mounted, so a page
        // switch while a modal is open cannot resurrect a stale child view.
        window.dispatchEvent(new CustomEvent('metis:restore-embedded-views'));
      }
    };

    syncRendererModal();
    const ModalObserver = window.MutationObserver;
    if (!ModalObserver) return undefined;
    const observer = new ModalObserver(syncRendererModal);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['aria-modal'],
    });
    return () => observer.disconnect();
  }, []);

  // 首次启动不再强制 API 配置：应用直接进入可用状态，
  // Provider 随时可在「设置」中配置或更换。

  // Show loading state while checking setup and hydrating local research data.
  if (setupState === 'checking' || !isHydrated) {
    return (
      <div className="app-layout" data-ui-mode="loading">
        <div className="hydration-loading">
          <div className="hydration-spinner" />
          <p>{t('common.loading') || 'Loading...'}</p>
        </div>
      </div>
    )
  }

  // O1: command palette registry — navigation + research runs + library + search.
  // 任务4：命令面板全部改用 typed navigate(intent)，不再直接操作散落状态。
  const commandItems: CommandItem[] = [
    { id: 'goto-projects', label: t('nav.projects'), description: t('cmdbar.gotoWorkspace'), group: 'nav', onExecute: () => navigate({ kind: 'workspace' }), keywords: ['project', '项目', '科研', '看板'] },
    { id: 'goto-outcomes', label: t('nav.outcomes'), description: t('nav.outcomesDesc'), group: 'nav', onExecute: () => navigate({ kind: 'standalone', page: 'outcomes' }), keywords: ['成果', '论文', 'PPT', '报告'] },
    { id: 'goto-topics', label: t('nav.topics'), description: t('nav.topicsDesc'), group: 'nav', onExecute: () => navigate({ kind: 'standalone', page: 'topics' }), keywords: ['topic', '选题', '研究方向', '题目'] },
    { id: 'goto-submissions', label: t('nav.submissions'), description: t('nav.submissionsDesc'), group: 'nav', onExecute: () => navigate({ kind: 'standalone', page: 'submissions' }), keywords: ['投稿', '期刊', '审稿', 'submission', 'journal'] },
    { id: 'goto-kanban', label: t('nav.kanban'), description: t('cmdbar.gotoResearch'), group: 'nav', onExecute: () => navigate({ kind: 'workspace', tab: 'kanban' }), keywords: ['board', '看板', '任务'] },
    { id: 'goto-materials', label: t('projects.modeMaterials'), description: t('nav.projectsDesc'), group: 'nav', onExecute: () => navigate({ kind: 'workspace', tab: 'materials' }), keywords: ['papers', '文献', '资料', 'library'] },
    { id: 'goto-settings', label: t('nav.settings'), description: t('cmdbar.gotoLibrary'), group: 'nav', onExecute: () => navigate({ kind: 'settings' }), keywords: ['config', '设置', '配置'] },
    { id: 'cmd-search', label: t('cmdbar.openSearch'), description: t('cmdbar.openSearchDesc'), group: 'actions', onExecute: () => setSearchOpen(true), keywords: ['find', '搜索', '全局'] },
    { id: 'cmd-shortcuts', label: t('cmdbar.openShortcuts'), description: t('cmdbar.openShortcutsDesc'), group: 'actions', onExecute: () => setShortcutsOpen(true), keywords: ['help', '快捷键', '帮助'] },
  ];
  const commandGroups: CommandGroup[] = [
    { id: 'nav', label: t('cmdbar.groupNav') },
    { id: 'actions', label: t('cmdbar.groupActions') },
  ];

  return (
    <div className="app-layout" data-ui-mode={uiMode}>
      <ApprovalToastGate />
      <header className="topbar">
        <div className="topbar-brand" aria-label={t('app.title')}>
          <span className="topbar-brand__name">{t('app.title')}</span>
        </div>
        <nav className="topbar-nav" aria-label={t('app.title')}>
          <div className="topbar-nav__group" aria-label={locale === 'zh' ? '研究工作流' : 'Research workflow'}>
            {/* 刘总规格（2026-09）：选题 → 场景 → 研究 → 成果 → 投稿 */}
            {RESEARCH_NAV_ITEMS.filter((item) => item.id === 'topics').map((item) => {
              const active = !personalizationOpen && standalonePage === item.id;
              const tooltip = item.descriptionKey ? (t(item.descriptionKey) || t(item.labelKey)) : t(item.labelKey);
              return (
                <button
                  key={item.id}
                  className={`topbar-nav__item ${active ? 'active' : ''}`}
                  onClick={() => navigateLegacy(item.id as 'outcomes')}
                  aria-current={active ? 'page' : undefined}
                  aria-label={t(item.labelKey)}
                  title={tooltip}
                  data-nav-id={item.id}
                >{t(item.labelKey)}</button>
              );
            })}
            {PREFERENCE_NAV_ITEMS.map((item) => {
              const tooltip = item.descriptionKey ? (t(item.descriptionKey) || t(item.labelKey)) : t(item.labelKey);
              return (
                <button
                  key={item.id}
                  className={`topbar-nav__item ${personalizationOpen ? 'active' : ''}`}
                  onClick={() => { setPersonalizationOpen(true); setStandalonePage(null); }}
                  aria-current={personalizationOpen ? 'page' : undefined}
                  aria-label={t(item.labelKey)}
                  title={tooltip}
                  data-nav-id={item.id}
                  data-testid="personalization-trigger"
                >{t(item.labelKey)}</button>
              );
            })}
            {WORKSPACE_NAV_ITEMS.map((item) => {
              const active = !personalizationOpen && currentEntry === 'projects' && standalonePage === null && workspaceMode === item.id;
              const tooltip = item.descriptionKey ? (t(item.descriptionKey) || t(item.labelKey)) : t(item.labelKey);
              return (
                <button
                  key={item.id}
                  className={`topbar-nav__item ${active ? 'active' : ''}`}
                  onClick={() => navigateWorkspaceMode(item.id as WorkspaceMode)}
                  aria-current={active ? 'page' : undefined}
                  aria-label={t(item.labelKey)}
                  title={tooltip}
                  data-nav-id={item.id}
                >
                  {t(item.labelKey)}
                </button>
              );
            })}
            {RESEARCH_NAV_ITEMS.filter((item) => item.id === 'outcomes' || item.id === 'submissions').map((item) => {
              const active = !personalizationOpen && standalonePage === item.id;
              const tooltip = item.descriptionKey ? (t(item.descriptionKey) || t(item.labelKey)) : t(item.labelKey);
              return (
                <button
                  key={item.id}
                  className={`topbar-nav__item ${active ? 'active' : ''}`}
                  onClick={() => navigateLegacy(item.id as 'outcomes')}
                  aria-current={active ? 'page' : undefined}
                  aria-label={t(item.labelKey)}
                  title={tooltip}
                  data-nav-id={item.id}
                >{t(item.labelKey)}</button>
              );
            })}
          </div>
          <span className="topbar-nav__divider" aria-hidden="true" />
          <div className="topbar-nav__group" aria-label={locale === 'zh' ? '设置' : 'Settings'}>
            {NAV_ITEMS.filter((item) => item.id !== 'projects').map((item) => {
              const active = !personalizationOpen && currentEntry === item.id;
              const tooltip = item.descriptionKey ? (t(item.descriptionKey) || t(item.labelKey)) : t(item.labelKey);
              return (
                <button
                  key={item.id}
                  className={`topbar-nav__item ${active ? 'active' : ''}`}
                  onClick={() => { leavePersonalizationGuard(() => { setPersonalizationOpen(false); setStandalonePage(null); setCurrentEntry(item.id); }); }}
                  aria-current={active ? 'page' : undefined}
                  aria-label={t(item.labelKey)}
                  title={tooltip}
                  data-nav-id={item.id}
                >
                  {t(item.labelKey)}
                </button>
              );
            })}
          </div>
        </nav>
        <div className="topbar-actions">
          <JobsIndicator />
          <ToastHost />
          <button
            className="topbar-icon-button"
            onClick={() => setSearchOpen(true)}
            aria-label={t('globalSearch.placeholder')}
            title={t('globalSearch.placeholder')}
          >
            <Search size={16} aria-hidden="true" />
            <kbd>{/Mac|iPod|iPhone|iPad/.test(navigator.platform) ? '⌘K' : 'Ctrl K'}</kbd>
          </button>
          <ThemeToggle />
          <button
            className="topbar-icon-button"
            onClick={() => setCommandBarOpen(true)}
            aria-label={t('cmdbar.placeholder')}
            title={`${t('cmdbar.placeholder')} (${/Mac|iPod|iPhone|iPad/.test(navigator.platform) ? '⌘⇧P' : 'Ctrl+Shift+P'})`}
            data-testid="topbar-command-palette"
          >
            <Command size={16} aria-hidden="true" />
          </button>
          <button
            className="topbar-icon-button"
            onClick={() => setShortcutsOpen(true)}
            aria-label={t('shortcuts.title')}
            title={t('shortcuts.title')}
          >
            <HelpCircle size={16} aria-hidden="true" />
          </button>
        </div>
      </header>
      <main className={`main-content ${currentEntry === 'projects' && standalonePage === null ? 'main-content--workspace' : ''}`}>
        <ErrorBoundary
          showDetails={uiMode === 'diagnostic'}
          onReset={() => leavePersonalizationGuard(() => { setPersonalizationOpen(false); setCurrentEntry('projects'); setWorkspaceMode('projects'); setStandalonePage(null); })}
        >
          <Suspense fallback={<div className="hydration-loading"><div className="hydration-spinner" /><p>{t('common.loading')}</p></div>}>
            {renderPage()}
          </Suspense>
        </ErrorBoundary>
      </main>
      {searchOpen && (
        <GlobalSearch
          onNavigate={navigateLegacy}
          onClose={() => setSearchOpen(false)}
        />
      )}
      <CommandBar
        isOpen={commandBarOpen}
        onClose={() => setCommandBarOpen(false)}
        commands={commandItems}
        groups={commandGroups}
        placeholder={t('cmdbar.placeholder')}
        enableGlobalShortcut={false}
      />
      {shortcutsOpen && (
        <ShortcutsHelp onClose={() => setShortcutsOpen(false)} />
      )}
    </div>
  )
}

export default App
