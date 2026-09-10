/** Durable project/run bridge for the autonomous research engine. */

import { createHash, randomUUID } from 'node:crypto';
import type { ArtifactManifest } from '../artifacts/ArtifactManifest.js';
import type { ResearchRepository } from '../persistence/ResearchRepository.js';
import type { Project, ResearchRun } from '../persistence/researchModel.js';
import type {
  AutonomousPhaseArtifactInput,
  AutonomousResearchArtifactSink,
} from './AutonomousResearchEngine.js';
import type { ResearchEvent } from './ResearchEventBus.js';

export interface EnsureAutonomousProjectOptions {
  goal: string;
  requestedProjectId?: string;
  generateId?: () => string;
  now?: () => number;
}

export interface AutonomousProjectResolution {
  projectId: string;
  created: boolean;
}

/**
 * Resolve the project context without an approval stop. If the researcher did
 * not choose a project, create an explicit exploration sandbox that appears in
 * the normal project workspace and can later be renamed or merged.
 */
export function ensureAutonomousResearchProject(
  repository: ResearchRepository,
  options: EnsureAutonomousProjectOptions,
): AutonomousProjectResolution | undefined {
  if (options.requestedProjectId) {
    return repository.getProject(options.requestedProjectId)
      ? { projectId: options.requestedProjectId, created: false }
      : undefined;
  }

  const goal = String(options.goal ?? '').trim();
  if (!goal) return undefined;
  const now = options.now?.() ?? Date.now();
  const projectId = options.generateId?.() ?? `project-auto-${randomUUID()}`;
  const title = goal.length > 48 ? `${goal.slice(0, 48)}…` : goal;
  const project: Project = {
    id: projectId,
    title,
    originalIntent: goal,
    researchQuestion: goal,
    lifecycle: 'running',
    methodology: '自动选择中',
    discipline: '人文社会科学',
    metadata: {
      explorationSandbox: true,
      createdBy: 'autonomous_research',
    },
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    version: 1,
    source: 'autonomous_research',
    deletedAt: null,
  };
  repository.createProject(project);
  return { projectId, created: true };
}

export function beginAutonomousResearchRun(
  repository: ResearchRepository,
  options: { sessionId: string; projectId: string; goal: string; now?: () => number },
): ResearchRun {
  if (!repository.getProject(options.projectId)) {
    throw new Error(`Project '${options.projectId}' does not exist`);
  }
  const now = options.now?.() ?? Date.now();
  return repository.saveRun({
    id: options.sessionId,
    projectId: options.projectId,
    status: 'running',
    plan: {
      goal: options.goal,
      source: 'autonomous_research',
      phases: [],
    },
    providerProfile: {},
    currentStepId: null,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    deletedAt: null,
  });
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === 'string' && item.length > 0))]
    : [];
}

function recordValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function phaseArtifactId(sessionId: string, phase: string): string {
  const digest = createHash('sha256').update(`${sessionId}\u0000${phase}`).digest('hex').slice(0, 32);
  return `auto-artifact-${digest}`;
}

function autonomousArtifactIds(
  repository: ResearchRepository,
  sessionId: string,
  projectId: string,
): string[] {
  const run = repository.getRun(sessionId, true);
  const fromRun = run?.projectId === projectId ? stringArray(run.plan.artifactIds) : [];
  const codeRef = `autonomous-session:${sessionId}`;
  const discovered = repository.listArtifacts(projectId, true)
    .filter((artifact) => recordValue(artifact.provenance.generatedBy).codeRef === codeRef)
    .map((artifact) => artifact.id);
  return [...new Set([...fromRun, ...discovered])]
    .filter((id) => repository.getArtifact(id)?.projectId === projectId);
}

/**
 * Persist each completed autonomous phase as a normal versioned research
 * artifact. Re-executing a phase creates a new immutable version under the
 * same artifact id, while preceding phase artifacts become explicit inputs.
 */
