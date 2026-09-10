/**
 * METIS-301 — First-run setup tests.
 *
 * Verifies: only 3 inputs; sensible defaults; validation rules; secure-storage gate
 * (no save when key cannot be secured); happy path.
 */

import { describe, it, expect } from 'vitest';
import {
  FIRST_RUN_DEFAULTS,
  initialSetupState,
  validateFirstRunInput,
  assertSecureStorageAvailable,
  attemptFirstRunSave,
  type SecureStorageProbe,
} from './FirstRunSetup.js';

const OK_PROBE: SecureStorageProbe = { isAvailable: () => true };
const BAD_PROBE: SecureStorageProbe = { isAvailable: () => false };

describe('METIS-301 FirstRunSetup — defaults & initial state', () => {
  it('provides sensible defaults for baseUrl and model (user only MUST type the key)', () => {
    expect(FIRST_RUN_DEFAULTS.baseUrl.startsWith('http')).toBe(true);
    expect(FIRST_RUN_DEFAULTS.model.length).toBeGreaterThan(0);
  });

  it('initial state starts with defaults pre-filled and step awaiting_input', () => {
    const s = initialSetupState();
    expect(s.step).toBe('awaiting_input');
    expect(s.input.baseUrl).toBe(FIRST_RUN_DEFAULTS.baseUrl);
    expect(s.input.model).toBe(FIRST_RUN_DEFAULTS.model);
    expect(s.input.apiKey).toBe('');
    expect(s.defaultsApplied).toBe(true);
  });
});

describe('METIS-301 FirstRunSetup — validation', () => {
  it('accepts a well-formed 3-input set', () => {
    const r = validateFirstRunInput({ baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-1234567890', model: 'gpt-4o' });
    expect(r.valid).toBe(true);
    expect(r.errors).toHaveLength(0);
  });

  it('rejects an empty baseUrl', () => {
    expect(validateFirstRunInput({ baseUrl: '', apiKey: 'sk-1234567890', model: 'gpt-4o' }).valid).toBe(false);
  });

  it('rejects a malformed baseUrl', () => {
    expect(validateFirstRunInput({ baseUrl: 'not a url', apiKey: 'sk-1234567890', model: 'gpt-4o' }).valid).toBe(false);
  });

  it('rejects a non-http protocol', () => {
    expect(validateFirstRunInput({ baseUrl: 'ftp://x', apiKey: 'sk-1234567890', model: 'gpt-4o' }).valid).toBe(false);
  });

  it('rejects a too-short apiKey', () => {
    expect(validateFirstRunInput({ baseUrl: 'https://api.openai.com/v1', apiKey: 'sk', model: 'gpt-4o' }).valid).toBe(false);
  });

  it('rejects an empty model', () => {
    expect(validateFirstRunInput({ baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-1234567890', model: '' }).valid).toBe(false);
  });
});

describe('METIS-301 FirstRunSetup — secure-storage gate', () => {
  it('assertSecureStorageAvailable returns ok when available', () => {
    expect(assertSecureStorageAvailable(OK_PROBE).ok).toBe(true);
  });

  it('assertSecureStorageAvailable blocks when NOT available (no plaintext save)', () => {
    const r = assertSecureStorageAvailable(BAD_PROBE);
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  });
});

describe('METIS-301 FirstRunSetup — full save flow', () => {
  it('succeeds only with valid input + available secure storage', () => {
    const r = attemptFirstRunSave({ baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-1234567890', model: 'gpt-4o' }, OK_PROBE);
    expect(r.step).toBe('done');
    expect(r.config?.apiKey).toBe('sk-1234567890');
  });

  it('fails when secure storage is unavailable, even with valid input', () => {
    const r = attemptFirstRunSave({ baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-1234567890', model: 'gpt-4o' }, BAD_PROBE);
    expect(r.step).toBe('error');
    expect(r.error).toMatch(/安全存储不可用|secure/i);
  });

  it('fails with a consolidated error message listing all validation problems', () => {
    const r = attemptFirstRunSave({ baseUrl: '', apiKey: '', model: '' }, OK_PROBE);
    expect(r.step).toBe('error');
    expect(r.error).toMatch(/；/); // multiple errors joined
  });
});
