/**
 * Tests for qaReviewExecutor — independent quality-gate step wrapper.
 */

import { describe, it, expect, vi } from 'vitest';
import { qaReviewExecutor, type QaReviewResult } from './QAReviewExecutor.js';
import type { ScenarioStepExecutionInput } from './ScenarioRunCoordinator.js';

const baseInput: ScenarioStepExecutionInput = {
  runId: 'run-1',
  executionKey: 'key-1',
  sessionId: 'sess-1',
  projectId: 'proj-1',
  scenarioId: 'scn-1',
  manifestDigest: 'd'.repeat(64),
  step: { id: 'step-1', name: 'step', description: '', agentId: 'agent-1', skillIds: [], toolIds: [], mcpIds: [], dependsOn: [], maxTurns: 3, qualityCriteria: ['must cite a source', 'must be under 1000 words'] } as unknown as ScenarioStepExecutionInput['step'],
  dependencyOutputs: {},
};

describe('qaReviewExecutor', () => {
  it('passes through to ok when the reviewer approves', async () => {
    const producer = async () => ({ ok: true, output: { text: 'draft' } });
    const reviewer = vi.fn(async () => ({ passed: true, failures: [] }));
    const exec = qaReviewExecutor(producer, { reviewer });
    const result = await exec(baseInput) as QaReviewResult;
    expect(result.ok).toBe(true);
    expect(result.verdict.passed).toBe(true);
    expect(reviewer).toHaveBeenCalled();
  });

  it('fails the step when the reviewer rejects and blockOnFailure is true', async () => {
    const producer = async () => ({ ok: true, output: { text: 'draft' } });
    const reviewer = async () => ({ passed: false, failures: ['no citation found'] });
    const exec = qaReviewExecutor(producer, { reviewer });
    const result = await exec(baseInput) as QaReviewResult;
    expect(result.ok).toBe(false);
    expect(result.verdict.failures).toEqual(['no citation found']);
  });

  it('records output but stays ok when blockOnFailure is false', async () => {
    const producer = async () => ({ ok: true, output: { text: 'draft' } });
    const reviewer = async () => ({ passed: false, failures: ['weak'] });
    const exec = qaReviewExecutor(producer, { reviewer, blockOnFailure: false });
    const result = await exec(baseInput) as QaReviewResult;
    expect(result.ok).toBe(true);
    expect(result.verdict.passed).toBe(false);
    expect(result.output).toMatchObject({ text: 'draft' });
  });

  it('short-circuits without review when the producer fails', async () => {
    const producer = async () => ({ ok: false, code: 'producer_error', message: 'boom' });
    const reviewer = vi.fn(async () => ({ passed: true, failures: [] }));
    const exec = qaReviewExecutor(producer, { reviewer });
    const result = await exec(baseInput) as QaReviewResult;
    expect(result.ok).toBe(false);
    expect(result.verdict.passed).toBe(false);
    expect(reviewer).not.toHaveBeenCalled();
  });

  it('forwards the step quality criteria to the reviewer by default', async () => {
    const producer = async () => ({ ok: true, output: 'draft' });
    const captured: string[] = [];
    const reviewer = async ({ qualityCriteria }: { qualityCriteria: readonly string[] }) => {
      captured.push(...qualityCriteria);
      return { passed: true, failures: [] };
    };
    await qaReviewExecutor(producer, { reviewer })(baseInput);
    expect(captured).toEqual(['must cite a source', 'must be under 1000 words']);
  });

  it('uses explicit criteria when provided, overriding the step snapshot', async () => {
    const producer = async () => ({ ok: true, output: 'draft' });
    const captured: string[] = [];
    const reviewer = async ({ qualityCriteria }: { qualityCriteria: readonly string[] }) => {
      captured.push(...qualityCriteria);
      return { passed: true, failures: [] };
    };
    await qaReviewExecutor(producer, { reviewer, qualityCriteria: ['custom criterion'] })(baseInput);
    expect(captured).toEqual(['custom criterion']);
  });
});
