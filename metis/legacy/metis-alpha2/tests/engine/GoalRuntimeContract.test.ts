import { describe, expect, it } from 'vitest';
import {
  GoalCreateRequestSchema,
  GoalIdRequestSchema,
  GoalRefineRequestSchema,
  GOAL_PLAN_LABEL,
  GOAL_PLAN_STEP_LABEL,
  GOAL_RUNTIME_LIMITS,
  GoalCreateResponseSchema,
  GoalExecutionResultSchema,
  GoalListResponseSchema,
  GoalPlanResponseSchema,
  GoalSummarySchema,
  GoalChangedEventSchema,
  decodeGoalChangedEvent,
  decodeGoalCreateResponse,
  decodeGoalExecutionResult,
  decodeGoalListResponse,
  decodeGoalPlanResponse,
  decodeGoalSummaryResponse,
  decodeGoalWorkflowResponse,
} from '../../engine/runtime/GoalRuntimeContract.js';

function makeGoalSummary(overrides: Record<string, unknown> = {}) {
  return {
    goalId: 'goal-1',
    label: '比较两组访谈资料',
    status: 'running',
    createdAt: 1,
    ...overrides,
  };
}

function makePlanResponse(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    goalId: 'goal-1',
    label: GOAL_PLAN_LABEL,
    steps: [
      { stepId: 'step-1', label: GOAL_PLAN_STEP_LABEL, ordinal: 1 },
      { stepId: 'step-2', label: GOAL_PLAN_STEP_LABEL, ordinal: 2 },
    ],
    ...overrides,
  };
}

describe('Goal request schemas', () => {
  it('accepts bounded user text and rejects unsafe IDs, controls, and extra keys', () => {
    expect(GoalCreateRequestSchema.safeParse({ description: 'Compare interviews' }).success).toBe(true);
    expect(GoalIdRequestSchema.safeParse({ goalId: 'goal-1' }).success).toBe(true);
    expect(GoalRefineRequestSchema.safeParse({ goalId: 'goal-1', feedback: 'Add coding step' }).success).toBe(true);

    expect(GoalCreateRequestSchema.safeParse({ description: 'bad\u0000text' }).success).toBe(false);
    expect(GoalIdRequestSchema.safeParse({ goalId: '"][data-secret=x]' }).success).toBe(false);
    expect(GoalRefineRequestSchema.safeParse({ goalId: 'goal-1', feedback: 'ok', extra: true }).success).toBe(false);
  });
});

describe('Goal create response contract', () => {
  it('accepts a strict create response and normalizes unknown status', () => {
    const valid = { success: true, goalId: 'goal-1', status: 'ready' };
    expect(GoalCreateResponseSchema.parse(valid)).toEqual(valid);

    const unknown = decodeGoalCreateResponse({
      success: true,
      goalId: 'goal-1',
      status: 'status-secret-marker',
    });
    expect(unknown).toEqual({ success: true, goalId: 'goal-1', status: 'unknown' });
    expect(JSON.stringify(unknown)).not.toContain('status-secret-marker');
  });

  it('returns fixed create recovery for malformed or over-specified inputs', () => {
    const invalidInputs = [
      { success: true, goalId: 'unsafe goal id', status: 'ready' },
      { success: true, goalId: 'goal-1', status: 'ready', description: 'create-secret-marker' },
      new Error('create-secret-marker'),
    ];

    for (const input of invalidInputs) {
      const decoded = decodeGoalCreateResponse(input);
      expect(decoded).toEqual({ success: false, code: 'goal_create_unavailable' });
      expect(JSON.stringify(decoded)).not.toContain('secret-marker');
    }
  });
});

