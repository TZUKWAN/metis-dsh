/**
 * ResearchRepository.updateArtifactReviewStatus: row-level status transition
 * plus audit-trail append to the current version's manifest.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { PersistenceStore } from '../../engine/persistence/PersistenceStore.js';
import { ResearchRepository } from '../../engine/persistence/ResearchRepository.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe('updateArtifactReviewStatus', () => {
  let dir: string;
  let store: PersistenceStore;
  let repo: ResearchRepository;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-artifact-review-'));
    store = new PersistenceStore(path.join(dir, 'test.db'));
    repo = new ResearchRepository(store.raw);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function seedArtifact(): void {
    repo.createProject({
      id: 'proj-1',
      title: 'Demo Project',
      originalIntent: '',
      researchQuestion: '',
      lifecycle: 'active',
      methodology: '',
      discipline: '',
      metadata: {},
      createdAt: 1000,
      updatedAt: 1000,
      archivedAt: null,
      version: 1,
      source: 'user',
      deletedAt: null,
    } as never);
    repo.saveArtifact({
      id: 'art-1',
      projectId: 'proj-1',
      title: 'Draft Report',
      artifactType: 'report',
      reviewStatus: 'draft',
      contentRef: null,
      inputHash: null,
      provenance: {},
      metadata: {},
      version: 1,
      createdAt: 1000,
      updatedAt: 1000,
      deletedAt: null,
    });
    repo.saveArtifactVersion(
      {
        id: 'art-1',
        projectId: 'proj-1',
        title: 'Draft Report',
        artifactType: 'report',
        reviewStatus: 'draft',
        inputs: [],
        generatedBy: { capabilityId: 'cap', method: 'manual' },
        citedSourceIds: [],
        renderer: { kind: 'markdown' },
        reviewTrail: [],
        createdAt: 1000,
        updatedAt: 1000,
      } as never,
      '# Draft content',
    );
  }

  it('transitions status and appends a review trail entry', () => {
    seedArtifact();
    const ok = repo.updateArtifactReviewStatus('art-1', 'pending', 'manual');
    expect(ok).toBe(true);

    const artifact = repo.getArtifact('art-1');
    expect(artifact?.reviewStatus).toBe('pending');

    const current = repo.getArtifactVersion('art-1');
    const manifest = current?.manifest as { reviewTrail?: Array<{ from: string; to: string; reason: string }> };
    expect(manifest.reviewTrail).toHaveLength(1);
    expect(manifest.reviewTrail?.[0]).toMatchObject({ from: 'draft', to: 'pending', reason: 'manual' });
  });

  it('accumulates multiple transitions in order', () => {
    seedArtifact();
    repo.updateArtifactReviewStatus('art-1', 'pending', 'manual');
    repo.updateArtifactReviewStatus('art-1', 'verified', 'manual');

    const current = repo.getArtifactVersion('art-1');
    const manifest = current?.manifest as { reviewTrail?: Array<{ from: string; to: string }> };
    expect(manifest.reviewTrail?.map((e) => `${e.from}->${e.to}`)).toEqual(['draft->pending', 'pending->verified']);
  });

  it('returns false for a missing artifact', () => {
    expect(repo.updateArtifactReviewStatus('nope', 'pending', 'manual')).toBe(false);
  });
});
