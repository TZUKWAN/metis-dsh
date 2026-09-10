import { describe, expect, it } from 'vitest';
import {
  SESSION_RUNTIME_LIMITS,
  SessionCreateRequestSchema,
  SessionListItemSchema,
  SessionListResponseSchema,
  SessionMutationResultSchema,
  SessionTitleSchema,
  SessionUpdateRequestSchema,
  decodeLegacySessionList,
  decodeLegacySessionRecord,
  decodeSessionCreateRequest,
  decodeSessionDeleteRequest,
  decodeSessionListRequest,
  decodeSessionListPayload,
  decodeSessionListResponse,
  decodeSessionMutationResult,
  decodeSessionUpdateRequest,
} from '../../engine/runtime/SessionRuntimeContract.js';

function makeLegacySession(overrides: Record<string, unknown> = {}) {
  return {
    id: 'session-1',
    createdAt: 1,
    lastActivity: 2,
    messageCount: 3,
    metadata: {
      title: '访谈分析',
      archived: false,
    },
    ...overrides,
  };
}

describe('session IPC request contracts', () => {
  it('accepts strict object requests for create/list/delete', () => {
    expect(SessionCreateRequestSchema.parse({ sessionId: 'session-1' })).toEqual({
      sessionId: 'session-1',
    });
    expect(decodeSessionListRequest({})).toEqual({ ok: true, value: {} });
    expect(decodeSessionDeleteRequest({ sessionId: 'session-1' })).toEqual({
      ok: true,
      value: { sessionId: 'session-1' },
    });
  });

  it('returns fixed request recovery for unsafe IDs and unknown fields', () => {
    const invalidInputs = [
      decodeSessionCreateRequest({ sessionId: 'unsafe session id' }),
      decodeSessionCreateRequest({ sessionId: 'session-1', title: 'create-secret-marker' }),
      decodeSessionListRequest({ token: 'list-secret-marker' }),
      decodeSessionDeleteRequest({ sessionId: 'session-1', path: 'delete-secret-marker' }),
    ];

    for (const decoded of invalidInputs) {
      expect(decoded.ok).toBe(false);
      expect(JSON.stringify(decoded)).not.toContain('secret-marker');
      expect(JSON.stringify(decoded)).not.toContain('unsafe session id');
    }
  });

  it('allows update of only a safe title and archived flag', () => {
    const input = {
      sessionId: 'session-1',
      patch: { title: '  新标题  ', archived: true },
    };
    expect(SessionUpdateRequestSchema.parse(input)).toEqual({
      sessionId: 'session-1',
      patch: { title: '新标题', archived: true },
    });
    expect(decodeSessionUpdateRequest({
      sessionId: 'session-1',
      patch: { archived: false },
    })).toEqual({
      ok: true,
      value: { sessionId: 'session-1', patch: { archived: false } },
    });
  });

  it('rejects empty, metadata-shaped, path-bearing, credential-bearing, and control-bearing updates', () => {
    const invalidInputs = [
      { sessionId: 'session-1', patch: {} },
      { sessionId: 'session-1', patch: { metadata: { title: 'metadata-secret-marker' } } },
      { sessionId: 'session-1', patch: { lastActivity: 99 } },
      { sessionId: 'session-1', patch: { title: 'C:\\private\\title-secret-marker' } },
      { sessionId: 'session-1', patch: { title: 'https://example.test/title-secret-marker' } },
      { sessionId: 'session-1', patch: { title: 'apiKey=title-secret-marker' } },
      { sessionId: 'session-1', patch: { title: 'title\u0000secret-marker' } },
    ];

    for (const input of invalidInputs) {
      const decoded = decodeSessionUpdateRequest(input);
      expect(decoded).toEqual({
        ok: false,
        recovery: { kind: 'recovery', code: 'session_update_request_unavailable' },
      });
      expect(JSON.stringify(decoded)).not.toContain('secret-marker');
    }
  });
});

