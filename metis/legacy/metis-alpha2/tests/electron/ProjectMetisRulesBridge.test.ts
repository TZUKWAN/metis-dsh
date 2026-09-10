import { describe, expect, it } from 'vitest';
import { projectMetisRulesFromWorkspace, projectMetisRulesId } from '../../electron/ProjectMetisRulesBridge.js';
import { hashWorkspaceAgentsContent } from '../../engine/memory/WorkspaceAgentsHash.js';

const PROJECT_ID = 'project-alpha';
const MARKDOWN = '# Metis.md\n\n- Always cite the source.\n';

function view(overrides: Record<string, unknown> = {}) {
  return {
    exists: true,
    content: MARKDOWN,
    version: 7,
    contentHash: hashWorkspaceAgentsContent(MARKDOWN),
    projectId: PROJECT_ID,
    ...overrides,
  };
}

describe('ProjectMetisRulesBridge', () => {
  it('projects authoritative Metis.md bytes into an exact project-scoped rule', () => {
    const result = projectMetisRulesFromWorkspace(view(), PROJECT_ID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.projectRulesId).toBe(projectMetisRulesId(PROJECT_ID));
    expect(result.definition).toMatchObject({
      id: `user:projects/${PROJECT_ID}/metis-md`,
      kind: 'rules',
      scope: 'project',
      scopeId: `user:projects/${PROJECT_ID}`,
      revision: 7,
      markdown: MARKDOWN,
    });
  });

  it('treats a missing or deliberately empty project file as no project rule', () => {
    expect(projectMetisRulesFromWorkspace({
      exists: false, content: '', version: 0, contentHash: '', projectId: PROJECT_ID,
    }, PROJECT_ID)).toEqual({ ok: true });
    expect(projectMetisRulesFromWorkspace(view({
      content: '', contentHash: hashWorkspaceAgentsContent(''),
    }), PROJECT_ID)).toEqual({ ok: true });
  });

  it('fails closed on conflicts, cross-project views, malformed versions, and hash tampering', () => {
    expect(projectMetisRulesFromWorkspace(view({ externalConflict: true }), PROJECT_ID))
      .toEqual({ ok: false, code: 'external_conflict' });
    expect(projectMetisRulesFromWorkspace(view({ projectId: 'project-beta' }), PROJECT_ID))
      .toEqual({ ok: false, code: 'invalid_view' });
    expect(projectMetisRulesFromWorkspace(view({ version: 0 }), PROJECT_ID))
      .toEqual({ ok: false, code: 'invalid_view' });
    expect(projectMetisRulesFromWorkspace(view({ contentHash: 'a'.repeat(64) }), PROJECT_ID))
      .toEqual({ ok: false, code: 'content_hash_mismatch' });
  });

  it('rejects unsafe project identifiers rather than constructing a rule path', () => {
    expect(() => projectMetisRulesId('../escape')).toThrow();
    expect(projectMetisRulesFromWorkspace(view({ projectId: '../escape' }), '../escape'))
      .toEqual({ ok: false, code: 'invalid_view' });
  });
});
