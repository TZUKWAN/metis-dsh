import { describe, expect, it } from 'vitest';
import {
  AgentResponseSchema,
  AgentChatRequestSchema,
  AgentPresentationEventSchema,
  CHAT_RUNTIME_CONTRACT_VERSION,
  CHAT_RUNTIME_LIMITS,
  ChatStreamChunkEventSchema,
  GoalLiveEventSchema,
  GoalSnapshotSchema,
  LEGACY_GOAL_MARKER_PREFIX,
  StreamChunkSchema,
  decodeAgentResponse,
  decodeChatStreamChunkEvent,
  decodeGoalLiveEvent,
  decodeLegacyGoalMarker,
  decodeStoredHistory,
  decodeHistoryItems,
  decodeHistoryPayload,
  decodeStoredHistoryEntry,
  decodeStreamChunk,
} from '../../engine/runtime/ChatRuntimeContract.js';

function makeGoalSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    goalId: 'goal-1',
    description: '比较两组访谈资料',
    phase: 'executing',
    planName: '访谈比较计划',
    planDescription: '逐步比较主题与差异',
    steps: [{ id: 'step-1', name: '编码访谈', description: '提取主题编码' }],
    stepStatuses: {
      'step-1': {
        stepId: 'step-1',
        stepName: '编码访谈',
        status: 'running',
        output: '',
      },
    },
    progress: { completed: 0, total: 1, currentStep: '编码访谈' },
    reasoning: '按主题比较。',
    canRefine: false,
    ...overrides,
  };
}

function makeAgentResponse(overrides: Record<string, unknown> = {}) {
  return {
    version: CHAT_RUNTIME_CONTRACT_VERSION,
    turnId: 'turn-1',
    status: 'completed',
    answer: '已完成安全分析。',
    diagnostics: [{ severity: 'info', code: 'analysis_complete', message: '完成。' }],
    citations: [{ id: '1', label: '受访者资料 A', url: 'https://example.test/source-a' }],
    events: [{ type: 'lifecycle', phase: 'completed', timestamp: 1 }],
    ...overrides,
  };
}

describe('agent chat request boundary', () => {
  it('accepts only strict bounded provider messages', () => {
    expect(AgentChatRequestSchema.safeParse({
      version: 1,
      turnId: 'turn-1',
      sessionId: 'session-1',
      messages: [{ role: 'user', content: 'question' }],
      mode: 'send',
    }).success).toBe(true);

    expect(AgentChatRequestSchema.safeParse({
      version: 1,
      turnId: 'turn-1',
      sessionId: 'session-1',
      messages: [{ role: 'attacker-secret-role', content: 'secret payload' }],
      mode: 'send',
    }).success).toBe(false);
  });
});

