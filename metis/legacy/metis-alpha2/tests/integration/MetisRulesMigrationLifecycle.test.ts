import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceAgentsManager } from '../../engine/memory/WorkspaceAgentsManager.js';
import { hashWorkspaceAgentsContent } from '../../engine/memory/WorkspaceAgentsHash.js';
import { buildBuiltinPersonalizationDefinitions } from '../fixtures/personalization/legacyBuiltinDefinitions.js';
import { PersonalizationRepository } from '../../engine/personalization/PersonalizationRepository.js';
import { PersonalizationResolver } from '../../engine/personalization/PersonalizationResolver.js';
import type { MetisRulesDefinition } from '../../engine/runtime/PersonalizationRuntimeContract.js';

const PROJECT_ALPHA = 'project-alpha';
const LEGACY_NAME = 'AGENTS.md';
const CANONICAL_NAME = 'Metis.md';
const BACKUP_NAME = 'AGENTS.md.pre-metis-v1.bak';
const RECEIPT_NAME = '.metis-rules-migration.v1.json';

let trustedBase: string;
const databases: Database.Database[] = [];

beforeEach(() => {
  trustedBase = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-rules-migration-lifecycle-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const db of databases.splice(0)) db.close();
  fs.rmSync(trustedBase, { recursive: true, force: true });
});

