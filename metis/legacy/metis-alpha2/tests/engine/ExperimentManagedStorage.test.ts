import fs from 'node:fs';
import path from 'node:path';
import { realTempRoot } from '../electron/helpers/realTempDir';
import { afterEach, describe, expect, it } from 'vitest';
import {
  reconcileExperimentManagedRoot,
} from '../../engine/persistence/ExperimentAttachmentRepository.js';

describe('experiment managed storage reconciliation', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  it('removes temp and unreferenced final files while retaining referenced files', () => {
    const root = fs.mkdtempSync(path.join(realTempRoot(), 'metis-exp-reconcile-'));
    roots.push(root);
    const directory = path.join(root, 'experiment');
    fs.mkdirSync(directory);
    const referenced = path.join(directory, 'referenced.js');
    const orphan = path.join(directory, 'orphan.js');
    const temporary = path.join(directory, '.attach-dead.tmp');
    fs.writeFileSync(referenced, 'kept');
    fs.writeFileSync(orphan, 'remove');
    fs.writeFileSync(temporary, 'remove');
    expect(reconcileExperimentManagedRoot(root, [referenced])).toEqual({
      removedTemporaryFiles: 1,
      removedOrphanFiles: 1,
    });
    expect(fs.readFileSync(referenced, 'utf8')).toBe('kept');
    expect(fs.existsSync(orphan)).toBe(false);
    expect(fs.existsSync(temporary)).toBe(false);
  });

  it('fails closed when the managed root is a symlink or junction', () => {
    const parent = fs.mkdtempSync(path.join(realTempRoot(), 'metis-exp-reconcile-link-'));
    roots.push(parent);
    const real = path.join(parent, 'real');
    const linked = path.join(parent, 'linked');
    fs.mkdirSync(real);
    fs.symlinkSync(real, linked, process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => reconcileExperimentManagedRoot(linked, [])).toThrow(/managed root/u);
  });

  it('pre-scans nested entries and performs no cleanup when a symlink is present', () => {
    const root = fs.mkdtempSync(path.join(realTempRoot(), 'metis-exp-reconcile-nested-'));
    roots.push(root);
    const directory = path.join(root, 'experiment');
    const outside = path.join(root, 'outside');
    fs.mkdirSync(directory);
    fs.mkdirSync(outside);
    const orphan = path.join(directory, 'orphan.js');
    fs.writeFileSync(orphan, 'must remain after fail-closed scan');
    fs.symlinkSync(outside, path.join(directory, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => reconcileExperimentManagedRoot(root, [])).toThrow(/symbolic link/u);
    expect(fs.readFileSync(orphan, 'utf8')).toBe('must remain after fail-closed scan');
  });
});
