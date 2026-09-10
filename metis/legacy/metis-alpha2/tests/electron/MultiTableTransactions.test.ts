/**
 * Multi-table user actions must be transactional (task 1 §七).
 *
 * Covered here: the topic candidate → project conversion (createProject + candidate
 * marking across two repositories, one transaction) and the office prompt profile
 * mutation + revision pair. Crash-consistency fixtures reuse the same trigger
 * technique and live in CrashConsistency.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PersistenceStore } from '../../engine/persistence/PersistenceStore.js';
import { ResearchRepository } from '../../engine/persistence/ResearchRepository.js';
import { TopicRepository } from '../../electron/TopicRepository.js';
import { TopicService } from '../../electron/TopicService.js';
import { OfficePromptProfileService } from '../../electron/OfficePromptProfileService.js';
import type { TopicCandidateDto } from '../../engine/runtime/TopicRuntimeContract.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'metis-mtt-'));
}

describe('topic candidate → project conversion (atomic)', () => {
  let dir: string;
  let store: PersistenceStore;
  let service: TopicService;
  let repo: TopicRepository;
  let research: ResearchRepository;

  beforeEach(() => {
    dir = tempDir();
    store = new PersistenceStore(path.join(dir, 'metis.db'));
    repo = new TopicRepository(store.raw);
    research = new ResearchRepository(store.raw);
    service = new TopicService({
      repository: repo,
      researchRepository: () => research,
      runTurn: async () => ({ status: 'completed', answer: '' }),
    });
    service.createSession({ title: '选题会话' });
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function seedCandidate(id: string): TopicCandidateDto {
    const now = Date.now();
    const candidate: TopicCandidateDto = {
      id,
      sessionId: repo.listSessions()[0]!.id,
      title: '数字鸿沟与老年人社会参与',
      researchQuestion: 'RQ',
      summary: '摘要',
      rationale: '',
      existingResearch: '',
      researchGap: '',
      theoreticalAngles: [],
      methodOptions: [],
      dataOptions: [],
      noveltyAnalysis: '',
      feasibilityAnalysis: '',
      risks: [],
      closestStudies: [],
      evidenceRefs: [],
      status: 'candidate',
      projectId: null,
      scenarioId: null,
      convertedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    repo.upsertCandidate(candidate);
    return candidate;
  }

  it('creates the project and marks the candidate in one transaction', () => {
    seedCandidate('cand-1');
    const result = service.convertCandidateToProject('cand-1', {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const project = research.getProject(result.project.id);
    expect(project?.title).toContain('数字鸿沟');
    const candidate = repo.getCandidate('cand-1');
    expect(candidate?.status).toBe('converted');
    expect(candidate?.projectId).toBe(result.project.id);
    expect(candidate?.convertedAt).not.toBeNull();
  });

  it('rolls back completely when project creation fails (no dangling converted marker)', () => {
    seedCandidate('cand-2');
    // Make the collaborating repository fail mid-transaction.
    const failing = new Proxy(research, {
      get(target, prop, receiver) {
        if (prop === 'createProject') {
          return () => { throw new Error('injected project creation failure'); };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const breakingService = new TopicService({
      repository: repo,
      researchRepository: () => failing as ResearchRepository,
      runTurn: async () => ({ status: 'completed', answer: '' }),
    });

    expect(() => breakingService.convertCandidateToProject('cand-2', {})).toThrow('injected project creation failure');

    // Rollback proof: no project rows appeared and the candidate is untouched.
    expect((store.raw.prepare('SELECT COUNT(*) c FROM projects').get() as { c: number }).c).toBe(0);
    const candidate = repo.getCandidate('cand-2');
    expect(candidate?.status).toBe('candidate');
    expect(candidate?.projectId).toBeNull();
    expect(candidate?.convertedAt).toBeNull();
  });
});

describe('office prompt profile mutation + revision (atomic)', () => {
  let dir: string;
  let store: PersistenceStore;
  let service: OfficePromptProfileService;

  beforeEach(() => {
    dir = tempDir();
    store = new PersistenceStore(path.join(dir, 'metis.db'));
    service = new OfficePromptProfileService(store.raw);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('setSlot writes the profile update and the revision together', () => {
    const created = service.createProfile({ officeKind: 'ppt', name: 'PPT Profile' });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const slotId = 'ppt.generation'; // a real slot id from the ppt office capability

    const result = service.setSlot(created.profile.id, slotId, '新的结构要求', 'manual');
    expect(result.ok).toBe(true);
    const revisions = store.raw
      .prepare('SELECT COUNT(*) c FROM office_prompt_profile_revisions WHERE profile_id = ?')
      .get(created.profile.id) as { c: number };
    expect(revisions.c).toBe(1);
    const slotsJson = (store.raw
      .prepare('SELECT slots_json FROM office_prompt_profiles WHERE id = ?')
      .get(created.profile.id) as { slots_json: string }).slots_json;
    expect(JSON.parse(slotsJson)[slotId]).toBe('新的结构要求');
  });

  it('a failed revision insert rolls back the slot mutation too', () => {
    const created = service.createProfile({ officeKind: 'ppt', name: 'PPT Profile' });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const before = (store.raw
      .prepare('SELECT slots_json FROM office_prompt_profiles WHERE id = ?')
      .get(created.profile.id) as { slots_json: string }).slots_json;

    // Any revision insert now aborts (simulating a crash mid-write).
    store.raw.exec(`
      CREATE TRIGGER fail_profile_revision
      BEFORE INSERT ON office_prompt_profile_revisions
      BEGIN
        SELECT RAISE(ABORT, 'injected revision failure');
      END;
    `);

    expect(() => service.setSlot(created.profile.id, 'ppt.generation', '内容', 'manual')).toThrow(/injected revision failure/);

    const after = (store.raw
      .prepare('SELECT slots_json FROM office_prompt_profiles WHERE id = ?')
      .get(created.profile.id) as { slots_json: string }).slots_json;
    expect(after).toBe(before);
    expect(() => service.setGlobalPrompt(created.profile.id, '全局风格')).toThrow(/injected revision failure/);
    const globalAfter = (store.raw
      .prepare('SELECT global_prompt FROM office_prompt_profiles WHERE id = ?')
      .get(created.profile.id) as { global_prompt: string }).global_prompt;
    expect(globalAfter).toBe(created.profile.globalPrompt);
  });
});
