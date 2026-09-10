import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CurrentAffairsArtifactService } from '../../engine/writing/CurrentAffairsArtifactService.js';

describe('CurrentAffairs artifact post-rename failure semantics', () => {
  const roots: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const root of roots.splice(0)) {
      try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* cleanup */ }
    }
  });

  function setup() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-publish-failure-'));
    roots.push(root);
    const staging = path.join(root, '.stage');
    fs.mkdirSync(staging);
    fs.writeFileSync(path.join(staging, 'payload.txt'), 'payload', 'utf8');
    return { root, staging, target: path.join(root, 'artifact-a', 'v1'), service: new CurrentAffairsArtifactService(root) };
  }

  it('removes the final target and throws when post-rename durability fails but rollback succeeds', () => {
    const { staging, target, service } = setup();
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');

    expect(() => service.publishStaged(staging, target)).toThrow(/artifact removed/u);
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.existsSync(staging)).toBe(false);
  });

  it('reports visibility_uncertain when post-rename durability and rollback both fail', () => {
    const { staging, target, service } = setup();
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    const originalRemove = fs.rmSync;
    vi.spyOn(fs, 'rmSync').mockImplementation(((candidate: fs.PathLike, options?: fs.RmDirOptions) => {
      if (path.resolve(String(candidate)) === path.resolve(target)) throw new Error('injected rollback failure');
      return originalRemove(candidate, options);
    }) as typeof fs.rmSync);

    expect(service.publishStaged(staging, target)).toBe('visibility_uncertain');
    expect(fs.existsSync(target)).toBe(true);
    expect(fs.existsSync(staging)).toBe(false);
  });
});
