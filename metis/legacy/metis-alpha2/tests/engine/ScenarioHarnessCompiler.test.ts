import { describe, expect, it } from 'vitest';
import type { ScenarioDefinition } from '../../engine/runtime/PersonalizationRuntimeContract.js';
import { normalizeScenarioHarness } from '../../engine/personalization/ScenarioHarness.js';
import {
  buildScenarioHarnessCompilerPrompt,
  diffScenarioHarness,
  parseScenarioHarnessCompilerResponse,
} from '../../engine/personalization/ScenarioHarnessCompiler.js';

function scenario(): ScenarioDefinition {
  return normalizeScenarioHarness({
    contractVersion: 1,
    id: 'user:scenarios/compiler',
    kind: 'scenario',
    name: 'Compiler test',
    description: 'Compile a Harness.',
    enabled: true,
    tags: [],
    revision: 4,
    provenance: {
      origin: 'user', author: 'owner', version: '1.0.0', license: null, sourceUrl: null,
      sourceRevision: null, installedDigest: null, parentId: null, parentVersion: null,
      locallyModified: true, createdAt: 1, updatedAt: 2,
    },
    agentIds: [], skillIds: [], mcpIds: [], rulesIds: [], workflow: [],
    fullAccess: {
      mode: 'full_access', perActionConfirmation: false, liveSteering: true,
      silentCheckpoints: true, rollbackOnFailure: false, persistAcrossRestart: true,
    },
    memory: { scope: 'project', retainDecisions: true, retainArtifacts: true, maxSummaryChars: 100_000 },
    output: { format: 'artifact_bundle', schema: null, plan: null, requireEvidenceEnvelope: true, includeIntegrityReport: true },
    triggerPhrases: [], capability: 'research',
  });
}

describe('ScenarioHarnessCompiler boundary', () => {
  it('accepts a complete candidate, freezes identity metadata and returns a field diff', () => {
    const current = scenario();
    const candidate = structuredClone(current);
    candidate.id = 'user:scenarios/attacker';
    candidate.revision = 999;
    candidate.provenance.author = 'model';
    candidate.description = 'Updated purpose.';
    const parsed = parseScenarioHarnessCompilerResponse(JSON.stringify({ summary: 'Purpose updated', scenario: candidate }), current);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.compilation.scenario.id).toBe(current.id);
    expect(parsed.compilation.scenario.revision).toBe(4);
    expect(parsed.compilation.scenario.provenance.author).toBe('owner');
    expect(parsed.compilation.diff).toContainEqual(expect.objectContaining({ path: 'description', kind: 'change' }));
  });

  it('rejects malformed or schema-invalid model output without a partial application', () => {
    const current = scenario();
    expect(parseScenarioHarnessCompilerResponse('not-json', current)).toMatchObject({ ok: false, code: 'parse_failed' });
    expect(parseScenarioHarnessCompilerResponse('{"scenario":{"name":"partial"}}', current)).toMatchObject({ ok: false, code: 'invalid_candidate' });
  });

  it('produces granular keyed-array diffs and keeps uploaded files out of the scenario contract', () => {
    const current = scenario();
    const after = structuredClone(current);
    after.qualityGates = [{
      id: 'citations', name: 'Citations', scope: 'workflow', targetStepId: null,
      criterion: 'Every factual claim has a source.', severity: 'blocking', autoFix: false,
    }];
    expect(diffScenarioHarness(current, after)[0]).toMatchObject({ path: 'qualityGates[citations]', kind: 'add' });
    const prompt = buildScenarioHarnessCompilerPrompt({
      instruction: 'Learn this guide.',
      current,
      definitions: [],
      materialContext: [{ name: 'guide.txt', text: 'Guide body' }],
    });
    expect(prompt.user).toContain('guide.txt');
    expect(prompt.system).toContain('do not add them to scenario.materials');
    expect(current.materials).toBeUndefined();
  });
});
