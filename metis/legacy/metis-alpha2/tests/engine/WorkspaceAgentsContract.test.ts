import { describe, expect, it } from 'vitest';
import {
  WORKSPACE_AGENTS_LIMITS,
  WORKSPACE_AGENTS_FILENAME,
  WORKSPACE_METIS_FILENAME,
  LEGACY_WORKSPACE_AGENTS_FILENAME,
  WorkspaceAgentsContentSchema,
  WorkspaceAgentsWriteRequestSchema,
  WorkspaceAgentsMutationResultSchema,
  WorkspaceAgentsViewSchema,
  decodeWorkspaceAgentsView,
  decodeWorkspaceAgentsWriteRequest,
  decodeWorkspaceAgentsMutationResult,
  createWorkspaceAgentsViewEmpty,
  createWorkspaceAgentsFailure,
  createWorkspaceAgentsCASConflict,
} from '../../engine/runtime/WorkspaceAgentsContract.js';
import { hashWorkspaceAgentsContent } from '../../engine/memory/WorkspaceAgentsHash.js';

// ─── Helpers ──────────────────────────────────────────────────

function makeValidContent(): string {
  return '# Metis.md\n\n项目级指令和上下文。\n- 规则一\n- 规则二\n';
}

function contentOfLength(n: number): string {
  return 'x'.repeat(n);
}

// ─── Constants ────────────────────────────────────────────────

describe('workspace agents constants', () => {
  it('uses Metis.md publicly while retaining the legacy filename for migration', () => {
    expect(WORKSPACE_METIS_FILENAME).toBe('Metis.md');
    expect(WORKSPACE_AGENTS_FILENAME).toBe('Metis.md');
    expect(LEGACY_WORKSPACE_AGENTS_FILENAME).toBe('AGENTS.md');
  });

  it('enforces a 50 000 character limit', () => {
    expect(WORKSPACE_AGENTS_LIMITS.maxChars).toBe(50_000);
  });
});

// ─── Content schema: C0 / C1 rejection ───────────────────────

describe('workspace agents content schema — control character rejection', () => {
  it('accepts normal text with CJK, tabs, newlines and carriage returns', () => {
    const content = '# 标题\n\t缩进行\n\r\n正常文本 — 破折号。';
    expect(WorkspaceAgentsContentSchema.safeParse(content).success).toBe(true);
  });

  it('rejects NUL (U+0000)', () => {
    expect(WorkspaceAgentsContentSchema.safeParse('bad\u0000content').success).toBe(false);
  });

  it('rejects BEL (U+0007)', () => {
    expect(WorkspaceAgentsContentSchema.safeParse('bad\u0007content').success).toBe(false);
  });

  it('rejects VT (U+000B)', () => {
    expect(WorkspaceAgentsContentSchema.safeParse('bad\u000Bcontent').success).toBe(false);
  });

  it('rejects FF (U+000C)', () => {
    expect(WorkspaceAgentsContentSchema.safeParse('bad\u000Ccontent').success).toBe(false);
  });

  it('rejects RS (U+001E)', () => {
    expect(WorkspaceAgentsContentSchema.safeParse('bad\u001Econtent').success).toBe(false);
  });

  it('rejects US (U+001F)', () => {
    expect(WorkspaceAgentsContentSchema.safeParse('bad\u001Fcontent').success).toBe(false);
  });

  it('rejects DEL (U+007F) — C1 start', () => {
    expect(WorkspaceAgentsContentSchema.safeParse('bad\u007Fcontent').success).toBe(false);
  });

  it('rejects APC (U+009F) — C1 end', () => {
    expect(WorkspaceAgentsContentSchema.safeParse('bad\u009Fcontent').success).toBe(false);
  });

  it('allows tab (\\t = U+0009)', () => {
    expect(WorkspaceAgentsContentSchema.safeParse('col1\tcol2').success).toBe(true);
  });

  it('allows newline (\\n = U+000A)', () => {
    expect(WorkspaceAgentsContentSchema.safeParse('line1\nline2').success).toBe(true);
  });

  it('allows carriage return (\\r = U+000D)', () => {
    expect(WorkspaceAgentsContentSchema.safeParse('line1\r\nline2').success).toBe(true);
  });
});