describe('stored history and legacy Goal recovery', () => {
  it('validates an already-structured history payload without reflecting invalid data', () => {
    expect(decodeHistoryItems([
      { kind: 'message', role: 'assistant', content: 'safe answer' },
    ])).toEqual([
      { kind: 'message', role: 'assistant', content: 'safe answer' },
    ]);

    const invalid = decodeHistoryItems([
      { kind: 'message', role: 'attacker-secret-role', content: 'secret payload' },
    ]);
    expect(invalid).toEqual([{ kind: 'recovery', code: 'history_unavailable' }]);
    expect(JSON.stringify(invalid)).not.toContain('attacker-secret-role');
    expect(JSON.stringify(invalid)).not.toContain('secret payload');
  });

  it('safely migrates strict legacy rows at the renderer boundary', () => {
    expect(decodeHistoryPayload([
      { role: 'assistant', content: 'legacy safe answer' },
    ])).toEqual([
      { kind: 'message', role: 'assistant', content: 'legacy safe answer' },
    ]);
  });

  it('decodes valid message rows and valid legacy Goal markers', () => {
    const goal = makeGoalSnapshot();
    const decoded = decodeStoredHistory([
      { role: 'user', content: '请比较访谈资料。' },
      { role: 'assistant', content: '开始分析。' },
      { role: 'goal', content: `${LEGACY_GOAL_MARKER_PREFIX}${JSON.stringify(goal)}` },
    ]);

    expect(decoded).toEqual([
      { kind: 'message', role: 'user', content: '请比较访谈资料。' },
      { kind: 'message', role: 'assistant', content: '开始分析。' },
      { kind: 'goal', goal: GoalSnapshotSchema.parse(goal) },
    ]);
  });

  it('maps unknown Goal phase and step status to fixed neutral values', () => {
    const marker = `${LEGACY_GOAL_MARKER_PREFIX}${JSON.stringify(makeGoalSnapshot({
      phase: 'phase-secret-marker',
      stepStatuses: {
        'step-1': {
          stepId: 'step-1',
          stepName: '编码访谈',
          status: 'status-secret-marker',
          output: '',
        },
      },
    }))}`;

    const decoded = decodeLegacyGoalMarker(marker);
    expect(decoded.kind).toBe('goal');
    if (decoded.kind !== 'goal') throw new Error('Expected decoded goal');
    expect(decoded.goal.phase).toBe('unknown');
    expect(decoded.goal.stepStatuses['step-1']?.status).toBe('unknown');
    expect(JSON.stringify(decoded)).not.toContain('phase-secret-marker');
    expect(JSON.stringify(decoded)).not.toContain('status-secret-marker');
  });

  it('returns fixed recovery for unknown roles without echoing the role or content', () => {
    const decoded = decodeStoredHistoryEntry({
      role: 'role-secret-marker',
      content: 'content-secret-marker',
    });

    expect(decoded).toEqual({ kind: 'recovery', code: 'history_item_unavailable' });
    expect(JSON.stringify(decoded)).not.toContain('role-secret-marker');
    expect(JSON.stringify(decoded)).not.toContain('content-secret-marker');
  });

  it('recovers from malformed, structurally invalid, and over-specified Goal markers', () => {
    const malformed = decodeLegacyGoalMarker(
      `${LEGACY_GOAL_MARKER_PREFIX}{"apiKey":"goal-secret-marker"`,
    );
    const wrongShape = decodeLegacyGoalMarker(
      `${LEGACY_GOAL_MARKER_PREFIX}${JSON.stringify({ apiKey: 'goal-secret-marker' })}`,
    );
    const extraKey = decodeLegacyGoalMarker(
      `${LEGACY_GOAL_MARKER_PREFIX}${JSON.stringify(makeGoalSnapshot({
        apiKey: 'goal-secret-marker',
      }))}`,
    );

    for (const decoded of [malformed, wrongShape, extraKey]) {
      expect(decoded).toEqual({ kind: 'recovery', code: 'goal_snapshot_unavailable' });
      expect(JSON.stringify(decoded)).not.toContain('goal-secret-marker');
    }
  });

  it('rejects inconsistent Goal topology and invalid progress safely', () => {
    const inconsistent = decodeLegacyGoalMarker(
      `${LEGACY_GOAL_MARKER_PREFIX}${JSON.stringify(makeGoalSnapshot({
        stepStatuses: {
          'step-1': {
            stepId: 'different-step',
            stepName: '编码访谈',
            status: 'running',
            output: 'topology-secret-marker',
          },
        },
      }))}`,
    );
    const impossibleProgress = decodeLegacyGoalMarker(
      `${LEGACY_GOAL_MARKER_PREFIX}${JSON.stringify(makeGoalSnapshot({
        progress: { completed: 2, total: 1, currentStep: 'progress-secret-marker' },
      }))}`,
    );

    expect(inconsistent).toEqual({ kind: 'recovery', code: 'goal_snapshot_unavailable' });
    expect(impossibleProgress).toEqual({ kind: 'recovery', code: 'goal_snapshot_unavailable' });
    expect(JSON.stringify([inconsistent, impossibleProgress])).not.toContain('secret-marker');
  });

  it('bounds the history container and never reflects an invalid collection', () => {
    const oversized = Array.from(
      { length: CHAT_RUNTIME_LIMITS.historyItems + 1 },
      () => ({ role: 'user', content: 'history-secret-marker' }),
    );

    const decoded = decodeStoredHistory(oversized);
    expect(decoded).toEqual([{ kind: 'recovery', code: 'history_unavailable' }]);
    expect(JSON.stringify(decoded)).not.toContain('history-secret-marker');
  });
});

