/**
 * ResearchJournalService — 跨会话研究连续性（T27）。
 *
 * 打开项目时给出"上次进展摘要"：最近自主科研 run、任务（goals）、
 * 成果版本、文献导入。规则合成（零模型调用，确定性），
 * 供项目主页横幅展示与对话上下文注入（可选）。
 */
import type { ResearchRepository } from '../engine/persistence/ResearchRepository.js';
import type { PersistenceStore } from '../engine/persistence/PersistenceStore.js';
import type { GoalEngine } from '../engine/goal/GoalEngine.js';

export interface ResumeBrief {
  projectId: string;
  generatedAt: number;
  lastActivityAt: number | null;
  openTasks: number;
  runningTasks: number;
  lastCompletedTask: string | null;
  lastRunStatus: string | null;
  lastRunAt: number | null;
  artifactCount: number;
  lastArtifactTitle: string | null;
  lastArtifactAt: number | null;
  paperCount: number;
  lastPaperTitle: string | null;
  /** 规则合成的中文摘要（主页横幅直接展示）。 */
  summaryText: string;
}

export class ResearchJournalService {
  constructor(
    private readonly repository: ResearchRepository | null,
    private readonly goals: GoalEngine | null,
    private readonly store: PersistenceStore | null,
  ) {}

  buildResumeBrief(projectId: string): ResumeBrief | null {
    const project = this.repository?.getProject(projectId, false);
    if (!project) return null;

    const projectGoals = (this.goals?.listGoals() ?? []).filter((goal) => goal.projectId === projectId);
    const openTasks = projectGoals.filter((goal) => goal.status === 'draft' || goal.status === 'ready' || goal.status === 'paused').length;
    const runningTasks = projectGoals.filter((goal) => goal.status === 'running' || goal.status === 'planning').length;
    const completedSorted = projectGoals
      .filter((goal) => goal.status === 'completed')
      .sort((a, b) => b.createdAt - a.createdAt);
    const lastCompletedTask = completedSorted[0]?.description ?? null;

    const runs = (this.repository?.listRuns(projectId) ?? [])
      .sort((a, b) => b.updatedAt - a.updatedAt);
    const lastRun = runs[0] ?? null;

    const artifacts = this.repository?.listArtifacts(projectId) ?? [];
    let lastArtifact: { title: string; at: number } | null = null;
    for (const artifact of artifacts) {
      const versions = this.repository?.listArtifactVersions(artifact.id) ?? [];
      const latest = versions.sort((a, b) => b.createdAt - a.createdAt)[0];
      if (latest && (!lastArtifact || latest.createdAt > lastArtifact.at)) {
        lastArtifact = { title: artifact.title, at: latest.createdAt };
      }
    }

    const papers = (this.store?.getPapers() ?? []).filter((row) => row.projectId === projectId);
    const lastPaper = papers.sort((a, b) => b.addedAt - a.addedAt)[0] ?? null;

    const lastActivityAt = Math.max(
      lastRun?.updatedAt ?? 0,
      lastArtifact?.at ?? 0,
      lastPaper?.addedAt ?? 0,
      projectGoals.reduce((max, goal) => Math.max(max, goal.createdAt), 0),
    ) || null;

    const parts: string[] = [];
    if (lastRun) {
      const when = formatDate(lastRun.updatedAt);
      parts.push(`上次自主科研（${when}）状态：${runStatusLabel(lastRun.status)}`);
    }
    if (runningTasks > 0) parts.push(`${runningTasks} 项任务进行中`);
    if (openTasks > 0) parts.push(`${openTasks} 项任务待办`);
    if (lastCompletedTask) parts.push(`最近完成：${lastCompletedTask.slice(0, 30)}`);
    if (lastArtifact) parts.push(`最新成果：《${lastArtifact.title.slice(0, 24)}》（${formatDate(lastArtifact.at)}）`);
    if (lastPaper) parts.push(`最新文献：《${lastPaper.title.slice(0, 24)}》（${formatDate(lastPaper.addedAt)}）`);

    return {
      projectId,
      generatedAt: Date.now(),
      lastActivityAt,
      openTasks,
      runningTasks,
      lastCompletedTask,
      lastRunStatus: lastRun?.status ?? null,
      lastRunAt: lastRun?.updatedAt ?? null,
      artifactCount: artifacts.length,
      lastArtifactTitle: lastArtifact?.title ?? null,
      lastArtifactAt: lastArtifact?.at ?? null,
      paperCount: papers.length,
      lastPaperTitle: lastPaper?.title ?? null,
      summaryText: parts.length > 0 ? parts.join('；') + '。' : '还没有研究活动记录。',
    };
  }
}

function runStatusLabel(status: string): string {
  switch (status) {
    case 'running': return '进行中';
    case 'completed': return '已完成';
    case 'failed': return '失败';
    case 'paused': return '已暂停';
    default: return status;
  }
}

function formatDate(ts: number): string {
  const d = new Date(ts);
  const now = Date.now();
  const days = Math.floor((now - ts) / 86_400_000);
  if (days <= 0) return '今天';
  if (days === 1) return '昨天';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
