/**
 * Research Project Board — multi-project management engine.
 *
 * Manages research projects with status, deadlines, and progress tracking.
 * Each project can contain experiments, papers, and notes.
 */

// ─── Types ──────────────────────────────────────────────────

export type ProjectStatus = 'planning' | 'active' | 'writing' | 'submitted' | 'archived';

export interface ResearchProject {
  id: string;
  name: string;
  description: string;
  status: ProjectStatus;
  deadline?: number;
  createdAt: number;
  updatedAt: number;
  experimentIds: string[];
  paperIds: string[];
  noteIds: string[];
  progress: number; // 0-100
  venue?: string;
}

export interface ProjectBoardStats {
  total: number;
  active: number;
  overdue: number;
  byStatus: Record<ProjectStatus, number>;
  overallProgress: number;
}

// ─── Project Board ─────────────────────────────────────────

export class ResearchProjectBoard {
  private projects = new Map<string, ResearchProject>();

  /** Create a new research project. */
  create(name: string, description: string, options?: {
    deadline?: number;
    venue?: string;
  }): ResearchProject {
    const id = `proj-${Date.now()}`;
    const project: ResearchProject = {
      id, name, description,
      status: 'planning',
      deadline: options?.deadline,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      experimentIds: [],
      paperIds: [],
      noteIds: [],
      progress: 0,
      venue: options?.venue,
    };
    this.projects.set(id, project);
    return project;
  }

  /** Get a project by ID. */
  get(id: string): ResearchProject | undefined {
    return this.projects.get(id);
  }

  /** List all projects, optionally filtered by status. */
  list(status?: ProjectStatus): ResearchProject[] {
    const all = [...this.projects.values()];
    return status ? all.filter((p) => p.status === status) : all;
  }

  /** Update project status. */
  setStatus(id: string, status: ProjectStatus): boolean {
    const p = this.projects.get(id);
    if (!p) return false;
    p.status = status;
    p.updatedAt = Date.now();
    return true;
  }

  /** Link an experiment to a project. */
  linkExperiment(projectId: string, experimentId: string): boolean {
    const p = this.projects.get(projectId);
    if (!p) return false;
    if (!p.experimentIds.includes(experimentId)) {
      p.experimentIds.push(experimentId);
      p.updatedAt = Date.now();
    }
    return true;
  }

  /** Link a paper to a project. */
  linkPaper(projectId: string, paperId: string): boolean {
    const p = this.projects.get(projectId);
    if (!p) return false;
    if (!p.paperIds.includes(paperId)) {
      p.paperIds.push(paperId);
      p.updatedAt = Date.now();
    }
    return true;
  }

  /** Compute progress based on linked items. */
  computeProgress(id: string): number {
    const p = this.projects.get(id);
    if (!p) return 0;
    const total = p.experimentIds.length + p.paperIds.length;
    if (total === 0) return p.status === 'submitted' ? 100 : p.status === 'writing' ? 50 : 10;
    // Simple heuristic: experiments = 60% weight, papers = 40% weight
    const expWeight = Math.min(p.experimentIds.length * 20, 60);
    const paperWeight = Math.min(p.paperIds.length * 10, 40);
    p.progress = Math.min(100, expWeight + paperWeight);
    return p.progress;
  }

  /** Get board statistics. */
  stats(): ProjectBoardStats {
    const all = [...this.projects.values()];
    const now = Date.now();
    const byStatus: Record<ProjectStatus, number> = { planning: 0, active: 0, writing: 0, submitted: 0, archived: 0 };

    let activeCount = 0;
    let overdueCount = 0;
    let totalProgress = 0;

    for (const p of all) {
      byStatus[p.status]++;
      if (p.status === 'active' || p.status === 'writing') activeCount++;
      if (p.deadline && p.deadline < now && p.status !== 'submitted' && p.status !== 'archived') {
        overdueCount++;
      }
      totalProgress += this.computeProgress(p.id);
    }

    return {
      total: all.length,
      active: activeCount,
      overdue: overdueCount,
      byStatus,
      overallProgress: all.length > 0 ? Math.round(totalProgress / all.length) : 0,
    };
  }

  /** Format board as markdown. */
  formatBoard(): string {
    const s = this.stats();
    const projects = this.list();
    const lines: string[] = [
      '# Research Project Board',
      '',
      `**Projects**: ${s.total} | **Active**: ${s.active} | **Overdue**: [警告] ${s.overdue} | **Progress**: ${s.overallProgress}%`,
      '',
      '| Project | Status | Progress | Deadline | Venue |',
      '|---------|--------|----------|----------|-------|',
    ];

    for (const p of projects) {
      const statusIcon = p.status === 'submitted' ? '[通过]' : p.status === 'active' ? '[正常]' : p.status === 'writing' ? '[写作]' : p.status === 'planning' ? '[计划]' : '[归档]';
      const deadlineStr = p.deadline ? new Date(p.deadline).toLocaleDateString('zh-CN') : '—';
      const overdue = p.deadline && p.deadline < Date.now() && p.status !== 'submitted' ? ' [警告]' : '';
      lines.push(`| ${p.name} | ${statusIcon} ${p.status} | ${p.progress}% | ${deadlineStr}${overdue} | ${p.venue ?? '—'} |`);
    }

    if (projects.length === 0) {
      lines.push('| — | — | — | — | — |');
      lines.push('', '*No projects yet. Create your first research project!*');
    }

    return lines.join('\n');
  }
}

// ─── Singleton ─────────────────────────────────────────────

let _instance: ResearchProjectBoard | null = null;

export function getResearchProjectBoard(): ResearchProjectBoard {
  if (!_instance) _instance = new ResearchProjectBoard();
  return _instance;
}