describe('legacy session record presentation boundary', () => {
  it('explicitly selects only safe presentation fields from legacy metadata', () => {
    const decoded = decodeLegacySessionRecord(makeLegacySession({
      metadata: {
        title: '访谈分析',
        archived: true,
        apiKey: 'metadata-secret-marker',
        path: 'C:\\private\\metadata-secret-marker',
        nested: { token: 'nested-secret-marker' },
      },
    }));

    expect(decoded).toEqual({
      ok: true,
      value: {
        id: 'session-1',
        title: '访谈分析',
        createdAt: 1,
        lastActivity: 2,
        messageCount: 3,
        archived: true,
      },
    });
    expect(JSON.stringify(decoded)).not.toContain('metadata');
    expect(JSON.stringify(decoded)).not.toContain('secret-marker');
  });

  it('omits an unsafe legacy title while retaining the safe session record', () => {
    const unsafeTitles = [
      'C:\\Users\\researcher\\private\\session-title-secret-marker',
      'file:///C:/private/session-title-secret-marker',
      'Authorization=Bearer session-title-secret-marker',
      'session\u0000title-secret-marker',
      'x'.repeat(SESSION_RUNTIME_LIMITS.titleChars + 1),
    ];

    for (const title of unsafeTitles) {
      const decoded = decodeLegacySessionRecord(makeLegacySession({
        metadata: { title, archived: true },
      }));
      expect(decoded).toEqual({
        ok: true,
        value: {
          id: 'session-1',
          createdAt: 1,
          lastActivity: 2,
          messageCount: 3,
          archived: true,
        },
      });
      expect(JSON.stringify(decoded)).not.toContain('secret-marker');
      expect(JSON.stringify(decoded)).not.toContain('Users');
    }
  });

  it('accepts the former renderer top-level title shape but still emits only safe fields', () => {
    const decoded = decodeLegacySessionRecord({
      id: 'session-legacy',
      title: '旧版会话标题',
      createdAt: 1,
      lastActivity: 1,
      messageCount: 0,
      archived: true,
    });
    expect(decoded).toEqual({
      ok: true,
      value: {
        id: 'session-legacy',
        title: '旧版会话标题',
        createdAt: 1,
        lastActivity: 1,
        messageCount: 0,
        archived: true,
      },
    });
  });

  it('returns fixed recovery for invalid top-level records without reflecting raw data', () => {
    const cyclic: Record<string, unknown> = makeLegacySession();
    cyclic.self = cyclic;
    const invalidRecords = [
      makeLegacySession({ id: 'unsafe session id', metadata: { title: 'id-secret-marker' } }),
      makeLegacySession({ lastActivity: 0, metadata: { title: 'time-secret-marker' } }),
      makeLegacySession({ unknown: 'field-secret-marker' }),
      cyclic,
      new Error('record-secret-marker'),
    ];

    for (const input of invalidRecords) {
      const decoded = decodeLegacySessionRecord(input);
      expect(decoded).toEqual({
        ok: false,
        recovery: { kind: 'recovery', code: 'session_record_unavailable' },
      });
      expect(JSON.stringify(decoded)).not.toContain('secret-marker');
    }
  });
});

describe('session list response boundary', () => {
  it('converts legacy records into a bounded path-free metadata-free list', () => {
    const decoded = decodeLegacySessionList([
      makeLegacySession(),
      makeLegacySession({
        id: 'session-2',
        metadata: { title: '第二个会话', archived: true, token: 'list-secret-marker' },
      }),
    ]);

    expect(decoded).toEqual({
      success: true,
      sessions: [
        {
          id: 'session-1',
          title: '访谈分析',
          createdAt: 1,
          lastActivity: 2,
          messageCount: 3,
          archived: false,
        },
        {
          id: 'session-2',
          title: '第二个会话',
          createdAt: 1,
          lastActivity: 2,
          messageCount: 3,
          archived: true,
        },
      ],
    });
    expect(SessionListResponseSchema.parse(decoded)).toEqual(decoded);
    expect(JSON.stringify(decoded)).not.toContain('metadata');
    expect(JSON.stringify(decoded)).not.toContain('list-secret-marker');
  });

  it('accepts both safe IPC responses and legacy arrays through the renderer compatibility decoder', () => {
    const safeResponse = {
      success: true,
      sessions: [{
        id: 'session-1',
        title: '安全会话',
        createdAt: 1,
        lastActivity: 2,
        messageCount: 0,
        archived: false,
      }],
    };
    expect(decodeSessionListPayload(safeResponse)).toEqual(safeResponse);
    expect(decodeSessionListPayload([makeLegacySession()])).toEqual({
      success: true,
      sessions: [{
        id: 'session-1',
        title: '访谈分析',
        createdAt: 1,
        lastActivity: 2,
        messageCount: 3,
        archived: false,
      }],
    });
  });

  it('returns fixed list recovery for invalid and oversized legacy collections', () => {
    const invalid = decodeLegacySessionList([
      makeLegacySession({ unknown: 'list-secret-marker' }),
    ]);
    const oversized = decodeLegacySessionList(Array.from(
      { length: SESSION_RUNTIME_LIMITS.sessions + 1 },
      (_, index) => makeLegacySession({ id: `session-${index}` }),
    ));

    for (const decoded of [invalid, oversized]) {
      expect(decoded).toEqual({
        success: false,
        code: 'session_list_unavailable',
        sessions: [],
      });
      expect(JSON.stringify(decoded)).not.toContain('secret-marker');
    }
  });

  it('rejects renderer list responses containing metadata, paths, or unknown fields', () => {
    const invalidResponses = [
      {
        success: true,
        sessions: [{
          id: 'session-1',
          title: '会话',
          createdAt: 1,
          lastActivity: 2,
          messageCount: 0,
          archived: false,
          metadata: { token: 'response-secret-marker' },
        }],
      },
      {
        success: true,
        sessions: [{
          id: 'session-1',
          title: 'C:\\private\\response-secret-marker',
          createdAt: 1,
          lastActivity: 2,
          messageCount: 0,
          archived: false,
        }],
      },
    ];

    for (const input of invalidResponses) {
      const decoded = decodeSessionListResponse(input);
      expect(decoded).toEqual({
        success: false,
        code: 'session_list_unavailable',
        sessions: [],
      });
      expect(JSON.stringify(decoded)).not.toContain('secret-marker');
    }
  });
});

