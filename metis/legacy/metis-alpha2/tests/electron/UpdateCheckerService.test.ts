/**
 * Tests for UpdateCheckerService — GitHub release version comparison.
 */

import { describe, it, expect, vi } from 'vitest';
import { UpdateCheckerService } from '../../electron/UpdateCheckerService.js';

function jsonResponse(payload: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => payload,
  } as unknown as Response;
}

describe('UpdateCheckerService', () => {
  it('reports hasUpdate when the published tag is newer', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ tag_name: 'v0.2.0', html_url: 'https://github.com/x/releases/tag/v0.2.0' }));
    const svc = new UpdateCheckerService({ apiUrl: 'https://api.github.com/repos/x/releases/latest', fetchImpl });
    const result = await svc.check('0.1.0-alpha.2');
    expect(result.hasUpdate).toBe(true);
    expect(result.latestVersion).toBe('v0.2.0');
    expect(result.releaseUrl).toBe('https://github.com/x/releases/tag/v0.2.0');
  });

  it('reports no update when versions match', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ tag_name: 'v0.1.0-alpha.2', html_url: 'https://github.com/x/releases' }));
    const svc = new UpdateCheckerService({ apiUrl: 'https://api.github.com/repos/x/releases/latest', fetchImpl });
    const result = await svc.check('0.1.0-alpha.2');
    expect(result.hasUpdate).toBe(false);
    expect(result.latestVersion).toBe('v0.1.0-alpha.2');
  });

  it('reports no update when the published tag is older', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ tag_name: 'v0.1.0', html_url: 'https://github.com/x/releases' }));
    const svc = new UpdateCheckerService({ apiUrl: 'https://api.github.com/repos/x/releases/latest', fetchImpl });
    const result = await svc.check('0.2.0');
    expect(result.hasUpdate).toBe(false);
  });

  it('handles a non-2xx API response as an error, not an update', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ message: 'rate limited' }, false, 403));
    const svc = new UpdateCheckerService({ apiUrl: 'https://api.github.com/repos/x/releases/latest', fetchImpl });
    const result = await svc.check('0.1.0');
    expect(result.hasUpdate).toBe(false);
    expect(result.error).toContain('403');
  });

  it('handles network failure gracefully', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('network down'); });
    const svc = new UpdateCheckerService({ apiUrl: 'https://api.github.com/repos/x/releases/latest', fetchImpl });
    const result = await svc.check('0.1.0');
    expect(result.hasUpdate).toBe(false);
    expect(result.error).toContain('network down');
  });
});
