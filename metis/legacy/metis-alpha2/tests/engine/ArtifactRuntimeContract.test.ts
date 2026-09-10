import { describe, expect, it } from 'vitest';
import {
  ARTIFACT_RUNTIME_LIMITS,
  ArtifactContentRequestSchema,
  ArtifactContentResponseSchema,
  ArtifactCreateRequestSchema,
  ArtifactCreatedNotificationSchema,
  ArtifactListItemSchema,
  ArtifactListResponseSchema,
  ArtifactMutationResultSchema,
  ArtifactTypeSchema,
  createArtifactContentRecovery,
  decodeArtifactContentRequest,
  decodeArtifactContentResponse,
  decodeArtifactCreateRequest,
  decodeArtifactCreatedNotification,
  decodeArtifactListItem,
  decodeArtifactListResponse,
  decodeArtifactListPayload,
  decodeArtifactMutationResult,
} from '../../engine/runtime/ArtifactRuntimeContract.js';

function makeListItem(overrides: Record<string, unknown> = {}) {
  return {
    id: 'artifact-1',
    sessionId: 'session-1',
    name: 'results.md',
    type: 'md',
    size: '12 KB',
    contentAvailable: false,
    createdAt: 1,
    ...overrides,
  };
}

describe('artifact create request contract', () => {
  it('accepts a renderer-safe file capability and normalizes name to a safe basename', () => {
    const input = {
      id: 'artifact-1',
      sessionId: 'session-1',
      name: 'C:\\Users\\researcher\\private\\results.md?token=name-secret-marker',
      type: 'md',
      sourceCapabilityId: `fc_${'a'.repeat(32)}`,
      size: '12 KB',
    };

    const parsed = ArtifactCreateRequestSchema.parse(input);
    expect(parsed).toEqual({
      ...input,
      name: 'results.md',
    });
    expect(parsed.sourceCapabilityId).toBe(input.sourceCapabilityId);
    expect(parsed).not.toHaveProperty('path');
    expect(parsed.name).not.toContain('Users');
    expect(parsed.name).not.toContain('name-secret-marker');
  });

  it('returns fixed create recovery for unsafe IDs, relative/URI paths, controls, and extras', () => {
    const invalidInputs = [
      {
        id: 'unsafe artifact id',
        sessionId: 'session-1',
        name: 'results.md',
        type: 'md',
      },
      {
        id: 'artifact-1',
        sessionId: 'session-1',
        name: 'results.md',
        type: 'md',
        path: 'relative\\path-secret-marker.md',
      },
      {
        id: 'artifact-1',
        sessionId: 'session-1',
        name: 'results.md',
        type: 'md',
        path: 'file:///C:/private/path-secret-marker.md',
      },
      {
        id: 'artifact-1',
        sessionId: 'session-1',
        name: 'results\u0000name-secret-marker.md',
        type: 'md',
      },
      {
        id: 'artifact-1',
        sessionId: 'session-1',
        name: 'results.md',
        type: 'md',
        apiKey: 'extra-secret-marker',
      },
    ];

    for (const input of invalidInputs) {
      const decoded = decodeArtifactCreateRequest(input);
      expect(decoded).toEqual({
        ok: false,
        recovery: { kind: 'recovery', code: 'artifact_create_request_unavailable' },
      });
      expect(JSON.stringify(decoded)).not.toContain('secret-marker');
    }
  });
});

