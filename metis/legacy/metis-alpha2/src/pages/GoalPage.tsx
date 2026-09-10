/**
 * GoalPage — read-only Goal history viewer.
 *
 * All goal creation, plan generation, and execution now happens
 * inline in the Chat page. This page shows past goals and their results.
 */

import { useState, useEffect, useRef } from 'react';
import { useTranslation } from '../i18n';
import { setPendingChatIntent } from '../lib/chatIntent.js';
import GoalCardInline, { type GoalCardData } from '../components/GoalCardInline';
import WorkflowGraph from '../components/WorkflowGraph';
import type { GoalSummary } from '../../engine/runtime/GoalRuntimeContract.js';
import type { GoalWorkflowResponse } from '../../engine/runtime/GoalRuntimeContract.js';

// ─── Types ────────────────────────────────────────────────────

type Goal = GoalSummary;

/** O17: 契约解码成功的工作流视图（steps + dependencies + 最新 run 状态）。 */
type GoalWorkflowView = Extract<GoalWorkflowResponse, { success: true }>;

interface GoalProgress {
  goalId: string;
  status: string;
  totalSteps: number;
  completedSteps: number;
  failedSteps: number;
  currentStepId: string | null;
  startedAt: number;
  completedAt: number | null;
}

// ─── Component ────────────────────────────────────────────────

interface GoalPageProps {
  onNavigate?: (page: string) => void;
}

