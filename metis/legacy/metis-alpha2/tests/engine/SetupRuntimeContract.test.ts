/**
 * REVIEW-465 P0 red tests: SettingsProviderProbeRequest strict keyMode contract.
 */
import { describe, it, expect } from 'vitest';
import {
  decodeSettingsProviderProbeRequest,
} from '../../engine/runtime/SetupRuntimeContract.js';

const VALID_BASE_URL = 'https://api.openai.com/v1';
const VALID_MODEL = 'gpt-4o';
const VALID_OP_ID = 'test-op-001';
const VALID_NEW_KEY = 'sk-test-key-12345678';

describe('SettingsProviderProbeRequest — saved mode', () => {
  it('RED: accepts valid saved-mode request (no newApiKey)', () => {
    const result = decodeSettingsProviderProbeRequest({
      version: 1,
      operationId: VALID_OP_ID,
      keyMode: 'saved',
      baseUrl: VALID_BASE_URL,
      model: VALID_MODEL,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.keyMode).toBe('saved');
      expect(result.value.newApiKey).toBeUndefined();
    }
  });

  it('RED: rejects saved-mode request with newApiKey present', () => {
    const result = decodeSettingsProviderProbeRequest({
      version: 1,
      operationId: VALID_OP_ID,
      keyMode: 'saved',
      baseUrl: VALID_BASE_URL,
      model: VALID_MODEL,
      newApiKey: VALID_NEW_KEY,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.recovery.code).toBe('setup_request_unavailable');
    }
  });

  it('RED: rejects saved-mode request with empty newApiKey string', () => {
    const result = decodeSettingsProviderProbeRequest({
      version: 1,
      operationId: VALID_OP_ID,
      keyMode: 'saved',
      baseUrl: VALID_BASE_URL,
      model: VALID_MODEL,
      newApiKey: '',
    });
    expect(result.ok).toBe(false);
  });
});

describe('SettingsProviderProbeRequest — replace mode', () => {
  it('RED: accepts valid replace-mode request with newApiKey', () => {
    const result = decodeSettingsProviderProbeRequest({
      version: 1,
      operationId: VALID_OP_ID,
      keyMode: 'replace',
      baseUrl: VALID_BASE_URL,
      model: VALID_MODEL,
      newApiKey: VALID_NEW_KEY,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.keyMode).toBe('replace');
      expect(result.value.newApiKey).toBe(VALID_NEW_KEY);
    }
  });

  it('RED: rejects replace-mode request without newApiKey', () => {
    const result = decodeSettingsProviderProbeRequest({
      version: 1,
      operationId: VALID_OP_ID,
      keyMode: 'replace',
      baseUrl: VALID_BASE_URL,
      model: VALID_MODEL,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.recovery.code).toBe('setup_request_unavailable');
    }
  });

  it('RED: rejects replace-mode with too-short newApiKey (<8 chars)', () => {
    const result = decodeSettingsProviderProbeRequest({
      version: 1,
      operationId: VALID_OP_ID,
      keyMode: 'replace',
      baseUrl: VALID_BASE_URL,
      model: VALID_MODEL,
      newApiKey: 'short',
    });
    expect(result.ok).toBe(false);
  });

  it('RED: rejects replace-mode with control char in newApiKey', () => {
    const result = decodeSettingsProviderProbeRequest({
      version: 1,
      operationId: VALID_OP_ID,
      keyMode: 'replace',
      baseUrl: VALID_BASE_URL,
      model: VALID_MODEL,
      newApiKey: 'sk-test-\x00-key-12345678',
    });
    expect(result.ok).toBe(false);
  });
});

describe('SettingsProviderProbeRequest — boundary', () => {
  it('RED: rejects request without keyMode', () => {
    const result = decodeSettingsProviderProbeRequest({
      version: 1,
      operationId: VALID_OP_ID,
      baseUrl: VALID_BASE_URL,
      model: VALID_MODEL,
    });
    expect(result.ok).toBe(false);
  });

  it('RED: rejects request with invalid keyMode value', () => {
    const result = decodeSettingsProviderProbeRequest({
      version: 1,
      operationId: VALID_OP_ID,
      keyMode: 'invalid_mode',
      baseUrl: VALID_BASE_URL,
      model: VALID_MODEL,
    });
    expect(result.ok).toBe(false);
  });

  it('RED: rejects request with extra unknown fields', () => {
    const result = decodeSettingsProviderProbeRequest({
      version: 1,
      operationId: VALID_OP_ID,
      keyMode: 'saved',
      baseUrl: VALID_BASE_URL,
      model: VALID_MODEL,
      extraField: 'should be rejected',
    });
    expect(result.ok).toBe(false);
  });

  it('RED: newApiKey cannot be empty string in replace mode (min 8)', () => {
    const result = decodeSettingsProviderProbeRequest({
      version: 1,
      operationId: VALID_OP_ID,
      keyMode: 'replace',
      baseUrl: VALID_BASE_URL,
      model: VALID_MODEL,
      newApiKey: '',
    });
    expect(result.ok).toBe(false);
  });

  it('GREEN: baseUrl must be https', () => {
    const result = decodeSettingsProviderProbeRequest({
      version: 1,
      operationId: VALID_OP_ID,
      keyMode: 'saved',
      baseUrl: 'http://unsafe.example.com/v1',
      model: VALID_MODEL,
    });
    expect(result.ok).toBe(false);
  });

  it('GREEN: accepts localhost http in saved mode', () => {
    const result = decodeSettingsProviderProbeRequest({
      version: 1,
      operationId: VALID_OP_ID,
      keyMode: 'saved',
      baseUrl: 'http://localhost:11434/v1',
      model: VALID_MODEL,
    });
    expect(result.ok).toBe(true);
  });
});
