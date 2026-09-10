import { describe, expect, it, vi } from 'vitest';
import { createSecureExternalOpenHandler } from '../../electron/SecureExternalOpenHandler.js';

describe('secure external-open IPC handler', () => {
  it('opens only a canonical clean HTTPS URL after authorization', async () => {
    const authorize = vi.fn();
    const openExternal = vi.fn().mockResolvedValue(undefined);
    const handler = createSecureExternalOpenHandler({ authorize, openExternal });

    await expect(handler({ frame: 'main' }, 'https://例子.测试/paper')).resolves.toEqual({
      success: true,
    });
    expect(authorize).toHaveBeenCalledTimes(1);
    expect(openExternal).toHaveBeenCalledWith('https://xn--fsqu00a.xn--0zwm56d/paper');
  });

  it('never calls the shell for an unauthorized sender', async () => {
    const openExternal = vi.fn();
    const handler = createSecureExternalOpenHandler({
      authorize: () => { throw new Error('unauthorized'); },
      openExternal,
    });

    await expect(handler({}, 'https://example.test/paper')).resolves.toEqual({
      success: false,
      error: 'External link blocked',
    });
    expect(openExternal).not.toHaveBeenCalled();
  });

  it.each([
    'http://example.test/paper',
    'https://user:password@example.test/paper',
    'https://example.test/paper?token=secret',
    'file:///C:/Users/researcher/private.pdf',
  ])('never calls the shell for unsafe URL %s', async (url) => {
    const openExternal = vi.fn();
    const handler = createSecureExternalOpenHandler({
      authorize: () => undefined,
      openExternal,
    });

    await expect(handler({}, url)).resolves.toEqual({
      success: false,
      error: 'External link blocked',
    });
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('returns a fixed failure without reflecting a shell error', async () => {
    const handler = createSecureExternalOpenHandler({
      authorize: () => undefined,
      openExternal: async () => { throw new Error('Authorization: Bearer shell-secret'); },
    });

    const result = await handler({}, 'https://example.test/paper');
    expect(result).toEqual({ success: false, error: 'External link could not be opened' });
    expect(JSON.stringify(result)).not.toContain('shell-secret');
  });
});