describe('structured agent response contract', () => {
  it('accepts the bounded answer/diagnostics/citations/events structure', () => {
    const response = makeAgentResponse({
      events: [
        { type: 'lifecycle', phase: 'completed', timestamp: 1 },
        { type: 'action', action: 'search_library', status: 'completed', timestamp: 2 },
        { type: 'progress', completed: 1, total: 1, timestamp: 3, label: '完成' },
      ],
    });

    expect(AgentResponseSchema.parse(response)).toEqual(response);
    expect(decodeAgentResponse(response)).toEqual(response);
  });

  it('accepts O8 citation chips (id/label/url/doi) and rejects duplicate ids', () => {
    const withChips = makeAgentResponse({
      citations: [
        { id: '1', label: 'Platform labor review', url: 'https://example.test/a', doi: '10.1177/0000001' },
        { id: '2', label: '知识劳动者研究', doi: '10.1177/0000002' },
      ],
    });
    expect(AgentResponseSchema.parse(withChips)).toEqual(withChips);

    const duplicated = makeAgentResponse({
      citations: [
        { id: '1', label: 'A' },
        { id: '1', label: 'B' },
      ],
    });
    expect(AgentResponseSchema.safeParse(duplicated).success).toBe(false);
  });

  it('keeps citations in stored message metadata instead of dropping the row', () => {
    const row = {
      role: 'assistant',
      content: '答案正文',
      metadata: {
        runId: 'run-1',
        turnId: 'turn-1',
        status: 'completed',
        citations: [{ id: '1', label: '来源一', url: 'https://example.test/1' }],
      },
    };
    const decoded = decodeStoredHistoryEntry(row);
    expect(decoded.kind).toBe('message');
    if (decoded.kind === 'message') {
      expect(decoded.metadata?.citations).toEqual([{ id: '1', label: '来源一', url: 'https://example.test/1' }]);
    }
  });

  it('normalizes unknown response and event statuses without reflecting raw values', () => {
    const decoded = decodeAgentResponse(makeAgentResponse({
      status: 'status-secret-marker',
      answer: '',
      events: [
        { type: 'lifecycle', phase: 'phase-secret-marker', timestamp: 1 },
        { type: 'action', action: 'search_library', status: 'event-status-secret-marker', timestamp: 2 },
      ],
    }));

    expect(decoded.status).toBe('unknown');
    expect(decoded.events[0]).toMatchObject({ type: 'lifecycle', phase: 'unknown' });
    expect(decoded.events[1]).toMatchObject({ type: 'action', status: 'unknown' });
    expect(JSON.stringify(decoded)).not.toContain('status-secret-marker');
    expect(JSON.stringify(decoded)).not.toContain('phase-secret-marker');
  });

  it('returns a fixed response recovery for malformed or over-specified responses', () => {
    const invalidResponses = [
      { status: 'completed', answer: 'answer-secret-marker' },
      makeAgentResponse({ apiKey: 'response-secret-marker' }),
      makeAgentResponse({ status: 'error', answer: 'partial-secret-marker' }),
      makeAgentResponse({
        citations: [{
          sourceId: 'source-1',
          label: 'Citation',
          verified: false,
          url: 'https://user:pass@example.test/?token=citation-secret-marker',
        }],
      }),
    ];

    for (const input of invalidResponses) {
      const decoded = decodeAgentResponse(input);
      expect(decoded).toEqual({
        version: CHAT_RUNTIME_CONTRACT_VERSION,
        turnId: 'runtime-recovery',
        status: 'unknown',
        answer: '',
        diagnostics: [{
          severity: 'error',
          code: 'runtime_contract_error',
          message: 'Runtime response unavailable.',
        }],
        citations: [],
        events: [],
      });
      expect(JSON.stringify(decoded)).not.toContain('secret-marker');
      expect(JSON.stringify(decoded)).not.toContain('user:pass');
    }
  });

  it('does not throw or reflect cyclic and exotic invalid values', () => {
    const cyclic: Record<string, unknown> = makeAgentResponse();
    cyclic.self = cyclic;
    const inputs = [cyclic, new Map([['apiKey', 'map-secret-marker']]), new Error('error-secret-marker')];

    for (const input of inputs) {
      const decoded = decodeAgentResponse(input);
      expect(decoded.turnId).toBe('runtime-recovery');
      expect(JSON.stringify(decoded)).not.toContain('secret-marker');
    }
  });
});

describe('stream chunk contract', () => {
  it('accepts strict delta and done chunks', () => {
    const delta = {
      version: CHAT_RUNTIME_CONTRACT_VERSION,
      turnId: 'turn-1',
      sequence: 0,
      kind: 'delta',
      text: '安全片段',
    } as const;
    const done = {
      version: CHAT_RUNTIME_CONTRACT_VERSION,
      turnId: 'turn-1',
      sequence: 1,
      kind: 'done',
    } as const;

    expect(StreamChunkSchema.parse(delta)).toEqual(delta);
    expect(decodeStreamChunk(done)).toEqual({ ok: true, value: done });
  });

  it('returns fixed recovery for invalid kinds, extra fields, and oversized chunks', () => {
    const invalidChunks = [
      {
        version: CHAT_RUNTIME_CONTRACT_VERSION,
        turnId: 'turn-1',
        sequence: 0,
        kind: 'chunk-secret-marker',
        text: 'payload-secret-marker',
      },
      {
        version: CHAT_RUNTIME_CONTRACT_VERSION,
        turnId: 'turn-1',
        sequence: 0,
        kind: 'done',
        token: 'extra-secret-marker',
      },
      {
        version: CHAT_RUNTIME_CONTRACT_VERSION,
        turnId: 'turn-1',
        sequence: 0,
        kind: 'delta',
        text: 'x'.repeat(CHAT_RUNTIME_LIMITS.streamChunkChars + 1),
      },
    ];

    for (const input of invalidChunks) {
      const decoded = decodeStreamChunk(input);
      expect(decoded).toEqual({
        ok: false,
        recovery: { kind: 'recovery', code: 'stream_chunk_unavailable' },
      });
      expect(JSON.stringify(decoded)).not.toContain('secret-marker');
    }
  });
});