export default function GoalPage({ onNavigate }: GoalPageProps) {
  const { t } = useTranslation();

  function handleSocraticPlan() {
    const message = `I want to plan and structure this research goal through Socratic dialogue.\n\nPlease ask me focused diagnostic questions to help clarify the research question, motivation, key claims, methodology, evidence needs, and paper structure.`;
    setPendingChatIntent({ skillId: 'socratic-plan', message });
    onNavigate?.('chat');
  }

  // O14: 从上次断点继续——不指定步骤，由主进程从持久化 checkpoint 推导恢复点。
  async function handleResumeFromCheckpoint() {
    const metis = window.metis;
    if (!metis?.resumeGoal || !selectedGoal) return;
    setLoading(true);
    try {
      await metis.resumeGoal(selectedGoal.goalId);
      const refreshed = await metis.getGoal(selectedGoal.goalId);
      if (refreshed.success) {
        setSelectedGoal(refreshed.goal);
        setGoals((previous) => previous.map((g) => (g.goalId === refreshed.goal.goalId ? refreshed.goal : g)));
      }
    } catch {
      console.warn('Failed to resume goal from checkpoint');
    } finally {
      setLoading(false);
    }
  }

  const [goals, setGoals] = useState<Goal[]>([]);
  const [selectedGoal, setSelectedGoal] = useState<Goal | null>(null);
  const [goalProgress, setGoalProgress] = useState<GoalProgress | null>(null);
  const [goalWorkflow, setGoalWorkflow] = useState<GoalWorkflowView | null>(null);
  const [archives] = useState<Array<{ goal: Goal; summary: string; archivedAt: number }>>([]);
  const [loading, setLoading] = useState(false);
  /** O17: 防止异步加载的工作流视图落到已切换的 goal 上。 */
  const selectedGoalIdRef = useRef<string | null>(null);

  // Load goals and archives on mount
  useEffect(() => {
    async function loadGoals() {
      const metis = window.metis;
      if (!metis?.listGoals) return;
      try {
        const response = await metis.listGoals();
        setGoals(response.success ? response.goals : []);
      } catch {
        console.warn('Failed to load goals safely');
      }
    }

    loadGoals();
  }, []);

  // O7: reload goal list + selected workflow after a step decision.
  async function refreshGoals() {
    const metis = window.metis;
    if (!metis?.listGoals) return;
    try {
      const response = await metis.listGoals();
      setGoals(response.success ? response.goals : []);
      if (selectedGoalIdRef.current && metis.getGoalWorkflow) {
        const wf = await metis.getGoalWorkflow(selectedGoalIdRef.current);
        if (wf && wf.success && 'workflow' in wf) setGoalWorkflow(wf);
      }
    } catch {
      console.warn('Failed to refresh goals safely');
    }
  }

  function selectGoal(goal: Goal) {
    setSelectedGoal(goal);
    selectedGoalIdRef.current = goal.goalId;
    setGoalProgress(null);
    setGoalWorkflow(null);
    setLoading(false);
    // O17: 选中 goal 后拉取其工作流定义，用于下方 DAG 可视化。
    const metis = window.metis;
    if (metis?.getGoalWorkflow) {
      void metis.getGoalWorkflow(goal.goalId).then((response) => {
        if (selectedGoalIdRef.current !== goal.goalId) return;
        if (response.success) setGoalWorkflow(response);
      }).catch(() => {
        // 可视化加载失败不影响 goal 详情展示。
      });
    }
  }

  function goalStatusLabel(status: Goal['status']): string {
    if (status === 'completed') return t('goal.completed');
    if (status === 'failed') return t('goal.failed');
    if (status === 'running') return t('chat.goalExecuting');
    if (status === 'paused') return t('goal.paused');
    if (status === 'cancelled') return t('chat.goalCancel');
    if (status === 'unknown') return t('chat.goalUnavailable');
    return t('chat.goalPlanning');
  }

  // Build a GoalCardData from selected goal info
  function buildGoalCard(): GoalCardData | null {
    if (!selectedGoal) return null;

    const steps = goalWorkflow?.workflow.steps ?? [];
    const stepStatuses: Record<string, { stepId: string; stepName: string; status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped'; output: string }> = {};

    for (const step of steps) {
      let status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped' = 'pending';
      const persisted = goalWorkflow?.stepResults[step.id];
      if (persisted) status = persisted.status;
      else if (selectedGoal.status === 'completed') status = 'completed';
      else if (selectedGoal.status === 'failed') status = 'failed';
      stepStatuses[step.id] = { stepId: step.id, stepName: step.name, status, output: persisted?.output ?? '' };
    }

    const phase = selectedGoal.status === 'completed' ? 'completed' :
      selectedGoal.status === 'failed' ? 'failed' :
      selectedGoal.status === 'running' ? 'executing' :
      selectedGoal.status === 'paused' ? 'paused' :
      selectedGoal.status === 'cancelled' ? 'cancelled' :
      selectedGoal.status === 'unknown' ? 'unknown' : 'plan_ready';

    return {
      goalId: selectedGoal.goalId,
      description: t('goal.genericLabel'),
      phase,
      planName: goalWorkflow?.workflow.name,
      planDescription: goalWorkflow?.workflow.description,
      steps,
      stepStatuses,
      progress: {
        completed: goalProgress?.completedSteps ?? 0,
        total: goalProgress?.totalSteps ?? steps.length,
        currentStep: goalProgress?.currentStepId ?? '',
      },
      canRefine: false,
    };
  }

  const goalCard = buildGoalCard();

  return (
    <div className="goal-page">
      {/* Left sidebar: Goal list */}
      <div className="goal-sidebar">
        <h3>{t('goal.historyTitle')}</h3>
        <div className="goal-list">
          {goals.length === 0 && archives.length === 0 ? (
            <p className="goal-sidebar-text">{t('goal.noGoals')}</p>
          ) : (
            goals.map((g) => (
              <button
                key={g.goalId}
                onClick={() => selectGoal(g)}
                className={`goal-item ${selectedGoal?.goalId === g.goalId ? 'active' : ''}`}
              >
                <div className="goal-item-title">
                  {t('goal.genericLabel')}
                </div>
                <div className="goal-item-status">{goalStatusLabel(g.status)}</div>
              </button>
            ))
          )}
        </div>

        {archives.length > 0 && (
          <>
            <h4>{t('goal.archiveTitle')}</h4>
            <div style={{ maxHeight: 200, overflow: 'auto' }}>
              {archives.map((a, i) => (
                <div key={i} className="archive-item">
                  {t('goal.genericLabel')}
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {/* Main content */}
      <div className="goal-main">
        {!selectedGoal ? (
          <>
            <h2>{t('goal.historyTitle')}</h2>
            <p style={{ color: 'var(--text-secondary)', fontSize: 13, marginBottom: 16 }}>
              {t('chat.goalUseChat')}
            </p>
            {goals.length === 0 && archives.length === 0 && (
              <p style={{ color: 'var(--text-secondary)', fontSize: 13 }}>
                {t('goal.noGoals')}
              </p>
            )}
          </>
        ) : (
          <>
            <div className="plan-card-header" style={{ marginBottom: 16 }}>
              <div>
                <h3>{t('goal.genericLabel')}</h3>
                <span style={{ fontSize: 12, color: 'var(--text-secondary)', textTransform: 'uppercase' }}>
                  {goalStatusLabel(selectedGoal.status)}
                </span>
                <span style={{ fontSize: 12, color: 'var(--text-muted)', marginLeft: 8 }}>
                  {new Date(selectedGoal.createdAt).toLocaleString()}
                </span>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                {/* O14: run 处于 failed/paused 且留有可恢复 checkpoint 时显示断点续跑 */}
                {(selectedGoal.status === 'failed' || selectedGoal.status === 'paused') && selectedGoal.checkpoint?.resumable && (
                  <button
                    className="btn-secondary"
                    data-testid="goal-resume-checkpoint"
                    disabled={loading}
                    onClick={() => { void handleResumeFromCheckpoint(); }}
                  >
                    {t('goal.resumeFromCheckpoint')}
                    {selectedGoal.checkpoint.totalSteps > 0
                      ? ` (${selectedGoal.checkpoint.completedSteps}/${selectedGoal.checkpoint.totalSteps})`
                      : ''}
                  </button>
                )}
                <button
                  className="btn-secondary"
                  data-testid="goal-socratic-plan"
                  onClick={handleSocraticPlan}
                >
                  {t('goal.socraticPlan')}
                </button>
                <button className="btn-secondary" onClick={() => { setSelectedGoal(null); setGoalProgress(null); setGoalWorkflow(null); }}>
                  {t('common.close')}
                </button>
              </div>
            </div>

            {loading && (
              <div className="goal-card-spinner">
                <div className="hydration-spinner" />
                <span>Loading...</span>
              </div>
            )}

            {!loading && goalCard && (
              <GoalCardInline data={goalCard} />
            )}

            {/* O17: 工作流 DAG 可视化（只读），选中带 plan 的 goal 时展示 */}
            {!loading && goalWorkflow && (
              <div style={{ marginTop: 16 }} data-testid="goal-workflow-section">
                <h4 style={{ margin: '0 0 8px' }}>{t('goal.workflowGraphTitle')}</h4>
                <WorkflowGraph
                  workflow={goalWorkflow.workflow}
                  stepResults={goalWorkflow.stepResults}
                  goalId={selectedGoal.goalId}
                  onResolveDecision={(goalId, action) => {
                    void window.metis?.resolveStepDecision?.(goalId, action).then((result) => {
                      if (result?.success) refreshGoals();
                    });
                  }}
                  onReorder={(fromStepId, toStepId) => {
                    // O17: swap the two steps' positions in the workflow plan,
                    // then persist via the existing updatePlan IPC.
                    const steps = [...goalWorkflow.workflow.steps];
                    const fromIdx = steps.findIndex((s) => s.id === fromStepId);
                    const toIdx = steps.findIndex((s) => s.id === toStepId);
                    const fromStep = steps[fromIdx];
                    const toStep = steps[toIdx];
                    if (fromIdx < 0 || toIdx < 0 || !fromStep || !toStep) return;
                    steps[fromIdx] = toStep;
                    steps[toIdx] = fromStep;
                    void window.metis?.updatePlan?.(selectedGoal.goalId, {
                      ...goalWorkflow.workflow,
                      steps,
                    }).then(() => refreshGoals());
                  }}
                />
              </div>
            )}

            {!loading && !goalCard && (
              <p style={{ color: 'var(--text-secondary)', fontSize: 13 }}>
                No details available for this goal.
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
