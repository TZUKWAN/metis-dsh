import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from '../i18n';
import { useResearchWorkspaceStore } from '../research/researchWorkspaceStore';
import { RESEARCH_STAGES, DEFAULT_STAGE, stageProgress, type ResearchStageId } from '../../engine/research/ResearchStages';
import './ProjectHomeBanner.css';

interface BriefView {
  projectId: string;
  summaryText: string;
}

type ScenarioStepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'blocked' | 'skipped';

interface ScenarioRunView {
  runId: string;
  scenarioId: string;
  scenarioName?: string;
  status: 'running' | 'completed' | 'failed' | 'interrupted' | 'paused' | 'cancelled';
  steps: Array<{
    stepId: string;
    name: string;
    status: ScenarioStepStatus;
  }>;
}

const COMPLETED_STEP_STATUSES = new Set<ScenarioStepStatus>(['completed', 'skipped']);

function scenarioRunStatusLabel(status: ScenarioRunView['status'], locale: string): string {
  if (locale !== 'zh') {
    return {
      running: 'Running',
      completed: 'Completed',
      failed: 'Failed',
      interrupted: 'Interrupted',
      paused: 'Paused',
      cancelled: 'Cancelled',
    }[status];
  }
  return {
    running: '正在执行',
    completed: '已完成',
    failed: '执行失败',
    interrupted: '已中断',
    paused: '已暂停',
    cancelled: '已取消',
  }[status];
}

function scenarioStepStatusLabel(status: ScenarioStepStatus, locale: string): string {
  if (locale !== 'zh') {
    return {
      pending: 'Pending',
      running: 'Running',
      completed: 'Completed',
      failed: 'Failed',
      blocked: 'Blocked',
      skipped: 'Skipped',
    }[status];
  }
  return {
    pending: '待执行',
    running: '进行中',
    completed: '已完成',
    failed: '失败',
    blocked: '受阻',
    skipped: '已跳过',
  }[status];
}

export default function ProjectHomeBanner() {
  const { t, locale } = useTranslation();
  const activeProjectId = useResearchWorkspaceStore((s) => s.activeProjectId);
  const projects = useResearchWorkspaceStore((s) => s.projects);
  const project = projects.find((p) => p.id === activeProjectId) ?? null;
  const [stage, setStage] = useState<ResearchStageId>(DEFAULT_STAGE);
  const [rationale, setRationale] = useState<string[]>([]);
  const [brief, setBrief] = useState<BriefView | null>(null);
  const [scenarioRun, setScenarioRun] = useState<ScenarioRunView | null>(null);

  useEffect(() => {
    let alive = true;
    if (!activeProjectId) {
      setScenarioRun(null);
      return () => { alive = false; };
    }

    const loadScenarioRun = async () => {
      const result = await window.metis?.getScenarioRunForProject?.(activeProjectId);
      if (!alive) return;
      if (result?.ok && result.runId && result.scenarioId && result.status && result.steps?.length) {
        setScenarioRun({
          runId: result.runId,
          scenarioId: result.scenarioId,
          scenarioName: result.scenarioName,
          status: result.status,
          steps: result.steps,
        });
      } else {
        setScenarioRun(null);
      }
    };

    void loadScenarioRun();
    const interval = window.setInterval(() => { void loadScenarioRun(); }, 2_000);
    return () => {
      alive = false;
      window.clearInterval(interval);
    };
  }, [activeProjectId]);

  useEffect(() => {
    let alive = true;
    if (activeProjectId) {
      void window.metis?.detectStage?.(activeProjectId).then((result) => {
        if (!alive || !result) return;
        if (RESEARCH_STAGES.some((def) => def.id === result.stage)) {
          setStage(result.stage as ResearchStageId);
          setRationale(result.rationale ?? []);
        }
      });
      void window.metis?.getResumeBrief?.(activeProjectId).then((result) => {
        if (alive && result && result.projectId === activeProjectId) {
          setBrief({ projectId: result.projectId, summaryText: result.summaryText });
        }
      });
    }
    return () => { alive = false; };
  }, [activeProjectId, project?.updatedAt]);

  const scenarioProgress = useMemo(() => {
    if (!scenarioRun) return null;
    const completed = scenarioRun.steps.filter((step) => COMPLETED_STEP_STATUSES.has(step.status)).length;
    const runningIndex = scenarioRun.steps.findIndex((step) => step.status === 'running');
    const pendingIndex = scenarioRun.steps.findIndex((step) => step.status === 'pending');
    const currentIndex = runningIndex >= 0 ? runningIndex : pendingIndex;
    return {
      completed,
      total: scenarioRun.steps.length,
      currentIndex,
      progress: scenarioRun.steps.length === 0 ? 0 : (completed / scenarioRun.steps.length) * 100,
    };
  }, [scenarioRun]);

  if (!project) return null;

  const progress = stageProgress(stage);
  const stageDef = RESEARCH_STAGES.find((def) => def.id === stage) ?? RESEARCH_STAGES[0]!;

  return (
    <div className="project-home" data-testid="project-home">
      <div className="project-home__main">
        {scenarioRun && scenarioProgress ? (
          // 刘总 2026-09：顶部只保留进度条一行（场景名/状态/进度/N 步），
          // 不再展示当前步骤卡片与「最近完成」流水简报。
          <div className="project-home__stage project-home__scenario-summary">
            <span className="project-home__stage-label">{locale === 'zh' ? '场景工作流' : 'Scenario workflow'}</span>
            <span className="project-home__stage-value" data-testid="project-scenario-name">
              {scenarioRun.scenarioName || scenarioRun.scenarioId}
            </span>
            <span className={`project-home__scenario-status project-home__scenario-status--${scenarioRun.status}`}>
              {scenarioRunStatusLabel(scenarioRun.status, locale)}
            </span>
            <div
              className="project-home__stage-progress"
              role="progressbar"
              aria-label={locale === 'zh' ? '场景工作流进度' : 'Scenario workflow progress'}
              aria-valuenow={Math.round(scenarioProgress.progress)}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <span style={{ width: `${Math.round(scenarioProgress.progress)}%` }} />
            </div>
            <span className="project-home__stage-count" data-testid="project-scenario-progress">
              {locale === 'zh'
                ? `${scenarioProgress.completed}/${scenarioProgress.total} 步`
                : `${scenarioProgress.completed}/${scenarioProgress.total} steps`}
            </span>
          </div>
        ) : (
          <>
            <div className="project-home__stage">
              <span className="project-home__stage-label">{t('projects.aiStageLabel')}</span>
              <span className="project-home__stage-value" data-testid="project-ai-stage">{t(`projects.stage_${stageDef.key}.label`)}</span>
              <div className="project-home__stage-progress" role="progressbar" aria-valuenow={Math.round(progress * 100)} aria-valuemin={0} aria-valuemax={100}>
                <span style={{ width: `${Math.round(progress * 100)}%` }} />
              </div>
              <span className="project-home__stage-count">{Math.round(progress * 100)}%</span>
            </div>
            {rationale.length > 0 && (
              <p className="project-home__rationale" data-testid="project-stage-rationale">
                {rationale.map((reason, index) => (
                  <span key={index} className="project-home__rationale-chip">{reason}</span>
                ))}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