function projectDirectory(projectId = PROJECT_ALPHA): string {
  const directory = path.join(trustedBase, 'projects', projectId);
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

function manager(projectId = PROJECT_ALPHA): WorkspaceAgentsManager {
  return new WorkspaceAgentsManager(trustedBase, projectId);
}

function writeLegacy(content: string, projectId = PROJECT_ALPHA): string {
  const directory = projectDirectory(projectId);
  fs.writeFileSync(path.join(directory, LEGACY_NAME), content, 'utf8');
  return directory;
}

function migrateLegacy(input?: {
  legacy?: string;
  canonical?: string;
  projectId?: string;
}) {
  const projectId = input?.projectId ?? PROJECT_ALPHA;
  const legacy = input?.legacy ?? '# AGENTS.md\r\n\r\nLegacy project rule.\r\n';
  const canonical = input?.canonical ?? '# Metis.md\n\nCanonical project rule.\n';
  writeLegacy(legacy, projectId);
  const currentManager = manager(projectId);
  const directory = currentManager.workspaceRoot;
  const result = currentManager.write(canonical, 0);
  expect(result).toMatchObject({ success: true, code: 'saved', version: 1 });
  return { projectId, directory, legacy, canonical, result };
}

function expectMigrationConflict(projectId = PROJECT_ALPHA): void {
  const restarted = manager(projectId);
  const readResult = restarted.read();
  const writeResult = restarted.write('# Must not overwrite externally changed migration evidence', 1);
  expect(writeResult).toMatchObject({ success: false, code: 'external_conflict' });
  expect(readResult).toMatchObject({
    exists: true,
    externalConflict: true,
    projectId,
  });
}

function projectRule(markdown: string): MetisRulesDefinition {
  const now = 1_800_000_100_000;
  return {
    contractVersion: 1,
    id: 'user:rules/project-alpha-migrated',
    kind: 'rules',
    name: 'Migrated project Metis.md',
    description: 'Project rules migrated losslessly from the workspace rules manager.',
    enabled: true,
    tags: ['migration', 'project'],
    revision: 1,
    provenance: {
      origin: 'user',
      author: 'Workspace migration integration',
      version: '1.0.0',
      license: null,
      sourceUrl: null,
      sourceRevision: null,
      installedDigest: null,
      parentId: null,
      parentVersion: null,
      locallyModified: true,
      createdAt: now,
      updatedAt: now,
    },
    scope: 'project',
    scopeId: 'user:projects/project-alpha',
    markdown,
  };
}

describe('AGENTS.md to Metis.md migration lifecycle', () => {
  it('reads legacy bytes losslessly, commits the first CAS migration, and survives manager restart', () => {
    const legacyDirectory = projectDirectory();
    const legacyBytes = Buffer.from('\uFEFF# AGENTS.md\r\n\r\n中文规则：保留 CRLF 与末尾空行。\r\n\r\n', 'utf8');
    fs.writeFileSync(path.join(legacyDirectory, LEGACY_NAME), legacyBytes);

    const currentManager = manager();
    const directory = currentManager.workspaceRoot;
    const before = currentManager.read();
    expect(before).toMatchObject({ exists: true, version: 0, projectId: PROJECT_ALPHA });
    expect(Buffer.from(before.content, 'utf8')).toEqual(legacyBytes);
    expect(before.contentHash).toBe(hashWorkspaceAgentsContent(before.content));

    const canonical = '# Metis.md\n\n中文规则：迁移后新增一条。\n';
    const saved = currentManager.write(canonical, before.version);
    expect(saved).toMatchObject({
      success: true,
      code: 'saved',
      version: 1,
      contentHash: hashWorkspaceAgentsContent(canonical),
    });
    expect(fs.readFileSync(path.join(directory, CANONICAL_NAME), 'utf8')).toBe(canonical);
    expect(fs.readFileSync(path.join(directory, BACKUP_NAME))).toEqual(legacyBytes);
    expect(JSON.parse(fs.readFileSync(path.join(directory, RECEIPT_NAME), 'utf8'))).toEqual({
      format: 'metis-rules-migration',
      version: 1,
      projectId: PROJECT_ALPHA,
      source: LEGACY_NAME,
      target: CANONICAL_NAME,
      sourceSha256: hashWorkspaceAgentsContent(before.content),
    });
    expect(manager().read()).toMatchObject({
      exists: true,
      content: canonical,
      version: 1,
      contentHash: hashWorkspaceAgentsContent(canonical),
      projectId: PROJECT_ALPHA,
    });
  });

  it('fails closed when pre-migration Metis.md and AGENTS.md have different bytes', () => {
    const legacyDirectory = writeLegacy('# Legacy\n');
    fs.writeFileSync(path.join(legacyDirectory, CANONICAL_NAME), '# Canonical\n', 'utf8');
    const restarted = manager();
    const directory = restarted.workspaceRoot;
    expect(restarted.read()).toMatchObject({
      externalConflict: true,
      content: '# Canonical\n',
      version: 0,
    });
    expect(restarted.write('# Do not choose silently\n', 0))
      .toMatchObject({ success: false, code: 'external_conflict' });
    expect(fs.existsSync(path.join(directory, BACKUP_NAME))).toBe(false);
    expect(fs.existsSync(path.join(directory, RECEIPT_NAME))).toBe(false);
  });

  it.each([
    {
      label: 'canonical Metis.md',
      fileName: CANONICAL_NAME,
      replacement: '# Externally replaced canonical rules\n',
    },
    {
      label: 'legacy backup',
      fileName: BACKUP_NAME,
      replacement: '# Externally replaced backup\n',
    },
    {
      label: 'migration receipt',
      fileName: RECEIPT_NAME,
      replacement: JSON.stringify({
        format: 'metis-rules-migration',
        version: 1,
        projectId: PROJECT_ALPHA,
        source: LEGACY_NAME,
        target: CANONICAL_NAME,
        sourceSha256: '0'.repeat(64),
      }),
    },
  ])('fails closed after external tampering of $label', ({ fileName, replacement }) => {
    const { directory } = migrateLegacy();
    fs.writeFileSync(path.join(directory, fileName), replacement, 'utf8');
    expectMigrationConflict();
  });

  it.each([
    { label: 'pointer', destination: '.agents.ptr.json' },
    { label: 'canonical', destination: `${path.sep}${CANONICAL_NAME}` },
  ])('keeps the legacy state readable when the $label rename fails', ({ destination }) => {
    const legacy = '# Legacy state that must survive\n';
    writeLegacy(legacy);
    const originalRename = fs.renameSync;
    let injected = false;
    vi.spyOn(fs, 'renameSync').mockImplementation((source: fs.PathLike, target: fs.PathLike) => {
      if (!injected && String(target).endsWith(destination)) {
        injected = true;
        throw new Error(`Injected rename failure for ${destination}`);
      }
      return originalRename(source, target);
    });

    const currentManager = manager();
    const directory = currentManager.workspaceRoot;
    expect(currentManager.write('# New state that must not commit\n', 0))
      .toMatchObject({ success: false, code: 'io_error' });
    vi.restoreAllMocks();
    expect(injected).toBe(true);
    expect(fs.readFileSync(path.join(directory, LEGACY_NAME), 'utf8')).toBe(legacy);
    expect(fs.existsSync(path.join(directory, CANONICAL_NAME))).toBe(false);
    expect(manager().read()).toMatchObject({
      exists: true,
      content: legacy,
      version: 0,
      contentHash: hashWorkspaceAgentsContent(legacy),
    });
    expect(fs.readdirSync(directory).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('isolates migration state and CAS generations between projects', () => {
    const alpha = migrateLegacy({
      projectId: PROJECT_ALPHA,
      legacy: '# Alpha legacy\n',
      canonical: '# Alpha Metis.md\n\nALPHA_ONLY\n',
    });
    const beta = migrateLegacy({
      projectId: 'project-beta',
      legacy: '# Beta legacy\n',
      canonical: '# Beta Metis.md\n\nBETA_ONLY\n',
    });

    expect(manager(PROJECT_ALPHA).read()).toMatchObject({
      content: alpha.canonical,
      version: 1,
      projectId: PROJECT_ALPHA,
    });
    expect(manager('project-beta').read()).toMatchObject({
      content: beta.canonical,
      version: 1,
      projectId: 'project-beta',
    });
    expect(fs.readFileSync(path.join(alpha.directory, CANONICAL_NAME), 'utf8')).not.toContain('BETA_ONLY');
    expect(fs.readFileSync(path.join(beta.directory, CANONICAL_NAME), 'utf8')).not.toContain('ALPHA_ONLY');
  });

  it('binds migrated project rules only to the matching PersonalizationResolver project', () => {
    const migrated = migrateLegacy({
      canonical: '# Metis.md\n\nPROJECT_ALPHA_MIGRATED_RULE\n',
    });
    const restartedView = manager().read();
    expect(restartedView.content).toBe(migrated.canonical);

    const db = new Database(':memory:');
    databases.push(db);
    const repository = new PersonalizationRepository(db);
    repository.seedBuiltins(buildBuiltinPersonalizationDefinitions());
    const rule = projectRule(restartedView.content);
    const saved = repository.save({ contractVersion: 1, definition: rule, expectedRevision: 0 });
    expect(saved).toMatchObject({ ok: true, code: 'saved' });
    const resolver = new PersonalizationResolver(repository);

    const alpha = resolver.resolve({
      sessionId: 'migration-alpha-session',
      projectId: PROJECT_ALPHA,
      scenarioId: 'builtin:scenarios/general-research',
      projectRulesId: rule.id,
      createdAt: 1_800_000_100_001,
    });
    expect(alpha.ok).toBe(true);
    if (!alpha.ok) throw new Error(`Alpha resolution failed: ${alpha.issues.join('; ')}`);
    expect(alpha.manifest.promptStack).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sourceId: rule.id,
        sourceKind: 'rules',
        precedence: 500,
        content: restartedView.content,
      }),
    ]));

    const betaWithAlphaRule = resolver.resolve({
      sessionId: 'migration-beta-invalid-session',
      projectId: 'project-beta',
      scenarioId: 'builtin:scenarios/general-research',
      projectRulesId: rule.id,
      createdAt: 1_800_000_100_002,
    });
    expect(betaWithAlphaRule).toMatchObject({
      ok: false,
      code: 'dependency_invalid',
      issues: [`Project rule ${rule.id} is not bound to user:projects/project-beta`],
    });

    const betaWithoutProjectRule = resolver.resolve({
      sessionId: 'migration-beta-clean-session',
      projectId: 'project-beta',
      scenarioId: 'builtin:scenarios/general-research',
      createdAt: 1_800_000_100_003,
    });
    expect(betaWithoutProjectRule.ok).toBe(true);
    if (!betaWithoutProjectRule.ok) throw new Error('Clean beta resolution failed');
    expect(betaWithoutProjectRule.manifest.promptStack.some((layer) => layer.sourceId === rule.id)).toBe(false);
  });
});
