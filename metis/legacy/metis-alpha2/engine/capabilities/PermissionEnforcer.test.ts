/**
 * METIS-207 — Capability Permission Model tests.
 *
 * Verifies: capability declares → tool allowed; undeclared → rejected; unknown tool
 * rejected; path traversal blocked; unauthorized network/command cannot run.
 */

import { describe, it, expect } from 'vitest';
import {
  checkToolPermission,
  enforceToolPermission,
  permissionRequiredForTool,
  toolsAllowedByPermission,
} from './PermissionEnforcer.js';
import { SEVEN_CAPABILITY_PACKS } from './packs/index.js';

// Pick capabilities by their characteristic permission sets.
const reader = SEVEN_CAPABILITY_PACKS.find((p) => p.id === 'research-design')!; // read_source + search_web
const writer = SEVEN_CAPABILITY_PACKS.find((p) => p.id === 'argumentation-writing')!; // read_source + write_file
const quant = SEVEN_CAPABILITY_PACKS.find((p) => p.id === 'quantitative-analysis')!; // read_source + execute_code + write_file

describe('METIS-207 PermissionEnforcer — allow within declared permission', () => {
  it('allows read_file when capability declares read_source', () => {
    expect(checkToolPermission('read_file', { path: 'papers/a.pdf' }, reader).allowed).toBe(true);
  });

  it('allows write_file when capability declares write_file', () => {
    expect(checkToolPermission('write_file', { path: 'out/draft.md' }, writer).allowed).toBe(true);
  });

  it('allows run_python when capability declares execute_code', () => {
    expect(checkToolPermission('run_python', { code: 'print(1)' }, quant).allowed).toBe(true);
  });
});

describe('METIS-207 PermissionEnforcer — reject outside declared permission', () => {
  it('rejects write_file when capability only has read_source (no write_file)', () => {
    const d = checkToolPermission('write_file', { path: 'x' }, reader);
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.code).toBe('not_permitted');
  });

  it('rejects run_python when capability lacks execute_code', () => {
    const d = checkToolPermission('run_python', {}, writer);
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.code).toBe('not_permitted');
  });

  it('rejects an unknown tool name', () => {
    const d = checkToolPermission('delete_database', {}, writer);
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.code).toBe('unknown_tool');
  });

  it('enforce throws on denial (fail-fast for ToolDispatcher)', () => {
    expect(() => enforceToolPermission('run_python', {}, reader)).toThrow(/Permission denied/);
  });
});

describe('METIS-207 PermissionEnforcer — path traversal', () => {
  it('blocks read_file with traversal in path', () => {
    const d = checkToolPermission('read_file', { path: '../../etc/passwd' }, reader);
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.code).toBe('path_traversal');
  });

  it('blocks write_file with traversal in filePath', () => {
    const d = checkToolPermission('write_file', { filePath: 'out/../../../evil.txt' }, writer);
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.code).toBe('path_traversal');
  });

  it('allows a normal relative path', () => {
    expect(checkToolPermission('read_file', { path: 'papers/a.pdf' }, reader).allowed).toBe(true);
  });
});

describe('METIS-207 PermissionEnforcer — mapping helpers', () => {
  it('every declared permission maps to a non-empty tool list', () => {
    for (const cap of SEVEN_CAPABILITY_PACKS) {
      for (const perm of cap.permissions) {
        expect(toolsAllowedByPermission(perm).length, `${cap.id}.${perm}`).toBeGreaterThan(0);
      }
    }
  });

  it('permissionRequiredForTool is consistent with toolsAllowedByPermission', () => {
    const perms: Array<'read_source' | 'search_web' | 'write_file' | 'execute_code' | 'call_external' | 'access_sensitive'> =
      ['read_source', 'search_web', 'write_file', 'execute_code', 'call_external', 'access_sensitive'];
    for (const perm of perms) {
      for (const tool of toolsAllowedByPermission(perm)) {
        expect(permissionRequiredForTool(tool)).toBe(perm);
      }
    }
  });
});