describe('ordinary-renderer artifact list contract', () => {
  it('accepts a strict path-free list item and returns only a safe basename', () => {
    const input = makeListItem({
      name: '/home/researcher/private/results.md#fragment-secret-marker',
    });
    const decoded = decodeArtifactListItem(input);

    expect(decoded).toEqual({
      ok: true,
      value: {
        ...input,
        name: 'results.md',
      },
    });
    if (!decoded.ok) throw new Error('Expected a valid list item');
    expect(decoded.value).not.toHaveProperty('path');
    expect(JSON.stringify(decoded.value)).not.toContain('/home/researcher');
    expect(JSON.stringify(decoded.value)).not.toContain('fragment-secret-marker');
  });

  it('requires an explicit content availability flag and accepts inline availability', () => {
    expect(decodeArtifactListItem(makeListItem({ contentAvailable: true }))).toMatchObject({
      ok: true,
      value: { id: 'artifact-1', contentAvailable: true },
    });
    const { contentAvailable: _contentAvailable, ...missingFlag } = makeListItem();
    void _contentAvailable;
    expect(decodeArtifactListItem(missingFlag)).toEqual({
      ok: false,
      recovery: { kind: 'recovery', code: 'artifact_list_item_unavailable' },
    });
  });

  it('rejects path and metadata fields instead of stripping them after IPC', () => {
    const invalidItems = [
      makeListItem({ path: 'C:\\private\\list-path-secret-marker.md' }),
      makeListItem({ metadata: { apiKey: 'metadata-secret-marker' } }),
      makeListItem({ type: 'unknown-type-secret-marker' }),
      makeListItem({ size: `12 KB\u0000size-secret-marker` }),
    ];

    for (const input of invalidItems) {
      const decoded = decodeArtifactListItem(input);
      expect(decoded).toEqual({
        ok: false,
        recovery: { kind: 'recovery', code: 'artifact_list_item_unavailable' },
      });
      expect(JSON.stringify(decoded)).not.toContain('secret-marker');
    }
  });

  it('decodes a bounded path-free list response', () => {
    const input = {
      success: true,
      items: [
        makeListItem(),
        makeListItem({
          id: 'artifact-2',
          name: 'C:\\private\\table.xlsx?token=list-secret-marker',
          type: 'xlsx',
        }),
      ],
    };
    const decoded = decodeArtifactListResponse(input);

    expect(decoded).toEqual({
      success: true,
      items: [
        makeListItem(),
        makeListItem({ id: 'artifact-2', name: 'table.xlsx', type: 'xlsx' }),
      ],
    });
    expect(ArtifactListResponseSchema.parse(decoded)).toEqual(decoded);
    expect(JSON.stringify(decoded)).not.toContain('C:\\private');
    expect(JSON.stringify(decoded)).not.toContain('list-secret-marker');
  });

  it('returns fixed list recovery for invalid or oversized collections', () => {
    const invalid = decodeArtifactListResponse({
      success: true,
      items: [makeListItem({ path: '/private/list-secret-marker.md' })],
    });
    const oversized = decodeArtifactListResponse({
      success: true,
      items: Array.from(
        { length: ARTIFACT_RUNTIME_LIMITS.items + 1 },
        (_, index) => makeListItem({ id: `artifact-${index}` }),
      ),
    });

    for (const decoded of [invalid, oversized]) {
      expect(decoded).toEqual({
        success: false,
        code: 'artifact_list_unavailable',
        items: [],
      });
      expect(JSON.stringify(decoded)).not.toContain('secret-marker');
    }
  });

  it('migrates a legacy list array while discarding path and metadata fields', () => {
    const { contentAvailable: _contentAvailable, ...legacyItem } = makeListItem({
      name: 'C:\\private\\legacy.md?token=legacy-secret-marker',
    });
    void _contentAvailable;
    const decoded = decodeArtifactListPayload([{
      ...legacyItem,
      path: 'C:\\private\\legacy.md',
      metadata: { apiKey: 'metadata-secret-marker' },
    }]);

    expect(decoded).toEqual({
      success: true,
      items: [makeListItem({ name: 'legacy.md' })],
    });
    const serialized = JSON.stringify(decoded);
    for (const marker of ['C:\\private', 'legacy-secret-marker', 'metadata-secret-marker']) {
      expect(serialized).not.toContain(marker);
    }
  });
});