export function createAutonomousResearchArtifactSink(
  repository: ResearchRepository,
  nowProvider: () => number = () => Date.now(),
): AutonomousResearchArtifactSink {
  return {
    persistPhaseOutput(input: AutonomousPhaseArtifactInput): string {
      const run = repository.getRun(input.sessionId, true);
      if (!run || run.projectId !== input.projectId) {
        throw new Error(`Research run '${input.sessionId}' is unavailable for artifact persistence`);
      }
      const output = String(input.output ?? '').trim();
      if (!output) throw new Error(`Research phase '${input.phase}' produced no persistable output`);

      const id = phaseArtifactId(input.sessionId, input.phase);
      const existing = repository.getArtifact(id, true);
      if (existing && existing.projectId !== input.projectId) {
        throw new Error(`Artifact '${id}' belongs to another project`);
      }
      const existingIds = autonomousArtifactIds(repository, input.sessionId, input.projectId)
        .filter((artifactId) => artifactId !== id);
      const now = nowProvider();
      const isManuscript = input.phase === 'writing' || input.phase === 'paper';
      const title = isManuscript
        ? `自主科研成果：${input.goal.slice(0, 60)}`
        : `${input.phaseName}｜自主科研阶段成果`;
      const manifest: ArtifactManifest = {
        id,
        projectId: input.projectId,
        title,
        artifactType: isManuscript ? 'manuscript' : 'report',
        reviewStatus: 'draft',
        inputs: existingIds.map((artifactId) => ({ kind: 'previous_artifact' as const, id: artifactId })),
        generatedBy: {
          capabilityId: 'autonomous_research',
          method: input.methodSpec?.name ?? input.phaseName,
          codeRef: `autonomous-session:${input.sessionId}`,
          promptHash: createHash('sha256')
            .update(JSON.stringify([input.goal, input.phase, input.iteration, existingIds]))
            .digest('hex'),
        },
        citedSourceIds: [],
        renderer: { kind: 'markdown' },
        inputHash: createHash('sha256')
          .update(JSON.stringify([input.goal, input.phase, existingIds]))
          .digest('hex'),
        reviewTrail: [],
        version: existing?.version ?? 1,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };

      const latest = repository.getArtifactVersion(id);
      const savedVersion = latest?.content === output
        ? latest
        : repository.saveArtifactVersion(manifest, output, { createdBy: 'ai' });
      if (!savedVersion) throw new Error(`Artifact '${id}' has no durable version`);

      const refreshedRun = repository.getRun(input.sessionId, true);
      if (!refreshedRun || refreshedRun.projectId !== input.projectId) {
        throw new Error(`Research run '${input.sessionId}' disappeared during artifact persistence`);
      }
      const artifactIds = [...new Set([...stringArray(refreshedRun.plan.artifactIds), id])];
      const phaseArtifacts = {
        ...recordValue(refreshedRun.plan.phaseArtifacts),
        [input.phase]: { artifactId: id, version: savedVersion.version, phaseName: input.phaseName },
      };
      repository.saveRun({
        ...refreshedRun,
        plan: { ...refreshedRun.plan, artifactIds, phaseArtifacts },
        updatedAt: now,
      });
      return id;
    },

    listArtifactIds(sessionId: string, projectId: string): string[] {
      return autonomousArtifactIds(repository, sessionId, projectId);
    },

    finalizeRun(sessionId: string, projectId: string, summary: string, artifactIds: string[]): void {
      const run = repository.getRun(sessionId, true);
      if (!run || run.projectId !== projectId) {
        throw new Error(`Research run '${sessionId}' is unavailable for completion`);
      }
      const durableArtifactIds = [...new Set(artifactIds)].filter((artifactId) => (
        repository.getArtifact(artifactId)?.projectId === projectId
      ));
      if (durableArtifactIds.length !== new Set(artifactIds).size) {
        throw new Error(`Research run '${sessionId}' references a missing artifact`);
      }
      const now = nowProvider();
      repository.saveRun({
        ...run,
        status: 'completed',
        currentStepId: null,
        completedAt: now,
        updatedAt: now,
        plan: { ...run.plan, summary, artifactIds: durableArtifactIds },
      });
    },
  };
}

/** Mirror authoritative engine transitions into the unified durable run. */
export function applyAutonomousResearchEvent(
  repository: ResearchRepository,
  projectId: string,
  event: ResearchEvent,
  nowProvider: () => number = () => Date.now(),
): ResearchRun | undefined {
  const current = repository.getRun(event.sessionId, true);
  if (!current || current.projectId !== projectId) return undefined;
  const now = nowProvider();
  let next: ResearchRun = { ...current, updatedAt: now };

  switch (event.type) {
    case 'engine-started': {
      next = {
        ...next,
        status: 'running',
        plan: {
          ...current.plan,
          goal: event.goal,
          phases: event.plan,
          ...(event.method ? { method: event.method } : {}),
        },
        currentStepId: null,
        completedAt: null,
      };
      if (event.method) {
        const project = repository.getProject(projectId);
        if (project) {
          repository.updateProject(projectId, {
            methodology: event.method.name,
            metadata: {
              autonomousMethod: event.method,
              lastAutonomousSessionId: event.sessionId,
            },
          });
        }
      }
      break;
    }
    case 'phase-started':
      next = {
        ...next,
        status: 'running',
        currentStepId: event.phase,
        plan: {
          ...current.plan,
          currentPhase: event.phase,
          currentPhaseName: event.phaseName,
          currentPhaseIteration: event.phaseIteration,
        },
      };
      break;
    case 'step-start':
    case 'step-complete':
    case 'step-failed':
      next = { ...next, currentStepId: `${event.phase}:${event.stepId}` };
      break;
    case 'reflection':
      next = {
        ...next,
        plan: {
          ...current.plan,
          lastReflection: {
            phase: event.phase,
            decision: event.decision,
            qualityScore: event.qualityScore,
            reasoning: event.reasoning,
            ...(event.nextPhase ? { nextPhase: event.nextPhase } : {}),
            ...(event.revisionNote ? { revisionNote: event.revisionNote } : {}),
          },
        },
      };
      break;
    case 'engine-paused':
      next = { ...next, status: 'paused', plan: { ...current.plan, pauseReason: event.reason } };
      break;
    case 'engine-resumed':
      next = { ...next, status: 'running', completedAt: null };
      break;
    case 'engine-interrupted':
      next = {
        ...next,
        status: 'cancelled',
        completedAt: now,
        plan: { ...current.plan, interruptionReason: event.reason },
      };
      break;
    case 'engine-failed':
      next = {
        ...next,
        status: 'failed',
        completedAt: null,
        plan: {
          ...current.plan,
          failureReason: event.reason,
          completedPhases: event.completedPhases,
          recoverable: event.recoverable,
        },
      };
      break;
    case 'engine-completed':
      next = {
        ...next,
        status: 'completed',
        currentStepId: null,
        completedAt: now,
        plan: {
          ...current.plan,
          summary: event.summary,
          artifactIds: [...new Set([...stringArray(current.plan.artifactIds), ...event.artifactIds])],
        },
      };
      break;
    case 'progress':
      next = {
        ...next,
        plan: {
          ...current.plan,
          completedPhases: event.completedPhases,
          totalPhases: event.totalPhases,
          currentPhase: event.currentPhase,
        },
      };
      break;
  }

  return repository.saveRun(next);
}
