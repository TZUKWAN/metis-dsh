import { randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PersonalizationRepository } from '../../engine/personalization/PersonalizationRepository.js';
import type { McpActivationPersistenceInput } from '../../engine/runtime/McpActivationContract.js';
import { McpDefinitionSchema } from '../../engine/runtime/PersonalizationRuntimeContract.js';
import { EvidenceEnvelopeService } from '../../electron/EvidenceEnvelopeService.js';

const OWNER = { webContentsId: 31, processId: 41, routingId: 0, generation: 3 };
const INSTALLATION_ID = 'mcp_abcdef0123456789abcdef0123456789';

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

function activationInput(evidence: EvidenceEnvelopeService): McpActivationPersistenceInput {
  const previousDefinition = McpDefinitionSchema.parse({
    contractVersion: 1,
    id: 'url:mcp/repository-activation',
    kind: 'mcp',
    name: 'activation-package',
    description: 'Activation repository fixture.',
    enabled: false,
    tags: ['url', 'pending-probe'],
    revision: 1,
    provenance: {
      origin: 'url', author: 'External MCP package', version: '1.0.0', license: null,
      sourceUrl: 'https://packages.example.org/manifest.json', sourceRevision: INSTALLATION_ID,
      installedDigest: 'c'.repeat(64), parentId: null, parentVersion: null, locallyModified: false,
      createdAt: 100, updatedAt: 100,
    },
    sourceMode: 'url', transport: 'stdio', command: 'metis-managed-mcp', args: [INSTALLATION_ID],
    environment: {}, sourceUrl: 'https://packages.example.org/manifest.json', exposedTools: [],
    workingDirectoryToken: INSTALLATION_ID,
  });
  const activatedDefinition = McpDefinitionSchema.parse({
    ...previousDefinition,
    enabled: true,
    tags: ['url', 'probe-verified'],
    revision: 2,
    provenance: { ...previousDefinition.provenance, updatedAt: 200 },
    exposedTools: ['bounded_echo'],
  });
  const installation = {
    installationId: INSTALLATION_ID,
    packageId: 'activation-package',
    packageVersion: '1.0.0',
    manifestSha256: 'd'.repeat(64),
    packageSha256: 'c'.repeat(64),
    state: 'enabled' as const,
    enabled: true,
    installedAt: 50,
    verifiedAt: 60,
    probedAt: 70,
    exposedTools: ['bounded_echo'],
    failureCode: null,
  };
  const payload = {
    event: 'mcp_url_activated',
    definitionId: previousDefinition.id,
    installationId: INSTALLATION_ID,
    packageId: installation.packageId,
    packageVersion: installation.packageVersion,
    packageDigest: installation.packageSha256,
    manifestDigest: installation.manifestSha256,
    priorRevision: 1,
    activatedRevision: 2,
    exposedTools: ['bounded_echo'],
    probeState: 'probe_verified',
    owner: OWNER,
  };
  const envelope = evidence.issue({
    contractVersion: 1,
    sessionId: 'session-repository-activation',
    projectId: 'project-repository-activation',
    operationId: '00000000-0000-4000-8000-000000000333',
    runManifestDigest: 'e'.repeat(64),
    sourceDefinitionId: previousDefinition.id,
    sourceDefinitionRevision: 2,
    sourceKind: 'mcp',
    observedAt: 300,
    sourceUrl: previousDefinition.sourceUrl,
    locator: null,
    payload: { kind: 'json', canonicalJson: canonicalJson(payload) },
  });
  if (!envelope) throw new Error('Evidence fixture failed');
  return { previousDefinition, activatedDefinition, installation, envelope, owner: OWNER };
}

describe('PersonalizationRepository MCP activation transaction', () => {
  let db: Database.Database;
  let repository: PersonalizationRepository;
  let evidence: EvidenceEnvelopeService;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    repository = new PersonalizationRepository(db, randomBytes(32));
    evidence = new EvidenceEnvelopeService(randomBytes(32));
  });

  afterEach(() => db.close());

  it('CAS-commits the enabled definition revision and evidence in one transaction', () => {
    const input = activationInput(evidence);
    expect(repository.save({ contractVersion: 1, definition: input.previousDefinition, expectedRevision: 0 }).ok).toBe(true);
    expect(repository.commitMcpActivation(input)).toBe(true);
    expect(repository.get(input.activatedDefinition.id, true)).toEqual(input.activatedDefinition);
    expect(repository.listEvidenceEnvelopes(input.envelope.sessionId)).toEqual([input.envelope]);
    expect(repository.isMcpActivationCommitted(input)).toBe(true);
  });

  it('rejects owner/identity substitution and rolls back the definition update if evidence insertion fails', () => {
    const input = activationInput(evidence);
    expect(repository.save({ contractVersion: 1, definition: input.previousDefinition, expectedRevision: 0 }).ok).toBe(true);
    expect(repository.commitMcpActivation({
      ...input,
      owner: { ...OWNER, webContentsId: OWNER.webContentsId + 1 },
    })).toBe(false);
    expect(repository.commitMcpActivation({
      ...input,
      envelope: { ...input.envelope, sourceDefinitionRevision: 1 },
    })).toBe(false);
    expect(repository.commitMcpActivation({
      ...input,
      envelope: { ...input.envelope, payloadDigest: '0'.repeat(64) },
    })).toBe(false);
    expect(repository.commitMcpActivation({
      ...input,
      envelope: { ...input.envelope, truth: { ...input.envelope.truth, state: 'verified' } },
    })).toBe(false);
    expect(repository.get(input.previousDefinition.id, true)).toEqual(input.previousDefinition);

    db.exec(`
      CREATE TRIGGER fail_mcp_activation_evidence
      BEFORE INSERT ON personalization_evidence_envelopes
      WHEN NEW.envelope_id = '${input.envelope.envelopeId}'
      BEGIN SELECT RAISE(FAIL, 'injected evidence failure'); END;
    `);
    expect(repository.commitMcpActivation(input)).toBe(false);
    expect(repository.get(input.previousDefinition.id, true)).toEqual(input.previousDefinition);
    expect(repository.listVersions(input.previousDefinition.id)).toHaveLength(1);
    expect(repository.listEvidenceEnvelopes(input.envelope.sessionId)).toEqual([]);
  });

  it('supports only an exact committed activation rollback for crash recovery', () => {
    const input = activationInput(evidence);
    repository.save({ contractVersion: 1, definition: input.previousDefinition, expectedRevision: 0 });
    expect(repository.commitMcpActivation(input)).toBe(true);
    expect(repository.rollbackMcpActivation({
      ...input,
      activatedDefinition: { ...input.activatedDefinition, description: 'substituted' },
    })).toBe(false);
    expect(repository.rollbackMcpActivation(input)).toBe(true);
    expect(repository.get(input.previousDefinition.id, true)).toEqual(input.previousDefinition);
    expect(repository.listEvidenceEnvelopes(input.envelope.sessionId)).toEqual([]);
    expect(repository.listVersions(input.previousDefinition.id).map((version) => version.revision)).toEqual([1]);
  });
});