describe('artifact created notification contract', () => {
  it('accepts a strict notification with no path and a safe basename', () => {
    const input = {
      artifactId: 'artifact-1',
      sessionId: 'session-1',
      name: '\\\\server\\private\\results.pdf?token=notification-secret-marker',
      type: 'pdf',
      size: '2 MB',
      contentAvailable: false,
      createdAt: 1,
    };
    const decoded = decodeArtifactCreatedNotification(input);

    expect(decoded).toEqual({
      ok: true,
      value: { ...input, name: 'results.pdf' },
    });
    expect(ArtifactCreatedNotificationSchema.parse(input)).not.toHaveProperty('path');
    expect(JSON.stringify(decoded)).not.toContain('server');
    expect(JSON.stringify(decoded)).not.toContain('notification-secret-marker');
  });

  it('marks generated inline artifact notifications as content-available', () => {
    const decoded = decodeArtifactCreatedNotification({
      artifactId: 'artifact-inline',
      sessionId: 'session-1',
      name: 'generated.md',
      type: 'md',
      contentAvailable: true,
      createdAt: 2,
    });
    expect(decoded).toMatchObject({
      ok: true,
      value: { artifactId: 'artifact-inline', contentAvailable: true },
    });
  });

  it('returns fixed notification recovery when path or other raw data is present', () => {
    const invalidInputs = [
      {
        artifactId: 'artifact-1',
        sessionId: 'session-1',
        name: 'results.pdf',
        type: 'pdf',
        contentAvailable: false,
        createdAt: 1,
        path: 'C:\\private\\notification-path-secret-marker.pdf',
      },
      {
        artifactId: 'artifact-1',
        sessionId: 'unsafe session id',
        name: 'notification-secret-marker.pdf',
        type: 'pdf',
        contentAvailable: false,
        createdAt: 1,
      },
    ];

    for (const input of invalidInputs) {
      const decoded = decodeArtifactCreatedNotification(input);
      expect(decoded).toEqual({
        ok: false,
        recovery: { kind: 'recovery', code: 'artifact_notification_unavailable' },
      });
      expect(JSON.stringify(decoded)).not.toContain('secret-marker');
    }
  });
});

describe('artifact inline content contract', () => {
  it('keeps generated plans as md and exposes the fixed two-million-character content bound', () => {
    expect(ARTIFACT_RUNTIME_LIMITS.contentChars).toBe(2_000_000);
    expect(ArtifactTypeSchema.safeParse('md').success).toBe(true);
    expect(ArtifactTypeSchema.safeParse('plan').success).toBe(false);
  });

  it('accepts only a strict artifact/session content request and returns fixed request recovery', () => {
    const request = { artifactId: 'artifact-1', sessionId: 'session-1' };
    expect(ArtifactContentRequestSchema.parse(request)).toEqual(request);
    expect(decodeArtifactContentRequest(request)).toEqual({ ok: true, value: request });

    for (const input of [
      { ...request, path: 'C:\\private\\request-secret-marker.md' },
      { ...request, artifactId: 'unsafe artifact id' },
      { artifactId: 'artifact-1' },
    ]) {
      const decoded = decodeArtifactContentRequest(input);
      expect(decoded).toEqual({
        ok: false,
        recovery: { kind: 'recovery', code: 'artifact_content_request_unavailable' },
      });
      expect(JSON.stringify(decoded)).not.toContain('secret-marker');
    }
  });

  it('round-trips strict inline content and preserves only the two fixed failure codes', () => {
    const success = {
      success: true as const,
      id: 'artifact-1',
      sessionId: 'session-1',
      name: 'C:\\private\\research-plan.md?token=content-secret-marker',
      type: 'md' as const,
      content: '# Research plan\n\n1. Review the evidence.\n',
      createdAt: 42,
    };
    expect(decodeArtifactContentResponse(success)).toEqual({
      ...success,
      name: 'research-plan.md',
    });
    expect(ArtifactContentResponseSchema.parse({
      ...success,
      name: 'research-plan.md',
    })).toMatchObject({ success: true, type: 'md' });
    expect(JSON.stringify(decodeArtifactContentResponse(success))).not.toContain('content-secret-marker');

    for (const failure of [
      { success: false as const, code: 'not_found' as const },
      { success: false as const, code: 'artifact_content_unavailable' as const },
    ]) {
      expect(decodeArtifactContentResponse(failure)).toEqual(failure);
    }
    expect(createArtifactContentRecovery()).toEqual({
      success: false,
      code: 'artifact_content_unavailable',
    });
  });

  it('recovers without reflecting oversized, malformed, cyclic, or control-bearing content', () => {
    const cyclic: Record<string, unknown> = { success: true };
    cyclic.self = cyclic;
    const invalidInputs = [
      {
        success: true,
        id: 'artifact-1',
        sessionId: 'session-1',
        name: 'oversized-secret-marker.md',
        type: 'md',
        content: 'x'.repeat(ARTIFACT_RUNTIME_LIMITS.contentChars + 1),
        createdAt: 1,
      },
      {
        success: true,
        id: 'artifact-1',
        sessionId: 'session-1',
        name: 'control-secret-marker.md',
        type: 'md',
        content: 'valid prefix\u0000content-secret-marker',
        createdAt: 1,
      },
      { success: false, code: 'unknown-secret-marker' },
      { success: false, code: 'not_found', detail: 'path-secret-marker' },
      cyclic,
    ];

    for (const input of invalidInputs) {
      const decoded = decodeArtifactContentResponse(input);
      expect(decoded).toEqual({ success: false, code: 'artifact_content_unavailable' });
      expect(JSON.stringify(decoded)).not.toContain('secret-marker');
    }
  });
});