describe('Goal summary and list contracts', () => {
  it('keeps only bounded presentation fields and normalizes status to unknown', () => {
    const parsed = GoalSummarySchema.parse(makeGoalSummary({
      status: { raw: 'summary-status-secret-marker' },
    }));

    expect(parsed).toEqual({
      goalId: 'goal-1',
      label: '比较两组访谈资料',
      status: 'unknown',
      createdAt: 1,
    });
    expect(JSON.stringify(parsed)).not.toContain('summary-status-secret-marker');
  });

  it('decodes a bounded Goal list and normalizes each status independently', () => {
    const input = {
      success: true,
      goals: [
        makeGoalSummary(),
        makeGoalSummary({ goalId: 'goal-2', label: '整理编码结果', status: 'new-status' }),
      ],
    };

    const decoded = decodeGoalListResponse(input);
    expect(decoded).toEqual({
      success: true,
      goals: [
        makeGoalSummary(),
        { goalId: 'goal-2', label: '整理编码结果', status: 'unknown', createdAt: 1 },
      ],
    });
    expect(GoalListResponseSchema.parse(decoded)).toEqual(decoded);
    expect(JSON.stringify(decoded)).not.toContain('new-status');
  });

  it('returns fixed summary/list recovery without reflecting invalid labels or extra fields', () => {
    const summary = decodeGoalSummaryResponse({
      success: true,
      goal: makeGoalSummary({ label: `summary-secret-marker\u0000` }),
    });
    const list = decodeGoalListResponse({
      success: true,
      goals: [makeGoalSummary({ context: 'list-secret-marker' })],
    });
    const oversized = decodeGoalListResponse({
      success: true,
      goals: Array.from(
        { length: GOAL_RUNTIME_LIMITS.goals + 1 },
        (_, index) => makeGoalSummary({ goalId: `goal-${index}` }),
      ),
    });

    expect(summary).toEqual({ success: false, code: 'goal_summary_unavailable' });
    expect(list).toEqual({ success: false, code: 'goal_list_unavailable', goals: [] });
    expect(oversized).toEqual({ success: false, code: 'goal_list_unavailable', goals: [] });
    expect(JSON.stringify([summary, list, oversized])).not.toContain('secret-marker');
  });
});

describe('Goal plan presentation contract', () => {
  it('accepts only safe IDs, fixed labels, and contiguous ordinals', () => {
    const plan = makePlanResponse();
    expect(GoalPlanResponseSchema.parse(plan)).toEqual(plan);
    expect(decodeGoalPlanResponse(plan)).toEqual(plan);

    const serialized = JSON.stringify(plan);
    expect(serialized).not.toContain('prompt');
    expect(serialized).not.toContain('tools');
    expect(serialized).not.toContain('reasoning');
  });

  it('rejects raw plan internals and never reflects them in recovery', () => {
    const rawFields = makePlanResponse({
      reasoning: 'reasoning-secret-marker',
      prompt: 'prompt-secret-marker',
      tools: ['tool-secret-marker'],
    });
    const rawStepFields = makePlanResponse({
      steps: [{
        stepId: 'step-1',
        label: GOAL_PLAN_STEP_LABEL,
        ordinal: 1,
        prompt: 'step-prompt-secret-marker',
        tools: ['step-tool-secret-marker'],
      }],
    });

    for (const input of [rawFields, rawStepFields]) {
      const decoded = decodeGoalPlanResponse(input);
      expect(decoded).toEqual({
        success: false,
        code: 'goal_plan_unavailable',
        label: GOAL_PLAN_LABEL,
        steps: [],
      });
      expect(JSON.stringify(decoded)).not.toContain('secret-marker');
    }
  });

  it('rejects attacker-controlled labels, duplicate IDs, bad ordinals, and oversized plans', () => {
    const invalidPlans = [
      makePlanResponse({ label: 'plan-secret-marker' }),
      makePlanResponse({
        steps: [{ stepId: 'step-1', label: 'step-secret-marker', ordinal: 1 }],
      }),
      makePlanResponse({
        steps: [
          { stepId: 'step-1', label: GOAL_PLAN_STEP_LABEL, ordinal: 1 },
          { stepId: 'step-1', label: GOAL_PLAN_STEP_LABEL, ordinal: 2 },
        ],
      }),
      makePlanResponse({
        steps: [{ stepId: 'step-1', label: GOAL_PLAN_STEP_LABEL, ordinal: 2 }],
      }),
      makePlanResponse({
        steps: Array.from(
          { length: GOAL_RUNTIME_LIMITS.steps + 1 },
          (_, index) => ({
            stepId: `step-${index + 1}`,
            label: GOAL_PLAN_STEP_LABEL,
            ordinal: index + 1,
          }),
        ),
      }),
    ];

    for (const input of invalidPlans) {
      const decoded = decodeGoalPlanResponse(input);
      expect(decoded).toEqual({
        success: false,
        code: 'goal_plan_unavailable',
        label: GOAL_PLAN_LABEL,
        steps: [],
      });
      expect(JSON.stringify(decoded)).not.toContain('secret-marker');
    }
  });
});

describe('Goal execution result contract', () => {
  it('accepts the minimal { success, code? } result shape', () => {
    const results = [
      { success: true },
      { success: true, code: 'completed' },
      { success: false },
      { success: false, code: 'paused' },
      { success: false, code: 'goal_not_ready' },
    ];

    for (const result of results) {
      expect(GoalExecutionResultSchema.parse(result)).toEqual(result);
      expect(decodeGoalExecutionResult(result)).toEqual(result);
    }
  });

  it('returns fixed execution recovery for unknown codes, contradictory states, and extra data', () => {
    const cyclic: Record<string, unknown> = { success: true };
    cyclic.self = cyclic;
    const invalidResults = [
      { success: false, code: 'execution-secret-marker' },
      { success: false, code: 'completed' },
      { success: true, code: 'failed' },
      { success: true, output: 'output-secret-marker' },
      cyclic,
    ];

    for (const input of invalidResults) {
      const decoded = decodeGoalExecutionResult(input);
      expect(decoded).toEqual({ success: false, code: 'goal_execution_unavailable' });
      expect(JSON.stringify(decoded)).not.toContain('secret-marker');
    }
  });
});

