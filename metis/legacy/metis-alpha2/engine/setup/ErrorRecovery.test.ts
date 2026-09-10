/**
 * METIS-306 — Error recovery tests.
 *
 * Verifies each error category is classified correctly and produces a user-actionable
 * RecoveredError with phase/impact/automaticAction/nextStep.
 */

import { describe, it, expect } from 'vitest';
import { classifyError, recoverError } from './ErrorRecovery.js';

describe('METIS-306 ErrorRecovery — classification', () => {
  const cases: Array<[string, number | string | undefined, ReturnType<typeof classifyError>]> = [
    ['Provider error 401: Unauthorized', 401, 'auth'],
    ['Invalid API key', undefined, 'auth'],
    ['Provider error 403: Forbidden', 403, 'auth'],
    ['Provider error 429: Too Many Requests', 429, 'quota'],
    ['rate limit exceeded', undefined, 'quota'],
    ['Provider error 500', 500, 'transient'],
    ['Request timeout', undefined, 'transient'],
    ['ETIMEDOUT', undefined, 'transient'],
    ['ENOTFOUND offline', undefined, 'network'],
    ['ECONNRESET', undefined, 'network'],
    ['无法连接到模型服务', undefined, 'network'],
    ['ENOSPC disk full', undefined, 'local_resource'],
    ['磁盘空间不足', undefined, 'local_resource'],
    ['EACCES permission denied', undefined, 'local_resource'],
    ['hash mismatch — archive rejected', undefined, 'corrupt'],
    ['文件已损坏', undefined, 'corrupt'],
    ['process crashed', undefined, 'crash'],
    ['Provider error 404', 404, 'not_supported'],
    ['model not found', undefined, 'not_supported'],
    ['something weird', undefined, 'unknown'],
  ];
  for (const [msg, code, expected] of cases) {
    it(`classifies "${msg.slice(0, 30)}" (${code ?? '-'}) as ${expected}`, () => {
      expect(classifyError(msg, code)).toBe(expected);
    });
  }
});

describe('METIS-306 ErrorRecovery — recovered structure', () => {
  it('every recovered error has phase, impact, automaticAction, nextStep, userMessage', () => {
    for (const cat of ['auth', 'quota', 'transient', 'network', 'local_resource', 'corrupt', 'crash', 'not_supported', 'unknown'] as const) {
      const r = recoverError(`test ${cat}`, 'chat', cat === 'auth' ? 401 : undefined);
      expect(r.phase).toBe('chat');
      expect(r.userMessage.length).toBeGreaterThan(0);
      expect(r.impact.length).toBeGreaterThan(0);
      expect(r.automaticAction.length).toBeGreaterThan(0);
      expect(r.nextStep.length).toBeGreaterThan(0);
      expect(r.recoverable).toBe(true);
    }
  });

  it('auth error points the user to settings to re-enter the key', () => {
    const r = recoverError('401 Unauthorized', 'chat', 401);
    expect(r.category).toBe('auth');
    expect(r.nextStep).toMatch(/设置|密钥/);
  });

  it('network error mentions checking the connection', () => {
    const r = recoverError('ENOTFOUND', 'provider_probe');
    expect(r.category).toBe('network');
    expect(r.nextStep).toMatch(/网络|连接/);
  });

  it('disk-full error tells user to free space', () => {
    const r = recoverError('ENOSPC disk full', 'artifact_save');
    expect(r.category).toBe('local_resource');
    expect(r.nextStep).toMatch(/磁盘|空间|权限/);
  });

  it('corrupt error mentions restoring from backup', () => {
    const r = recoverError('hash mismatch', 'runtime_prepare');
    expect(r.category).toBe('corrupt');
    expect(r.nextStep).toMatch(/备份|恢复|重新/);
  });
});