describe('session presentation and mutation schemas', () => {
  it('keeps safe list items free of metadata and arbitrary attributes', () => {
    const item = SessionListItemSchema.parse({
      id: 'session-1',
      title: '安全标题',
      createdAt: 1,
      lastActivity: 2,
      messageCount: 0,
      archived: false,
    });
    expect(item).not.toHaveProperty('metadata');
    expect(SessionTitleSchema.safeParse('C:\\private\\title').success).toBe(false);
  });

  it('accepts fixed mutation results and recovers from unknown or contradictory data', () => {
    const validResults = [
      { success: true },
      { success: true, code: 'created' },
      { success: true, code: 'updated' },
      { success: true, code: 'deleted' },
      { success: false },
      { success: false, code: 'not_found' },
      { success: false, code: 'rejected' },
    ];
    for (const input of validResults) {
      expect(SessionMutationResultSchema.parse(input)).toEqual(input);
      expect(decodeSessionMutationResult(input)).toEqual(input);
    }

    const invalidResults = [
      { success: false, code: 'mutation-secret-marker' },
      { success: false, code: 'created' },
      { success: true, code: 'not_found' },
      { success: true, error: 'error-secret-marker' },
    ];
    for (const input of invalidResults) {
      const decoded = decodeSessionMutationResult(input);
      expect(decoded).toEqual({
        success: false,
        code: 'session_mutation_unavailable',
      });
      expect(JSON.stringify(decoded)).not.toContain('secret-marker');
    }
  });
});

describe('Session 多对话扩展(2026-09-04 刘总要求)', () => {
  it('decodeLegacySessionRecord passes scenarioId/activeArtifactIds through for new sessions', () => {
    const decoded = decodeLegacySessionRecord({
      id: 'session_multi1',
      createdAt: 100,
      lastActivity: 200,
      messageCount: 2,
      projectId: 'proj-1',
      scenarioId: 'user:scenario/cssci',
      activeArtifactIds: ['artifact-a', 'artifact-b'],
    });
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.value.scenarioId).toBe('user:scenario/cssci');
      expect(decoded.value.activeArtifactIds).toEqual(['artifact-a', 'artifact-b']);
    }
  });

  it('legacy sessions without the new fields decode with them absent (backward compatible)', () => {
    const decoded = decodeLegacySessionRecord({
      id: 'session_legacy1',
      createdAt: 100,
      lastActivity: 200,
      messageCount: 0,
    });
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.value.scenarioId).toBeUndefined();
      expect(decoded.value.activeArtifactIds).toBeUndefined();
    }
  });

  it('SessionUpdatePatch accepts scenarioId-only and scenarioId+artifact patches', () => {
    expect(decodeSessionUpdateRequest({
      sessionId: 'session_multi1',
      patch: { scenarioId: null },
    }).ok).toBe(true);
    expect(decodeSessionUpdateRequest({
      sessionId: 'session_multi1',
      patch: { scenarioId: 'user:scenario/x', activeArtifactIds: ['a1'] },
    }).ok).toBe(true);
    expect(decodeSessionUpdateRequest({
      sessionId: 'session_multi1',
      patch: {},
    }).ok).toBe(false);
  });

  it('SessionListRequest supports projectId filter', () => {
    const decoded = decodeSessionListRequest({ projectId: 'proj-1' });
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.value.projectId).toBe('proj-1');
      expect(decoded.value.includeArchived).toBeUndefined();
    }
  });
});