describe('GoalChangedEventSchema', () => {
  it('decodes a canonical changed event with priority', () => {
    const event = {
      goalId: 'goal-7',
      label: '整理实验数据',
      status: 'running',
      priority: 'high',
      createdAt: 42,
    };
    expect(GoalChangedEventSchema.parse(event)).toEqual(event);
    expect(decodeGoalChangedEvent(event)).toEqual(event);
  });

  it('decodes changed events without priority', () => {
    const event = {
      goalId: 'goal-7',
      label: '整理实验数据',
      status: 'paused',
      createdAt: 42,
    };
    expect(decodeGoalChangedEvent(event)).not.toBeUndefined();
    expect(decodeGoalChangedEvent(event)?.priority).toBeUndefined();
  });

  it('coerces unknown statuses and rejects empty labels and unknown keys', () => {
    const coerced = decodeGoalChangedEvent({
      goalId: 'goal-7',
      label: '整理实验数据',
      status: 'running-secret-marker',
      createdAt: 42,
    });
    expect(coerced?.status).toBe('unknown');
    expect(JSON.stringify(coerced)).not.toContain('secret-marker');
    expect(decodeGoalChangedEvent({
      goalId: 'goal-7',
      label: '',
      status: 'running',
      createdAt: 42,
    })).toBeUndefined();
    expect(decodeGoalChangedEvent({
      goalId: 'goal-7',
      label: '整理实验数据',
      status: 'running',
      createdAt: 42,
      secret: 'secret-marker',
    })).toBeUndefined();
  });
});

describe('Goal workflow view contract (O17)', () => {
  function makeWorkflowView(overrides: Record<string, unknown> = {}) {
    return {
      success: true as const,
      goalId: 'goal-1',
      workflow: {
        id: 'wf-1',
        name: '文献综述工作流',
        description: '描述',
        version: '1',
        steps: [
          {
            id: 'step-a',
            name: '检索文献',
            description: '检索相关文献',
            prompt: '检索近五年文献',
            tools: ['search_papers'],
            maxTurns: 3,
          },
          {
            id: 'step-b',
            name: '综合归纳',
            description: '归纳发现',
            prompt: '对检索结果做归纳',
            tools: [],
            maxTurns: 2,
            acceptanceCriteria: ['输出不少于 200 字 (minLength: 200)'],
          },
        ],
        dependencies: { 'step-b': ['step-a'] },
      },
      stepResults: {
        'step-a': { status: 'completed', output: '完成', retryCount: 0 },
      },
      ...overrides,
    };
  }

  it('accepts a well-formed workflow view', () => {
    const decoded = decodeGoalWorkflowResponse(makeWorkflowView());
    expect(decoded.success).toBe(true);
    if (decoded.success) {
      expect(decoded.workflow.steps).toHaveLength(2);
      expect(decoded.workflow.dependencies).toEqual({ 'step-b': ['step-a'] });
      expect(decoded.stepResults['step-a']?.status).toBe('completed');
    }
  });

  it('returns the fixed recovery for malformed payloads without leaking content', () => {
    const invalidInputs = [
      null,
      { success: true, goalId: 'unsafe goal id', workflow: {}, stepResults: {} },
      makeWorkflowView({ secret: 'workflow-secret-marker' }),
      { success: false, code: 'goal_workflow_unavailable', secret: 'workflow-secret-marker' },
    ];
    for (const input of invalidInputs) {
      const decoded = decodeGoalWorkflowResponse(input);
      expect(decoded).toEqual({ success: false, code: 'goal_workflow_unavailable' });
      expect(JSON.stringify(decoded)).not.toContain('secret-marker');
    }
  });

  it('rejects unknown step statuses and control characters in step text', () => {
    const badStatus = makeWorkflowView();
    (badStatus.stepResults as Record<string, { status: string }>)['step-a']!.status = 'bogus-secret-marker';
    expect(decodeGoalWorkflowResponse(badStatus).success).toBe(false);

    const badText = makeWorkflowView();
    (badText.workflow.steps[0] as { prompt: string }).prompt = 'bad secret-marker';
    expect(decodeGoalWorkflowResponse(badText).success).toBe(false);
  });
});
