/**
 * ResearchEventBus — publish/subscribe bus for the autonomous research loop.
 *
 * Decouples the AutonomousResearchEngine (the producer of phase/step/reflection
 * events) from its consumers:
 *   1. main process → forwards events to the renderer over IPC
 *   2. LearningEngine → ingests durable knowledge from autonomous output
 *   3. PersistenceStore → writes phase checkpoints (resume support)
 *
 * The bus is synchronous and in-process; cross-process transport is the
 * consumer's responsibility (the IPC forwarder validates every payload through
 * the AutonomousRuntimeContract schema before sending).
 */

import type { ResearchPhaseKind } from '../runtime/AutonomousRuntimeContract.js';

// ─── Event payloads ───────────────────────────────────────────

export interface EngineStartedEvent {
  type: 'engine-started';
  sessionId: string;
  goal: string;
  plan: Array<{ phase: ResearchPhaseKind; name: string }>;
  method?: {
    family: 'theoretical' | 'qualitative' | 'historical' | 'quantitative' | 'mixed' | 'general';
    name: string;
    rationale: string;
    confidence: number;
    selectedBy: 'automatic_heuristic' | 'automatic_provider' | 'researcher';
  };
}

export interface PhaseStartedEvent {
  type: 'phase-started';
  sessionId: string;
  phase: ResearchPhaseKind;
  phaseIteration: number;
  phaseName: string;
}

export interface StepLifecycleEvent {
  type: 'step-start' | 'step-complete' | 'step-failed';
  sessionId: string;
  phase: ResearchPhaseKind;
  stepId: string;
  stepName: string;
  output?: string;
  error?: string;
}

export interface ReflectionEvent {
  type: 'reflection';
  sessionId: string;
  phase: ResearchPhaseKind;
  decision: 'advance' | 'redo' | 'rollback' | 'done';
  nextPhase?: ResearchPhaseKind;
  qualityScore: number;
  reasoning: string;
  revisionNote?: string;
}

export interface ProgressEvent {
  type: 'progress';
  sessionId: string;
  completedPhases: number;
  totalPhases: number;
  currentPhase: ResearchPhaseKind;
}

export interface EngineCompletedEvent {
  type: 'engine-completed';
  sessionId: string;
  summary: string;
  artifactIds: string[];
}

export interface EngineFailedEvent {
  type: 'engine-failed';
  sessionId: string;
  reason: string;
  completedPhases: number;
  recoverable: boolean;
}

export interface EngineInterruptedEvent {
  type: 'engine-interrupted';
  sessionId: string;
  reason: string;
}

export interface EnginePausedEvent {
  type: 'engine-paused';
  sessionId: string;
  reason: string;
}

export interface EngineResumedEvent {
  type: 'engine-resumed';
  sessionId: string;
  completedPhases: number;
}

export type ResearchEvent =
  | EngineStartedEvent
  | PhaseStartedEvent
  | StepLifecycleEvent
  | ReflectionEvent
  | ProgressEvent
  | EngineCompletedEvent
  | EngineFailedEvent
  | EngineInterruptedEvent
  | EnginePausedEvent
  | EngineResumedEvent;

export type ResearchEventListener = (event: ResearchEvent) => void;

// ─── Bus ──────────────────────────────────────────────────────

export class ResearchEventBus {
  private readonly listeners = new Set<ResearchEventListener>();

  /** Subscribe to every event. Returns an unsubscribe function. */
  subscribe(listener: ResearchEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Emit an event to every subscriber synchronously. */
  emit(event: ResearchEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        // An observer failing must never break the research loop.
        console.error('[ResearchEventBus] listener error:', err);
      }
    }
  }

  /** Test helper: emit and collect what subscribers saw. */
  get listenerCount(): number {
    return this.listeners.size;
  }
}
