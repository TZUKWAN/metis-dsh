/**
 * One-Sentence Project Creation (METIS-307).
 *
 * After the user configures their API (METIS-301), they can start research by typing a
 * single sentence. This module turns that sentence into a real Project record — preserving
 * the original intent verbatim — and routes it into the research lifecycle (METIS-102):
 * classify the intent (METIS-204), decide whether to clarify or plan, and return the
 * initial plan-state. The user never deals with project fields, templates, or file layout.
 */

import { routeIntent, type RoutingResult } from '../routing/CapabilityRouter.js';
import type { ResearchLifecycle } from '../core/types.js';

export interface QuickStartProject {
  id: string;
  title: string;
  /** The user's original one-sentence intent, preserved verbatim (METIS-307). */
  originalIntent: string;
  createdAt: number;
  /** Initial lifecycle state — always starts at draft (METIS-102). */
  lifecycle: ResearchLifecycle;
  /** What the router detected (research type, primary capability, confidence). */
  routing: RoutingResult;
  /** Whether the intent was clear enough to plan, or needs clarification first. */
  nextAction: { kind: 'clarify'; question: string } | { kind: 'plan'; reason: string };
}

export interface QuickStartOptions {
  /** Injected id generator so tests are deterministic. */
  generateId?: () => string;
  /** Injected clock for deterministic createdAt. */
  now?: () => number;
}

/**
 * Create a project from a single sentence. Does NOT throw — returns a structured result.
 * If the sentence is empty, it returns a project with a clarify action (the user must say
 * something).
 */
export function createProjectFromIntent(
  sentence: string,
  opts: QuickStartOptions = {},
): QuickStartProject {
  const intent = sentence.trim();
  const generateId = opts.generateId ?? (() => `proj_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`);
  const now = opts.now ?? (() => Date.now());

  const routing = routeIntent(intent.length > 0 ? intent : ' '); // router handles empty gracefully

  // Derive a short title from the intent (first ~30 chars), never exposing internal concepts.
  const titleBase = intent.length > 0 ? intent : '新研究项目';
  const title = titleBase.length > 30 ? titleBase.slice(0, 30) + '…' : titleBase;

  // Decide next action: if the router is confident, go straight to plan; otherwise clarify.
  const nextAction: QuickStartProject['nextAction'] =
    routing.classification.confidence >= 0.5 && intent.length > 0
      ? { kind: 'plan', reason: `意图较明确（${routing.classification.researchType}），可生成研究计划。` }
      : {
          kind: 'clarify',
          question: routing.classification.clarificationNeeded ?? '请补充您最主要的研究方向，以便 Metis 选择合适的研究路径。',
        };

  return {
    id: generateId(),
    title,
    originalIntent: intent,
    createdAt: now(),
    lifecycle: 'draft',
    routing,
    nextAction,
  };
}
