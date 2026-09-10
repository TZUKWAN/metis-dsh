/**
 * TaskBoardPage — kanban board for research goals/tasks.
 *
 * Six columns (Backlog / To do / In progress / In review / Done / Cancelled)
 * mapped from Goal status. Cards show title, priority badge, and age. Drag
 * between columns to change status; click a card for the detail panel.
 */

import { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { useTranslation } from '../i18n';
import { researchWorkspaceStore } from '../research/researchWorkspaceStore';
import { setPendingChatIntent } from '../lib/chatIntent';
import './TaskBoardPage.css';

type GoalStatus = 'draft' | 'planning' | 'ready' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
type Priority = 'low' | 'medium' | 'high' | 'urgent';

interface KanbanGoal {
  id: string;
  description: string;
  status: GoalStatus;
  priority?: Priority;
  createdAt: number;
  projectId?: string;
  /** 场景步骤的专属提示词（2026-08-29 刘总要求：详情面板可查看/编辑）。 */
  prompt?: string;
  /** scenario-run 卡片所属场景定义 id，用于编辑后保存。 */
  scenarioId?: string;
}

// Map Goal status to kanban column.
type ColumnId = 'backlog' | 'todo' | 'inprogress' | 'inreview' | 'done' | 'cancelled';

function statusToColumn(status: GoalStatus): ColumnId {
  switch (status) {
    case 'draft': return 'backlog';
    case 'planning': case 'ready': return 'todo';
    case 'running': return 'inprogress';
    // GoalEngine has no distinct review status. Paused is presented honestly as
    // "waiting", rather than pretending a review column survives reload.
    case 'paused': return 'inreview';
    case 'completed': return 'done';
    case 'failed': case 'cancelled': return 'cancelled';
    default: return 'todo';
  }
}

function columnToStatus(column: ColumnId): GoalStatus {
  switch (column) {
    case 'backlog': return 'draft';
    case 'todo': return 'ready';
    case 'inprogress': return 'running';
    case 'inreview': return 'paused';
    case 'done': return 'completed';
    case 'cancelled': return 'failed';
    default: return 'ready';
  }
}

/** 场景运行步骤状态 → 看板列状态（引擎所有，只读展示）。 */
function scenarioStepStatusToGoalStatus(status: string): GoalStatus {
  switch (status) {
    case 'running': return 'running';
    case 'completed': case 'skipped': return 'completed';
    case 'failed': return 'failed';
    case 'blocked': case 'paused': return 'paused';
    default: return 'ready';
  }
}

const COLUMNS: Array<{ id: ColumnId; labelKey: string; color: string }> = [
  { id: 'backlog', labelKey: 'kanban.backlog', color: 'var(--text-muted)' },
  { id: 'todo', labelKey: 'kanban.todo', color: 'var(--primary)' },
  { id: 'inprogress', labelKey: 'kanban.inprogress', color: 'var(--accent-warm)' },
  { id: 'inreview', labelKey: 'kanban.inreview', color: 'var(--status-failed)' },
  { id: 'done', labelKey: 'kanban.done', color: 'var(--status-completed)' },
  { id: 'cancelled', labelKey: 'kanban.cancelled', color: 'var(--text-muted)' },
];

const PRIORITY_COLORS: Record<Priority, string> = {
  low: 'var(--text-muted)',
  medium: 'var(--primary)',
  high: 'var(--accent-warm)',
  urgent: 'var(--status-failed)',
};

function formatAge(ts: number, locale: string): string {
  const diff = Date.now() - ts;
  const days = Math.floor(diff / 86400000);
  if (days === 0) return locale === 'zh' ? '今天' : 'today';
  if (days === 1) return locale === 'zh' ? '昨天' : 'yesterday';
  return locale === 'zh' ? `${days} 天前` : `${days}d ago`;
}

export interface TaskBoardPageProps {
  /** Initial project filter applied to the board (e.g. the active research project). */
  defaultProjectFilter?: string;
}

export default function TaskBoardPage({ defaultProjectFilter = '' }: TaskBoardPageProps = {}) {
  const { t, locale } = useTranslation();
  const [goals, setGoals] = useState<KanbanGoal[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filterText, setFilterText] = useState('');
  const [priorityFilter, setPriorityFilter] = useState('');
  const [projectFilter, setProjectFilter] = useState(defaultProjectFilter);
  const [projects, setProjects] = useState<Array<{ id: string; title: string }>>([]);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragOverColumn, setDragOverColumn] = useState<ColumnId | null>(null);
  const [newTaskColumn, setNewTaskColumn] = useState<ColumnId | null>(null);
  const [newTaskText, setNewTaskText] = useState('');
  // UX-KANBAN-002: 新建任务的项目归属。null=未选择（禁止静默创建）；''=未关联；
  // 其他值为具体项目 id。打开创建区时优先继承当前活动项目或明确的项目筛选值。
  const [newTaskProject, setNewTaskProject] = useState<string | null>(null);

  const loadGoals = useCallback(async () => {
    const metis = window.metis;
    if (!metis?.listGoals) return;
    setLoading(true);
    try {
      const result = await metis.listGoals();
      if (result.success) {
        const projectIds = new Set<string>();
        if (metis.listProjects) {
          const projectResult = await metis.listProjects();
          if (projectResult.success) {
            setProjects(projectResult.projects.map((project) => ({ id: project.id, title: project.title || project.id })));
            for (const project of projectResult.projects) projectIds.add(project.id);
          }
        }
        // ── 场景运行任务（2026-08-28 刘总要求）：看板必须显示场景工作流的
        // 真实步骤；否则旧 Goal 引擎没有任务时看板永远是空的。
        const activeProjectId = researchWorkspaceStore.getState().activeProjectId;
        if (activeProjectId) projectIds.add(activeProjectId);
        const scenarioGoals: KanbanGoal[] = [];
        const seenScenarioCardIds = new Set<string>();
        if (metis.getScenarioRunForProject) {
          for (const projectId of projectIds) {
            try {
              const run = await metis.getScenarioRunForProject(projectId);
              if (!run?.ok || !run.runId || !Array.isArray(run.steps)) continue;
              for (const step of run.steps) {
                // 去重（2026-08-29 刘总报告看板重复卡片）：同一 run 的同一步骤
                // 若被多个项目解析到，只保留首张卡，避免 React key 冲突与
                // 视觉重复。
                const cardId = `scenario-run:${run.runId}:${step.stepId}`;
                if (seenScenarioCardIds.has(cardId)) continue;
                seenScenarioCardIds.add(cardId);
                scenarioGoals.push({
                  id: cardId,
                  description: step.name,
                  status: scenarioStepStatusToGoalStatus(String(step.status)),
                  createdAt: Date.now(),
                  projectId,
                  prompt: (run as { stepsPromptById?: Record<string, string> }).stepsPromptById?.[step.stepId] || undefined,
                  scenarioId: run.scenarioId,
                });
              }
            } catch { /* 单个项目读取失败不影响看板其余内容 */ }
          }
        }
        // AI 设计的任务步骤上板（2026-08-29 刘总要求）：进行中/暂停的研究
        // 任务，其规划出的每个步骤作为独立卡片显示，而不是只显示任务本身。
        const goalStepGoals: KanbanGoal[] = [];
        for (const g of result.goals ?? []) {
          // failed 也在板（2026-08-29 刘总要求：AI 生成的每个步骤都可见，
          // 失败任务的步骤同样上板供查看/重试）。
          if (!['running', 'paused', 'planning', 'ready', 'failed'].includes(g.status)) continue;
          try {
            const workflow = await metis.getGoalWorkflow?.(g.goalId);
            if (!workflow?.success) continue;
            for (const step of workflow.workflow.steps) {
              goalStepGoals.push({
                id: `goal-run:${g.goalId}:${step.id}`,
                description: `${g.label} / ${step.name}`,
                status: scenarioStepStatusToGoalStatus(
                  workflow.stepResults[step.id]?.status ?? 'pending',
                ),
                createdAt: g.createdAt ?? Date.now(),
                projectId: g.projectId,
              });
            }
          } catch { /* 单个任务读取失败不影响看板 */ }
        }
        setGoals([
          ...(result.goals ?? []).map((g) => ({
            id: g.goalId,
            description: g.label,
            status: g.status as GoalStatus,
            priority: (g as unknown as { priority?: Priority }).priority,
            createdAt: g.createdAt,
            projectId: g.projectId,
          })),
          ...goalStepGoals,
          ...scenarioGoals,
        ]);
      }
    } catch {
      setError(t('kanban.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- loadGoals sets loading state synchronously before its first await
  useEffect(() => { void loadGoals(); }, [loadGoals]);

  // Live sync: any goal change from the chat side (create / plan / execute /
  // pause) refreshes the board without polling.
  useEffect(() => {
    const metis = window.metis;
    if (!metis?.onGoalChanged) return;
    let stale = false;
    const unsubscribe = metis.onGoalChanged(() => { if (!stale) void loadGoals(); });
    return () => { stale = true; unsubscribe(); };
  }, [loadGoals]);

  // Board focus handoff from a chat goal card ("open this task on the board").
  const pendingFocusRef = useRef<string | null>(null);
  useEffect(() => {
    const pending = window.sessionStorage.getItem('metis-pending-goal-focus');
    if (pending) {
      pendingFocusRef.current = pending;
      window.sessionStorage.removeItem('metis-pending-goal-focus');
      // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time handoff initialization; the filter must not hide the focused card
      setFilterText('');
    }
  }, []);
  useEffect(() => {
    const goalId = pendingFocusRef.current;
    if (!goalId || !goals.some((g) => g.id === goalId)) return;
    pendingFocusRef.current = null;
    setSelectedId(goalId);
    requestAnimationFrame(() => {
      const card = document.querySelector(`[data-goal-id="${goalId}"]`);
      if (card && typeof (card as HTMLElement).scrollIntoView === 'function') {
        (card as HTMLElement).scrollIntoView({ block: 'center' });
      }
    });
  }, [goals]);

  const filtered = useMemo(() => {
    const q = filterText.trim().toLowerCase();
    return goals.filter((g) => {
      if (q && !g.description.toLowerCase().includes(q)) return false;
      if (priorityFilter && g.priority !== priorityFilter) return false;
      if (projectFilter === 'unbound') return !g.projectId;
      if (projectFilter && g.projectId !== projectFilter) return false;
      return true;
    });
  }, [goals, filterText, priorityFilter, projectFilter]);

  const byColumn = useMemo(() => {
    const map = new Map<ColumnId, KanbanGoal[]>();
    for (const col of COLUMNS) map.set(col.id, []);
    for (const goal of filtered) {
      const col = statusToColumn(goal.status);
      map.get(col)?.push(goal);
    }
    return map;
  }, [filtered]);

  const selected = goals.find((g) => g.id === selectedId) ?? null;

  // ── Drag and drop ──

  const handleDragStart = useCallback((e: React.DragEvent, goalId: string) => {
    setDraggingId(goalId);
    e.dataTransfer.effectAllowed = 'move';
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, columnId: ColumnId) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOverColumn(columnId);
  }, []);

  const handleDragLeave = useCallback(() => {
    setDragOverColumn(null);
  }, []);

  // Keyboard equivalent of drag-and-drop: focus a card, then move it with
  // ArrowLeft / ArrowRight between adjacent columns.
  const moveGoalToColumn = useCallback(async (goalId: string, columnId: ColumnId) => {
    // 场景运行步骤由引擎推进（真实性契约），拖拽改状态对它们是假操作，直接忽略。
    if (goalId.startsWith('scenario-run:')) return;
    const goal = goals.find((g) => g.id === goalId);
    if (!goal) return;
    const newStatus = columnToStatus(columnId);
    if (goal.status === newStatus) return;
    const metis = window.metis;
    if (!metis?.updateGoalStatus) return;
    const result = await metis.updateGoalStatus({ goalId, status: newStatus });
    if (result.ok) await loadGoals();
  }, [goals, loadGoals]);

  const handleDrop = useCallback(async (e: React.DragEvent, columnId: ColumnId) => {
    e.preventDefault();
    setDragOverColumn(null);
    if (!draggingId) return;
    await moveGoalToColumn(draggingId, columnId);
    setDraggingId(null);
  }, [draggingId, moveGoalToColumn]);

  const handleCardKeyDown = useCallback((e: React.KeyboardEvent, goalId: string, currentColumn: ColumnId) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const currentIndex = COLUMNS.findIndex((column) => column.id === currentColumn);
    const nextIndex = e.key === 'ArrowRight' ? currentIndex + 1 : currentIndex - 1;
    const target = COLUMNS[nextIndex];
    if (!target) return;
    void moveGoalToColumn(goalId, target.id);
  }, [moveGoalToColumn]);

  // ── Card actions ──

  const handleDelete = useCallback(async (goalId: string) => {
    const metis = window.metis;
    if (!metis?.deleteGoal) return;
    const result = await metis.deleteGoal(goalId);
    if (result.ok) {
      setSelectedId(null);
      await loadGoals();
    }
  }, [loadGoals]);

  const handleSetPriority = useCallback(async (goalId: string, priority: Priority) => {
    const metis = window.metis;
    if (!metis?.updateGoalPriority) return;
    await metis.updateGoalPriority({ goalId, priority });
    await loadGoals();
  }, [loadGoals]);

  // UX-KANBAN-002: 新建任务的默认归属——优先继承当前活动项目，其次明确的项目
  // 筛选值（含「未关联」筛选）；两者都没有时必须显式选择，绝不静默创建全局任务。
  const defaultTaskProject = useCallback((): string | null => {
    if (projectFilter === 'unbound') return '';
    if (projectFilter) return projectFilter;
    return researchWorkspaceStore.getState().activeProjectId ?? null;
  }, [projectFilter]);

  const handleCreateTask = useCallback(async (columnId: ColumnId) => {
    const metis = window.metis;
    if (!metis?.createGoal || !newTaskText.trim()) return;
    // 归属未显式选择时不允许提交——用户必须先在下拉框里做出选择。
    if (newTaskProject === null) return;
    const status = columnToStatus(columnId);
    const projectId = newTaskProject === '' ? undefined : newTaskProject;
    const result = await metis.createGoal(
      newTaskText.trim(),
      undefined,
      projectId,
    );
    if (result.success && result.goalId) {
      await metis.updateGoalStatus?.({ goalId: result.goalId, status });
      await loadGoals();
      setNewTaskColumn(null);
      setNewTaskText('');
      setNewTaskProject(null);
    }
  }, [loadGoals, newTaskText, newTaskProject]);

  return (
    <div className="kanban-page">
      <div className="kanban-header">
        <h2>{t('kanban.pageTitle')}</h2>
        <button className="btn-toggle" onClick={() => void loadGoals()} disabled={loading}>
          {loading ? t('common.loading') : t('common.refresh')}
        </button>
      </div>

      {/* Filter bar */}
      <div className="kanban-filterbar">
        <input
          type="text"
          className="search-input"
          placeholder={t('kanban.searchPlaceholder')}
          value={filterText}
          onChange={(e) => setFilterText(e.target.value)}
          style={{ width: 200 }}
        />
        <select
          className="btn-sm"
          value={projectFilter}
          onChange={(e) => setProjectFilter(e.target.value)}
          aria-label={t('kanban.filterProject')}
          data-testid="kanban-project-filter"
        >
          <option value="">{t('kanban.allProjects')}</option>
          <option value="unbound">{t('kanban.unboundProjects')}</option>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>{project.title}</option>
          ))}
        </select>
        <select
          className="btn-sm"
          value={priorityFilter}
          onChange={(e) => setPriorityFilter(e.target.value)}
          aria-label={t('kanban.filterPriority')}
        >
          <option value="">{t('kanban.allPriorities')}</option>
          <option value="urgent">{t('kanban.priorityUrgent')}</option>
          <option value="high">{t('kanban.priorityHigh')}</option>
          <option value="medium">{t('kanban.priorityMedium')}</option>
          <option value="low">{t('kanban.priorityLow')}</option>
        </select>
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          {t('kanban.totalCount', { count: filtered.length })}
        </span>
      </div>

      {error && <div className="kanban-error" role="alert">{error}</div>}

      {/* Board */}
      <div className="kanban-board" data-testid="kanban-board">
        {COLUMNS.map((col) => {
          const columnGoals = byColumn.get(col.id) ?? [];
          return (
            <div
              key={col.id}
              className={`kanban-column ${dragOverColumn === col.id ? 'kanban-column--dragover' : ''}`}
              data-testid={`kanban-column-${col.id}`}
              onDragOver={(e) => handleDragOver(e, col.id)}
              onDragLeave={handleDragLeave}
              onDrop={(e) => void handleDrop(e, col.id)}
            >
              <div className="kanban-column__header" style={{ borderTopColor: col.color }}>
                <span className="kanban-column__title">{t(col.labelKey)}</span>
                <span className="kanban-column__count">{columnGoals.length}</span>
                <button
                  className="kanban-column__add"
                  data-testid={`kanban-add-${col.id}`}
                  onClick={() => {
                    setNewTaskColumn(newTaskColumn === col.id ? null : col.id);
                    setNewTaskText('');
                    setNewTaskProject(defaultTaskProject());
                  }}
                  title={t('kanban.addTask')}
                >
                  +
                </button>
              </div>

              {/* Inline new-task input */}
              {newTaskColumn === col.id && (
                <div className="kanban-new-task">
                  <input
                    className="settings-input"
                    data-testid={`kanban-new-task-input-${col.id}`}
                    value={newTaskText}
                    onChange={(e) => setNewTaskText(e.target.value)}
                    placeholder={t('kanban.newTaskPlaceholder')}
                    autoFocus
                    onKeyDown={(e) => { if (e.key === 'Enter') void handleCreateTask(col.id); if (e.key === 'Escape') setNewTaskColumn(null); }}
                  />
                  <select
                    className="btn-sm"
                    value={newTaskProject === null ? '' : (newTaskProject === '' ? '__unbound__' : newTaskProject)}
                    onChange={(e) => {
                      const value = e.target.value;
                      if (value === '__unbound__') setNewTaskProject('');
                      else if (value === '') setNewTaskProject(null);
                      else setNewTaskProject(value);
                    }}
                    data-testid="kanban-new-task-project"
                    aria-label={t('kanban.taskProject')}
                  >
                    {newTaskProject === null && <option value="" disabled>{t('kanban.selectProject')}</option>}
                    <option value="__unbound__">{t('kanban.unboundProjects')}</option>
                    {projects.map((project) => (
                      <option key={project.id} value={project.id}>{project.title}</option>
                    ))}
                  </select>
                  <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
                    <button className="btn-primary btn-sm" data-testid={`kanban-create-${col.id}`} onClick={() => void handleCreateTask(col.id)}>{t('common.save')}</button>
                    <button className="btn-secondary btn-sm" onClick={() => setNewTaskColumn(null)}>{t('common.cancel')}</button>
                  </div>
                </div>
              )}

              <div className="kanban-column__cards">
                {columnGoals.map((goal) => (
                  <div
                    key={goal.id}
                    className={`kanban-card ${selectedId === goal.id ? 'kanban-card--selected' : ''} ${draggingId === goal.id ? 'kanban-card--dragging' : ''}`}
                    data-testid="kanban-card"
                    data-goal-id={goal.id}
                    draggable
                    role="button"
                    tabIndex={0}
                    aria-label={`${goal.description}，${t(`kanban.status_${goal.status}`)}`}
                    onDragStart={(e) => handleDragStart(e, goal.id)}
                    onClick={() => setSelectedId(goal.id)}
                    onKeyDown={(e) => handleCardKeyDown(e, goal.id, col.id)}
                  >
                    <div className="kanban-card__title">{goal.description}</div>
                    <div className="kanban-card__meta">
                      {goal.priority && (
                        <span className="kanban-card__priority" style={{ color: PRIORITY_COLORS[goal.priority] }}>
                          {t(`kanban.priority${goal.priority.charAt(0).toUpperCase() + goal.priority.slice(1)}`)}
                        </span>
                      )}
                      <span className="kanban-card__age">{formatAge(goal.createdAt, locale)}</span>
                    </div>
                  </div>
                ))}
                {columnGoals.length === 0 && !newTaskColumn && (
                  <div className="kanban-column__empty">{t('kanban.columnEmpty')}</div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Detail panel — dialog semantics with keyboard close */}
      {selected && (
        <div
          className="kanban-detail"
          data-testid="kanban-detail"
          role="dialog"
          aria-modal="true"
          aria-label={selected.description}
          onKeyDown={(e) => { if (e.key === 'Escape') setSelectedId(null); }}
        >
          <div className="kanban-detail__header">
            <h3>{selected.description}</h3>
            <button className="btn-sm btn-secondary" autoFocus onClick={() => setSelectedId(null)} aria-label={t('common.close') ?? '关闭'}>×</button>
          </div>
          <div className="kanban-detail__body">
            <div className="kanban-detail__row">
              <span className="kanban-detail__label">{t('kanban.detailStatus')}</span>
              <span className="kanban-detail__value">{t(`kanban.status_${selected.status}`)}</span>
            </div>
            <div className="kanban-detail__row">
              <span className="kanban-detail__label">{t('kanban.detailPriority')}</span>
              <div style={{ display: 'flex', gap: 4 }}>
                {(['low', 'medium', 'high', 'urgent'] as Priority[]).map((p) => (
                  <button
                    key={p}
                    className={`btn-sm ${selected.priority === p ? 'btn-primary' : 'btn-secondary'}`}
                    onClick={() => void handleSetPriority(selected.id, p)}
                  >
                    {t(`kanban.priority${p.charAt(0).toUpperCase() + p.slice(1)}`)}
                  </button>
                ))}
              </div>
            </div>
            <div className="kanban-detail__row">
              <span className="kanban-detail__label">{t('kanban.detailCreated')}</span>
              <span className="kanban-detail__value">{new Date(selected.createdAt).toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US')}</span>
            </div>
            {selected.id.startsWith('scenario-run:') && selected.scenarioId && (
              <ScenarioStepPromptEditor
                scenarioId={selected.scenarioId}
                stepName={selected.description}
                initialPrompt={selected.prompt ?? ''}
                onSaved={() => void loadGoals()}
              />
            )}
            <div className="kanban-detail__actions">
              {/* 场景工作流步骤卡支持看板直接执行（2026-08-29 刘总要求）：
                  把步骤执行指令交接给当前项目的对话并自动发送。 */}
              {selected.id.startsWith('scenario-run:') && (
                <button
                  className="btn-sm btn-primary"
                  data-testid="kanban-execute-task"
                  onClick={() => {
                    setPendingChatIntent({
                      message: locale === 'zh'
                        ? `请继续执行场景工作流中的「${selected.description}」步骤：按该步骤的专属 Prompt 与完成标准完成本步骤，然后按工作流顺序继续推进后续步骤。`
                        : `Continue the scenario workflow step "${selected.description}": complete it according to its dedicated prompt and completion criteria, then proceed with the following steps.`,
                      ...(selected.projectId ? { projectId: selected.projectId } : {}),
                      autoSend: true,
                    });
                    setSelectedId(null);
                    window.dispatchEvent(new CustomEvent('metis:open-goal', { detail: { goalId: selected.id } }));
                  }}
                >
                  {locale === 'zh' ? '执行此任务' : 'Execute'}
                </button>
              )}
              <button
                className="btn-sm btn-primary"
                data-testid="kanban-discuss-in-chat"
                onClick={() => {
                  setSelectedId(null);
                  window.dispatchEvent(new CustomEvent('metis:open-goal', { detail: { goalId: selected.id } }));
                }}
              >
                {t('kanban.discussInChat')}
              </button>
              <button
                className="btn-sm"
                data-testid="kanban-delete"
                onClick={() => void handleDelete(selected.id)}
                style={{ color: 'var(--status-failed)' }}
              >
                {t('common.delete')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * 场景步骤提示词查看/编辑（2026-08-29 刘总要求：看板点开步骤即可查看并
 * 修改该步骤的专属提示词；保存写入场景定义的新修订，不影响运行中的快照）。
 */
function ScenarioStepPromptEditor({ scenarioId, stepName, initialPrompt, onSaved }: {
  scenarioId: string;
  stepName: string;
  initialPrompt: string;
  onSaved(): void;
}) {
  const { locale } = useTranslation();
  const [prompt, setPrompt] = useState(initialPrompt);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');

  const save = async () => {
    if (busy) return;
    setBusy(true);
    setNotice('');
    try {
      const metis = window.metis;
      if (!metis?.getPersonalization || !metis?.savePersonalization) {
        setNotice(locale === 'zh' ? '场景服务不可用。' : 'Scenario service is unavailable.');
        return;
      }
      const current = await metis.getPersonalization({ contractVersion: 1, id: scenarioId });
      const definition = current?.definition;
      if (!definition || definition.kind !== 'scenario') {
        setNotice(locale === 'zh' ? '未找到所属场景定义。' : 'The scenario definition was not found.');
        return;
      }
      const stepId = promptStepIdFromCardKey(stepName, definition);
      const updated = {
        ...definition,
        revision: definition.revision + 1,
        provenance: { ...definition.provenance, locallyModified: true, updatedAt: Date.now() },
        workflow: definition.workflow.map((step) => (
          step.id === stepId || step.name === stepName
            ? { ...step, prompt }
            : step
        )),
      };
      const saved = await metis.savePersonalization({
        contractVersion: 1,
        definition: updated,
        expectedRevision: definition.revision,
      });
      setNotice(saved?.ok
        ? (locale === 'zh' ? '提示词已保存到场景（新版本）。' : 'Prompt saved to the scenario as a new revision.')
        : (locale === 'zh' ? `保存未完成（${saved?.code ?? 'unknown'}）。` : `Save failed (${saved?.code ?? 'unknown'}).`));
      if (saved?.ok) onSaved();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="kanban-detail__row kanban-prompt-editor" data-testid="kanban-prompt-editor">
      <span className="kanban-detail__label">{locale === 'zh' ? '步骤提示词' : 'Step prompt'}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <textarea
          value={prompt}
          rows={6}
          disabled={busy}
          onChange={(event) => setPrompt(event.target.value)}
          style={{ width: '100%', fontSize: 12, lineHeight: 1.5 }}
        />
        <div style={{ display: 'flex', gap: 8, marginTop: 6, alignItems: 'center' }}>
          <button type="button" className="btn-sm btn-primary" disabled={busy} onClick={() => void save()}>
            {busy ? (locale === 'zh' ? '保存中…' : 'Saving…') : (locale === 'zh' ? '保存提示词' : 'Save prompt')}
          </button>
          {notice && <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{notice}</span>}
        </div>
      </div>
    </div>
  );
}

/** 从卡片描述（步骤名）推断场景 workflow 中的步骤 id。 */
function promptStepIdFromCardKey(stepName: string, definition: { workflow: Array<{ id: string; name: string }> }): string | undefined {
  const direct = definition.workflow.find((step) => step.name === stepName);
  if (direct) return direct.id;
  const suffix = stepName.includes('/') ? stepName.split('/').pop()?.trim() : stepName.trim();
  return definition.workflow.find((step) => step.name === suffix)?.id;
}