describe('renderer chat stream event contract', () => {
  it('keeps a strict renderer turnId and only accepts known stream fields', () => {
    const payload = {
      turnId: 'renderer-turn-1',
      sessionId: 'session-1',
      content: '实时正文分片',
      reasoning: '真实推理分片',
      isFinished: false,
    } as const;
    expect(ChatStreamChunkEventSchema.parse(payload)).toEqual(payload);
    expect(decodeChatStreamChunkEvent(payload)).toEqual({ ok: true, value: payload });
    expect(decodeChatStreamChunkEvent({ ...payload, stale: true })).toEqual({
      ok: false,
      recovery: { kind: 'recovery', code: 'chat_stream_chunk_event_unavailable' },
    });
  });
});

describe('tool completion presentation events', () => {
  it('allows only sanitized detail and actual displayable sources', () => {
    const event = {
      type: 'tool_result',
      toolCallId: 'tool-1',
      toolName: 'search_papers',
      status: 'completed',
      timestamp: 1,
      summary: 'tool.dispatched',
      detail: 'Paper search results\\n1. A real paper',
      sources: [{ label: 'Crossref record', url: 'https://api.crossref.org/works/example' }],
    } as const;
    expect(AgentPresentationEventSchema.parse(event)).toEqual(event);
    expect(AgentPresentationEventSchema.safeParse({ ...event, sources: [{ label: 'bad', url: 'file:///secret' }] }).success).toBe(false);
    expect(AgentPresentationEventSchema.safeParse({ ...event, rawMetadata: { command: 'secret' } }).success).toBe(false);
  });
});

describe('Goal live event contract', () => {
  it('accepts each strict Goal live event variant', () => {
    const events = [
      {
        version: CHAT_RUNTIME_CONTRACT_VERSION,
        goalId: 'goal-1',
        sequence: 0,
        type: 'step-start',
        stepId: 'step-1',
        stepName: '编码访谈',
      },
      {
        version: CHAT_RUNTIME_CONTRACT_VERSION,
        goalId: 'goal-1',
        sequence: 1,
        type: 'step-complete',
        stepId: 'step-1',
        stepName: '编码访谈',
        output: '完成编码。',
      },
      {
        version: CHAT_RUNTIME_CONTRACT_VERSION,
        goalId: 'goal-1',
        sequence: 2,
        type: 'step-failed',
        stepId: 'step-1',
        stepName: '编码访谈',
        error: '执行失败。',
      },
      {
        version: CHAT_RUNTIME_CONTRACT_VERSION,
        goalId: 'goal-1',
        sequence: 3,
        type: 'progress',
        completed: 1,
        total: 1,
        currentStep: '编码访谈',
      },
    ];

    for (const event of events) {
      expect(GoalLiveEventSchema.safeParse(event).success).toBe(true);
      expect(decodeGoalLiveEvent(event)).toEqual({ ok: true, value: event });
    }
  });

  it('returns fixed recovery for unknown, over-specified, or impossible events', () => {
    const invalidEvents = [
      {
        version: CHAT_RUNTIME_CONTRACT_VERSION,
        goalId: 'goal-1',
        sequence: 0,
        type: 'event-secret-marker',
        output: 'payload-secret-marker',
      },
      {
        version: CHAT_RUNTIME_CONTRACT_VERSION,
        goalId: 'goal-1',
        sequence: 0,
        type: 'step-start',
        stepId: 'step-1',
        stepName: '编码访谈',
        apiKey: 'event-secret-marker',
      },
      {
        version: CHAT_RUNTIME_CONTRACT_VERSION,
        goalId: 'goal-1',
        sequence: 0,
        type: 'progress',
        completed: 2,
        total: 1,
        currentStep: 'progress-secret-marker',
      },
    ];

    for (const input of invalidEvents) {
      const decoded = decodeGoalLiveEvent(input);
      expect(decoded).toEqual({
        ok: false,
        recovery: { kind: 'recovery', code: 'goal_event_unavailable' },
      });
      expect(JSON.stringify(decoded)).not.toContain('secret-marker');
    }
  });
});
