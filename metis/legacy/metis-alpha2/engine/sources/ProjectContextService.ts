/**
 * Unified Project Context Service (METIS-406).
 *
 * The single source of truth for a project's working state, shared across all four modes
 * (converse / read / analyze / write). Centralizes: research question, methodology, the
 * material set, recent decisions, the current task, and produced artifacts. This is what
 * ContextPack (METIS-205) renders into a bounded prompt — the user never re-explains project
 * background or re-uploads materials when switching modes (METIS-406 completion).
 */

import type { Project, ResearchArtifact } from '../persistence/researchModel.js';

export interface DecisionEntry {
  id: string;
  text: string;
  at: number;
  context?: string;
}

export interface TaskEntry {
  id: string;
  description: string;
  status: 'pending' | 'in_progress' | 'done';
  createdAt: number;
}

export interface ProjectContextState {
  project: Project;
  researchQuestion: string;
  methodology: string;
  /** Active material source ids (the working set, not the whole library). */
  activeSourceIds: string[];
  recentDecisions: DecisionEntry[];
  currentTask: TaskEntry | null;
  artifactIds: string[];
  updatedAt: number;
}

export interface ProjectContextStore {
  load(projectId: string): ProjectContextState | undefined;
  save(state: ProjectContextState): void;
  getProject(projectId: string): Project | undefined;
  listArtifacts(projectId: string): ResearchArtifact[];
}

export class ProjectContextService {
  private readonly store: ProjectContextStore;
  constructor(store: ProjectContextStore) {
    this.store = store;
  }

  /** Initialize a context for a new project (or return existing). */
  init(project: Project): ProjectContextState {
    const existing = this.store.load(project.id);
    if (existing) return existing;
    const state: ProjectContextState = {
      project,
      researchQuestion: project.researchQuestion,
      methodology: project.methodology,
      activeSourceIds: [],
      recentDecisions: [],
      currentTask: null,
      artifactIds: [],
      updatedAt: Date.now(),
    };
    this.store.save(state);
    return state;
  }

  get(projectId: string): ProjectContextState | undefined {
    return this.store.load(projectId);
  }

  /** Update the research question (shared across all modes). */
  setResearchQuestion(projectId: string, question: string): void {
    this.mutate(projectId, (s) => { s.researchQuestion = question; });
  }

  setMethodology(projectId: string, methodology: string): void {
    this.mutate(projectId, (s) => { s.methodology = methodology; });
  }

  /** Add a source to the active working set. */
  activateSource(projectId: string, sourceId: string): void {
    this.mutate(projectId, (s) => {
      if (!s.activeSourceIds.includes(sourceId)) s.activeSourceIds.push(sourceId);
    });
  }

  /** Record a decision (shared across modes, used by ContextPack METIS-205). */
  recordDecision(projectId: string, decision: DecisionEntry): void {
    this.mutate(projectId, (s) => {
      s.recentDecisions.unshift(decision); // newest first
      s.recentDecisions = s.recentDecisions.slice(0, 20); // bounded working memory
    });
  }

  /** Set the current task (the thing the user is actively working on right now). */
  setCurrentTask(projectId: string, task: TaskEntry): void {
    this.mutate(projectId, (s) => { s.currentTask = task; });
  }

  /** Link a produced artifact into the context. */
  registerArtifact(projectId: string, artifactId: string): void {
    this.mutate(projectId, (s) => {
      if (!s.artifactIds.includes(artifactId)) s.artifactIds.push(artifactId);
    });
  }

  /**
   * Continuity check: when the user switches modes (read→write, analyze→converse), the
   * context survives. This returns whether the context has the minimum state for the target
   * mode to proceed without re-explaining (METIS-406 completion: "switching does not lose
   * draft or current reading position").
   */
  hasContinuityFor(projectId: string, mode: 'converse' | 'read' | 'analyze' | 'write'): boolean {
    const s = this.store.load(projectId);
    if (!s) return false;
    switch (mode) {
      case 'converse': return s.researchQuestion.length > 0;
      case 'read': return s.activeSourceIds.length > 0;
      case 'analyze': return s.activeSourceIds.length > 0;
      case 'write': return s.artifactIds.length > 0 || s.researchQuestion.length > 0;
    }
  }

  private mutate(projectId: string, fn: (s: ProjectContextState) => void): void {
    const s = this.store.load(projectId);
    if (!s) throw new Error(`No context for project ${projectId}; call init() first`);
    fn(s);
    s.updatedAt = Date.now();
    this.store.save(s);
  }
}