describe('artifact mutation result contract', () => {
  it('accepts only the fixed { success, code? } mutation shape', () => {
    const validResults = [
      { success: true },
      { success: true, code: 'created' },
      { success: true, code: 'deleted' },
      { success: false },
      { success: false, code: 'not_found' },
      { success: false, code: 'rejected' },
    ];

    for (const input of validResults) {
      expect(ArtifactMutationResultSchema.parse(input)).toEqual(input);
      expect(decodeArtifactMutationResult(input)).toEqual(input);
    }
  });

  it('returns fixed mutation recovery without reflecting unknown or contradictory data', () => {
    const cyclic: Record<string, unknown> = { success: true };
    cyclic.self = cyclic;
    const invalidInputs = [
      { success: false, code: 'mutation-secret-marker' },
      { success: false, code: 'created' },
      { success: true, code: 'failed' },
      { success: true, path: 'C:\\private\\mutation-path-secret-marker' },
      cyclic,
      new Map([['path', 'map-secret-marker']]),
    ];

    for (const input of invalidInputs) {
      const decoded = decodeArtifactMutationResult(input);
      expect(decoded).toEqual({
        success: false,
        code: 'artifact_mutation_unavailable',
      });
      expect(JSON.stringify(decoded)).not.toContain('secret-marker');
    }
  });
});

describe('artifact schema strictness', () => {
  it('keeps local paths out of every renderer contract and accepts only a capability id on create', () => {
    const create = ArtifactCreateRequestSchema.parse({
      id: 'artifact-1',
      sessionId: 'session-1',
      name: 'results.md',
      type: 'md',
      sourceCapabilityId: `fc_${'b'.repeat(32)}`,
    });

    expect(create.sourceCapabilityId).toBe(`fc_${'b'.repeat(32)}`);
    expect(create).not.toHaveProperty('path');
    expect(ArtifactCreateRequestSchema.safeParse({
      id: 'artifact-1',
      sessionId: 'session-1',
      name: 'results.md',
      type: 'md',
      path: '/private/create-secret-marker.md',
    }).success).toBe(false);
    expect(ArtifactListItemSchema.safeParse({
      ...makeListItem(),
      path: '/private/list-secret-marker.md',
    }).success).toBe(false);
    expect(ArtifactCreatedNotificationSchema.safeParse({
      artifactId: 'artifact-1',
      sessionId: 'session-1',
      name: 'results.md',
      type: 'md',
      contentAvailable: false,
      createdAt: 1,
      path: '/private/notification-secret-marker.md',
    }).success).toBe(false);
  });
});
