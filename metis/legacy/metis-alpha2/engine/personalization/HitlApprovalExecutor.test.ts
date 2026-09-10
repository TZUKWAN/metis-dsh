/**
 * Tests for hitlApprovalExecutor — human-in-the-loop step gate.
 */

import { describe, it, expect, vi } from 'vitest';
import { hitlApprovalExecutor, type HitlApprovalResult } from './HitlApprovalExecutor.js';
import type { ScenarioStepExecutionInput } from './ScenarioRunCoordinator.js';

function makeInput(overrides: Record<string, unknown> = {}): ScenarioStepExecutionInput {
  return {
    runId: 'run-1',
    executionKey: 'key-1',
    sessionId: 'sess-1',
    projectId: 'proj-1',
    scenarioId: 'scn-1',
    manifestDigest: 'd'.repeat(64),
    step: {
      id: 'step-1', name: 'step', description: '', agentId: 'agent-1',
      skillIds: [], toolIds: [], mcpIds: [], dependsOn: [], maxTurns: 3,
      ...overrides,
    } as unknown as ScenarioStepExecutionInput['step'],
    dependencyOutputs: {},
  };
}

describe('hitlApprovalExecutor', () => {
  it('runs the producer when approval is not required', async () => {
    const producer = vi.fn(async () => ({ ok: true, output: 'done' }));
    const onApprovalRequired = vi.fn(async () => true);
    const exec = hitlApprovalExecutor(producer, { onApprovalRequired });
    const result = await exec(makeInput()) as HitlApprovalResult;
    expect(result.ok).toBe(true);
    expect(producer).toHaveBeenCalled();
    expect(onApprovalRequired).not.toHaveBeenCalled();
  });

  it('asks for approval and runs the producer when approved', async () => {
    const producer = vi.fn(async () => ({ ok: true, output: 'done' }));
    const onApprovalRequired = vi.fn(async () => true);
    const exec = hitlApprovalExecutor(producer, { onApprovalRequired });
    const result = await exec(makeInput({ hitl: { requireApproval: true } })) as HitlApprovalResult;
    expect(result.ok).toBe(true);
    expect(onApprovalRequired).toHaveBeenCalledTimes(1);
    expect(producer).toHaveBeenCalledTimes(1);
  });

  it('denies the step without running the producer when approval is rejected', async () => {
    const producer = vi.fn(async () => ({ ok: true, output: 'done' }));
    const onApprovalRequired = vi.fn(async () => false);
    const exec = hitlApprovalExecutor(producer, { onApprovalRequired });
    const result = await exec(makeInput({ hitl: { requireApproval: true } })) as HitlApprovalResult;
    expect(result.ok).toBe(false);
    expect(result.code).toBe('denied_by_user');
    expect(producer).not.toHaveBeenCalled();
  });

  it('fails closed when the approval hook throws', async () => {
    const producer = vi.fn(async () => ({ ok: true, output: 'done' }));
    const onApprovalRequired = vi.fn(async () => { throw new Error('approval ui crashed'); });
    const exec = hitlApprovalExecutor(producer, { onApprovalRequired });
    const result = await exec(makeInput({ hitl: { requireApproval: true } })) as HitlApprovalResult;
    expect(result.ok).toBe(false);
    expect(result.code).toBe('denied_by_user');
    expect(producer).not.toHaveBeenCalled();
  });

  it('honors a custom requiresApproval predicate', async () => {
    const producer = vi.fn(async () => ({ ok: true }));
    const onApprovalRequired = vi.fn(async () => true);
    const requiresApproval = (step: ScenarioStepExecutionInput['step']) => step.id.startsWith('sensitive-');
    const exec = hitlApprovalExecutor(producer, { onApprovalRequired, requiresApproval });
    await exec(makeInput({ id: 'sensitive-1' }));
    expect(onApprovalRequired).toHaveBeenCalledTimes(1);
    await exec(makeInput({ id: 'plain-1' }));
    expect(onApprovalRequired).toHaveBeenCalledTimes(1);
    expect(producer).toHaveBeenCalledTimes(2);
  });
});
