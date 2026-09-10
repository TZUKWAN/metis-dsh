/**
 * ProjectTasksPanel — project-bound tasks inside the research workspace.
 *
 * Same GoalEngine as the global kanban board: tasks created here carry the
 * project id, appear in the board's project filter, and sync live in both
 * directions via the goal:changed broadcast.
 */

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from '../i18n';
import './ProjectTasksPanel.css';

type TaskStatus = 'draft' | 'planning' | 'ready' | 'running' | 'paused' | 'completed' | 'failed';

interface ProjectTask {
  id: string;
  description: string;
  status: TaskStatus;
  createdAt: number;
}

const STATUS_LABEL_KEYS: Record<TaskStatus, string> = {
  draft: 'projectTasks.draft',
  planning: 'projectTasks.planning',
  ready: 'projectTasks.ready',
  running: 'projectTasks.running',
  paused: 'projectTasks.paused',
  completed: 'projectTasks.completed',
  failed: 'projectTasks.failed',
};

export default function ProjectTasksPanel({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const [tasks, setTasks] = useState<ProjectTask[]>([]);
  const [loading, setLoading] = useState(false);
  const [draft, setDraft] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadTasks = useCallback(async () => {
    const metis = window.metis;
    if (!metis?.listGoals) return;
    setLoading(true);
    try {
      const result = await metis.listGoals();
      if (result.success) {
        setTasks((result.goals ?? [])
          .filter((goal) => goal.projectId === projectId)
          .map((goal) => ({
            id: goal.goalId,
            description: goal.label,
            status: goal.status as TaskStatus,
            createdAt: goal.createdAt,
          })));
      }
    } catch {
      setError(t('projectTasks.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [projectId, t]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void loadTasks(); }, 0);
    return () => { window.clearTimeout(timer); };
  }, [loadTasks]);

  // Live sync with the board / chat (create, status change, delete).
  useEffect(() => {
    const metis = window.metis;
    if (!metis?.onGoalChanged) return;
    let stale = false;
    const unsubscribe = metis.onGoalChanged(() => { if (!stale) void loadTasks(); });
    return () => { stale = true; unsubscribe(); };
  }, [loadTasks]);

  const handleCreate = async () => {
    const metis = window.metis;
    const text = draft.trim();
    if (!metis?.createGoal || !text) return;
    setCreating(true);
    setError(null);
    try {
      const result = await metis.createGoal(text, undefined, projectId);
      if (!result.success) {
        setError(t('projectTasks.createFailed'));
        return;
      }
      setDraft('');
      await loadTasks();
    } catch {
      setError(t('projectTasks.createFailed'));
    } finally {
      setCreating(false);
    }
  };

  const handleStatus = async (task: ProjectTask, status: TaskStatus) => {
    const metis = window.metis;
    if (!metis?.updateGoalStatus) return;
    try {
      await metis.updateGoalStatus({ goalId: task.id, status });
      await loadTasks();
    } catch {
      setError(t('projectTasks.updateFailed'));
    }
  };

  const quickActions: Array<{ status: TaskStatus; labelKey: string }> = [
    { status: 'running', labelKey: 'projectTasks.start' },
    { status: 'paused', labelKey: 'projectTasks.pause' },
    { status: 'completed', labelKey: 'projectTasks.complete' },
    { status: 'failed', labelKey: 'projectTasks.cancel' },
  ];

  return (
    <div className="project-tasks" data-testid="project-tasks-panel">
      <div className="project-tasks__create">
        <input
          className="project-tasks__input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={t('projectTasks.placeholder')}
          aria-label={t('projectTasks.placeholder')}
          onKeyDown={(e) => { if (e.key === 'Enter') void handleCreate(); }}
          data-testid="project-tasks-input"
        />
        <button
          type="button"
          className="btn-sm btn-primary"
          onClick={() => void handleCreate()}
          disabled={creating || !draft.trim()}
          data-testid="project-tasks-create"
        >
          {t('projectTasks.add')}
        </button>
      </div>
      {error && <div className="project-tasks__error" role="alert">{error}</div>}
      {loading && tasks.length === 0 ? (
        <div className="project-tasks__empty">{t('common.loading')}</div>
      ) : tasks.length === 0 ? (
        <div className="project-tasks__empty" data-testid="project-tasks-empty">
          {t('projectTasks.empty')}
        </div>
      ) : (
        <ul className="project-tasks__list" data-testid="project-tasks-list">
          {tasks.map((task) => (
            <li key={task.id} className="project-tasks__item">
              <div className="project-tasks__main">
                <span className="project-tasks__title">{task.description}</span>
                <span className={`project-tasks__status project-tasks__status--${task.status}`}>
                  {t(STATUS_LABEL_KEYS[task.status])}
                </span>
              </div>
              <div className="project-tasks__actions">
                {quickActions.map((action) => (
                  <button
                    key={action.status}
                    type="button"
                    className="btn-sm btn-secondary"
                    onClick={() => void handleStatus(task, action.status)}
                    disabled={task.status === action.status}
                    data-testid={`project-tasks-${action.status}`}
                  >
                    {t(action.labelKey)}
                  </button>
                ))}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