// ─── Content schema: length boundary ─────────────────────────

describe('workspace agents content schema — length boundary', () => {
  it('accepts content at exactly 50 000 characters', () => {
    expect(WorkspaceAgentsContentSchema.safeParse(contentOfLength(50_000)).success).toBe(true);
  });

  it('rejects content at 50 001 characters', () => {
    expect(WorkspaceAgentsContentSchema.safeParse(contentOfLength(50_001)).success).toBe(false);
  });

  it('accepts empty string', () => {
    expect(WorkspaceAgentsContentSchema.safeParse('').success).toBe(true);
  });
});

// ─── Content hash ─────────────────────────────────────────────

describe('workspace agents content hash', () => {
  it('produces a 64-char hex SHA-256', () => {
    const hash = hashWorkspaceAgentsContent('test');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic for identical content', () => {
    expect(hashWorkspaceAgentsContent('abc')).toBe(hashWorkspaceAgentsContent('abc'));
  });

  it('differs for different content', () => {
    expect(hashWorkspaceAgentsContent('abc')).not.toBe(hashWorkspaceAgentsContent('abd'));
  });

  it('handles CJK content', () => {
    const hash = hashWorkspaceAgentsContent('# 中文内容\n\n测试');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ─── Write request schema (CAS) ───────────────────────────────

describe('workspace agents write request — CAS fields', () => {
  it('accepts a valid write request with expectedVersion', () => {
    const req = { projectId: 'test-proj', content: makeValidContent(), expectedVersion: 0 };
    expect(WorkspaceAgentsWriteRequestSchema.safeParse(req).success).toBe(true);
  });

  it('rejects write request missing expectedVersion', () => {
    const req = { content: makeValidContent() };
    expect(WorkspaceAgentsWriteRequestSchema.safeParse(req).success).toBe(false);
  });

  it('rejects write request with extra fields (strict)', () => {
    const req = { projectId: 'test-proj', content: makeValidContent(), expectedVersion: 0, rogue: true };
    expect(WorkspaceAgentsWriteRequestSchema.safeParse(req).success).toBe(false);
  });

  it('rejects negative expectedVersion', () => {
    const req = { content: makeValidContent(), expectedVersion: -1 };
    expect(WorkspaceAgentsWriteRequestSchema.safeParse(req).success).toBe(false);
  });

  it('rejects content with C0 control char in write request', () => {
    const req = { projectId: 'test-proj', content: 'badcontent', expectedVersion: 0 };
    expect(WorkspaceAgentsWriteRequestSchema.safeParse(req).success).toBe(false);
  });
});

// ─── View schema ──────────────────────────────────────────────

describe('workspace agents view schema', () => {
  it('accepts a valid view', () => {
    const view = { exists: true, content: 'hello', version: 3, contentHash: 'abc123', projectId: 'test-proj' };
    expect(WorkspaceAgentsViewSchema.safeParse(view).success).toBe(true);
  });

  it('view requires projectId', () => {
    const without = { exists: true, content: 'hello', version: 3, contentHash: 'abc123' };
    expect(WorkspaceAgentsViewSchema.safeParse(without).success).toBe(false);
  });

  it('empty factory returns exists=false, version=0', () => {
    const empty = createWorkspaceAgentsViewEmpty();
    expect(empty.exists).toBe(false);
    expect(empty.version).toBe(0);
    expect(empty.content).toBe('');
  });

  it('decoder returns empty on garbage', () => {
    expect(decodeWorkspaceAgentsView(null)).toEqual(createWorkspaceAgentsViewEmpty());
    expect(decodeWorkspaceAgentsView({})).toEqual(createWorkspaceAgentsViewEmpty());
  });
});

// ─── Mutation result: discriminated union ────────────────────

describe('workspace agents mutation result — discriminated union', () => {
  it('accepts success result with version and hash', () => {
    const result = { success: true as const, code: 'saved' as const, version: 5, contentHash: 'deadbeef' };
    expect(WorkspaceAgentsMutationResultSchema.safeParse(result).success).toBe(true);
  });

  it('accepts cas_conflict with currentVersion and currentContentHash', () => {
    const result = {
      success: false as const,
      code: 'cas_conflict' as const,
      currentVersion: 4,
      currentContentHash: 'abc',
    };
    expect(WorkspaceAgentsMutationResultSchema.safeParse(result).success).toBe(true);
  });

  it('accepts io_error failure', () => {
    const result = { success: false as const, code: 'io_error' as const };
    expect(WorkspaceAgentsMutationResultSchema.safeParse(result).success).toBe(true);
  });

  it('accepts content_invalid failure', () => {
    const result = { success: false as const, code: 'content_invalid' as const };
    expect(WorkspaceAgentsMutationResultSchema.safeParse(result).success).toBe(true);
  });

  it('accepts agents_unavailable failure', () => {
    const result = { success: false as const, code: 'agents_unavailable' as const };
    expect(WorkspaceAgentsMutationResultSchema.safeParse(result).success).toBe(true);
  });

  it('accepts external_conflict failure', () => {
    const result = { success: false as const, code: 'external_conflict' as const };
    expect(WorkspaceAgentsMutationResultSchema.safeParse(result).success).toBe(true);
  });

  it('accepts project_not_found failure', () => {
    const result = { success: false as const, code: 'project_not_found' as const };
    expect(WorkspaceAgentsMutationResultSchema.safeParse(result).success).toBe(true);
  });

  it('rejects success result without version', () => {
    const result = { success: true, code: 'saved' };
    expect(WorkspaceAgentsMutationResultSchema.safeParse(result).success).toBe(false);
  });

  it('rejects cas_conflict without currentVersion', () => {
    const result = { success: false, code: 'cas_conflict' };
    expect(WorkspaceAgentsMutationResultSchema.safeParse(result).success).toBe(false);
  });
});

// ─── Factory + decoder helpers ────────────────────────────────

describe('workspace agents factory and decoder helpers', () => {
  it('createWorkspaceAgentsFailure returns agents_unavailable by default', () => {
    // test each code path
    expect(createWorkspaceAgentsFailure('io_error').code).toBe('io_error');
    expect(createWorkspaceAgentsFailure('content_invalid').code).toBe('content_invalid');
    expect(createWorkspaceAgentsFailure('agents_unavailable').code).toBe('agents_unavailable');
    expect(createWorkspaceAgentsFailure('project_not_found').code).toBe('project_not_found');
  });

  it('createWorkspaceAgentsCASConflict returns cas_conflict with version+hash', () => {
    const conflict = createWorkspaceAgentsCASConflict(7, 'hash123');
    expect(conflict.success).toBe(false);
    expect(conflict.code).toBe('cas_conflict');
    if (conflict.code === 'cas_conflict') {
      expect(conflict.currentVersion).toBe(7);
      expect(conflict.currentContentHash).toBe('hash123');
    }
  });

  it('decodeWorkspaceAgentsMutationResult returns agents_unavailable on garbage', () => {
    expect(decodeWorkspaceAgentsMutationResult(null).code).toBe('agents_unavailable');
    expect(decodeWorkspaceAgentsMutationResult({}).code).toBe('agents_unavailable');
  });

  it('decodeWorkspaceAgentsWriteRequest returns undefined on invalid', () => {
    expect(decodeWorkspaceAgentsWriteRequest(null)).toBeUndefined();
    expect(decodeWorkspaceAgentsWriteRequest({})).toBeUndefined();
    // Missing projectId returns undefined
    expect(decodeWorkspaceAgentsWriteRequest({ content: 'ok', expectedVersion: 0 })).toBeUndefined();
    // Valid with projectId returns defined
    expect(decodeWorkspaceAgentsWriteRequest({ projectId: 'test-proj', content: 'ok', expectedVersion: 0 })).toBeDefined();
  });
});
