import { describe, expect, it } from 'vitest';
import {
  PERSONALIZATION_SECRET_VALUE_MAX_CHARS,
  PersonalizationSecretListRequestSchema,
  PersonalizationSecretListResponseSchema,
  PersonalizationSecretRemoveRequestSchema,
  PersonalizationSecretSetRequestSchema,
  PersonalizationSecretSetResponseSchema,
  PersonalizationSecretValueSchema,
  decodePersonalizationSecretListResponse,
  decodePersonalizationSecretSetResponse,
  secretNameFromRef,
  secretRefForName,
} from '../../engine/runtime/PersonalizationSecretContract.js';

const OPERATION_ID = '00000000-0000-4000-8000-000000000001';

describe('PersonalizationSecretContract', () => {
  it('accepts a strict CAS set request', () => {
    expect(PersonalizationSecretSetRequestSchema.parse({
      contractVersion: 1,
      operationId: OPERATION_ID,
      expectedRevision: 0,
      name: 'OPENALEX_API_KEY',
      value: 'secret-value-123',
    })).toMatchObject({ name: 'OPENALEX_API_KEY', expectedRevision: 0 });
  });

  it.each([
    ['empty', ''],
    ['whitespace', '   '],
    ['newline', 'secret\nvalue'],
    ['tab', 'secret\tvalue'],
    ['NUL', 'secret\0value'],
    ['C1', `secret${String.fromCharCode(0x85)}value`],
    ['oversized', 'x'.repeat(PERSONALIZATION_SECRET_VALUE_MAX_CHARS + 1)],
  ])('rejects %s values', (_label, value) => {
    expect(PersonalizationSecretValueSchema.safeParse(value).success).toBe(false);
  });

  it.each(['PATH', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'LD_PRELOAD', 'COMSPEC'])(
    'rejects reserved runtime environment name %s',
    (name) => {
      expect(PersonalizationSecretSetRequestSchema.safeParse({
        contractVersion: 1,
        operationId: OPERATION_ID,
        expectedRevision: 0,
        name,
        value: 'safe-value',
      }).success).toBe(false);
      expect(secretRefForName(name)).toBeUndefined();
    },
  );

  it('converts only valid names to and from opaque references', () => {
    expect(secretRefForName('ZOTERO_API_KEY')).toBe('${secret:ZOTERO_API_KEY}');
    expect(secretNameFromRef('${secret:ZOTERO_API_KEY}')).toBe('ZOTERO_API_KEY');
    expect(secretNameFromRef('${secret:PATH}')).toBeUndefined();
    expect(secretNameFromRef('${secret:bad-name}')).toBeUndefined();
  });

  it('rejects extra fields and malformed CAS revisions', () => {
    const base = {
      contractVersion: 1,
      operationId: OPERATION_ID,
      expectedRevision: 0,
      name: 'ZOTERO_API_KEY',
      value: 'safe-value',
    };
    expect(PersonalizationSecretSetRequestSchema.safeParse({ ...base, verified: true }).success).toBe(false);
    expect(PersonalizationSecretSetRequestSchema.safeParse({ ...base, expectedRevision: -1 }).success).toBe(false);
    expect(PersonalizationSecretListRequestSchema.safeParse({
      contractVersion: 1, operationId: OPERATION_ID, includeValues: true,
    }).success).toBe(false);
    expect(PersonalizationSecretRemoveRequestSchema.safeParse({
      contractVersion: 1, operationId: OPERATION_ID, expectedRevision: 0, name: 'bad/name',
    }).success).toBe(false);
  });

  it('public list metadata has no value, ciphertext, hash, reference or revision per entry', () => {
    const parsed = PersonalizationSecretListResponseSchema.parse({
      ok: true,
      contractVersion: 1,
      operationId: OPERATION_ID,
      revision: 4,
      secrets: [{ name: 'ZOTERO_API_KEY', createdAt: 100, updatedAt: 200 }],
    });
    const entry = parsed.ok ? parsed.secrets[0] : undefined;
    expect(Object.keys(entry ?? {}).sort()).toEqual(['createdAt', 'name', 'updatedAt']);
    expect(JSON.stringify(parsed)).not.toContain('value');
    expect(JSON.stringify(parsed)).not.toContain('ciphertext');
  });

  it('public set and remove responses never contain plaintext', () => {
    const set = PersonalizationSecretSetResponseSchema.parse({
      ok: true,
      contractVersion: 1,
      operationId: OPERATION_ID,
      revision: 1,
      secret: { name: 'ZOTERO_API_KEY', createdAt: 100, updatedAt: 100 },
    });
    expect(set).not.toHaveProperty('value');
    expect(PersonalizationSecretRemoveRequestSchema.safeParse({
      contractVersion: 1,
      operationId: OPERATION_ID,
      expectedRevision: 1,
      name: 'ZOTERO_API_KEY',
    }).success).toBe(true);
  });

  it('turns malformed main-process responses into fixed non-reflective recovery', () => {
    const raw = {
      ok: true,
      contractVersion: 1,
      operationId: OPERATION_ID,
      revision: 1,
      secret: { name: 'ZOTERO_API_KEY', createdAt: 1, updatedAt: 1, value: 'must-not-reflect' },
    };
    const decoded = decodePersonalizationSecretSetResponse(raw, OPERATION_ID);
    expect(decoded).toEqual({
      ok: false,
      contractVersion: 1,
      operationId: OPERATION_ID,
      code: 'invalid_request',
    });
    expect(JSON.stringify(decoded)).not.toContain('must-not-reflect');
    expect(decodePersonalizationSecretListResponse({ ok: true, secrets: [{ value: 'leak' }] }, OPERATION_ID))
      .toEqual({ ok: false, contractVersion: 1, operationId: OPERATION_ID, code: 'invalid_request' });
  });
});
