/** @vitest-environment node */
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { SCHEMA_SQL } from '../../engine/persistence/schema.js';
import { JournalProfileRepository } from '../../electron/JournalProfileRepository.js';
import {
  JOURNAL_PLATFORMS,
  JOURNAL_REQUIREMENT_RULE_KEYS,
  JournalRequirementSchema,
} from '../../engine/submission/JournalProfileContract.js';

describe('JournalProfileRepository', () => {
  let db: Database.Database;
  let repo: JournalProfileRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec('PRAGMA foreign_keys = ON;');
    db.exec(SCHEMA_SQL);
    db.prepare("INSERT INTO projects (id,title,created_at,updated_at) VALUES ('p1','项目一',1,1)").run();
    db.prepare("INSERT INTO outcomes (id,project_id,title,kind,status,current_version,created_at,updated_at) VALUES ('out-1','p1','论文一','word','draft',1,1,1)").run();
    db.prepare("INSERT INTO outcome_versions (outcome_id,version,content,content_hash,note,created_by,created_at) VALUES ('out-1',1,'{}','h','创建','human',1)").run();
    db.prepare("INSERT INTO submission_series (id,project_id,source_outcome_id,title,notes,created_at,updated_at) VALUES ('series-1','p1','out-1','链一','',1,1)").run();
    db.prepare("INSERT INTO submission_cases (id,series_id,project_id,title,status,created_at,updated_at) VALUES ('case-1','series-1','p1','论文一','PROFILING',1,1)").run();
    repo = new JournalProfileRepository(db);
  });

  function createProfile() {
    return repo.upsertProfile('p1', {
      canonicalName: 'Journal of Testing',
      issn: '1234-5678',
      publisher: 'Test Publisher',
      platform: 'scholarone',
      articleTypes: ['research_article'],
    });
  }

  it('upserts a profile without duplicating rows for the same name or issn', () => {
    const first = createProfile();
    expect(first.canonicalName).toBe('Journal of Testing');
    expect(first.platform).toBe('scholarone');
    // 同名 upsert：更新而不是新建。
    const second = repo.upsertProfile('p1', { canonicalName: 'Journal of Testing', publisher: 'New Publisher' });
    expect(second.id).toBe(first.id);
    expect(second.publisher).toBe('New Publisher');
    // 同 ISSN（不同名）upsert：仍命中同一档案。
    const third = repo.upsertProfile('p1', { canonicalName: 'J. Testing', issn: '1234-5678' });
    expect(third.id).toBe(first.id);
    const count = db.prepare('SELECT COUNT(*) AS n FROM journal_profiles WHERE project_id = ?').get('p1') as { n: number };
    expect(count.n).toBe(1);
    expect(repo.findProfileByName('p1', 'Journal of Testing')!.id).toBe(first.id);
    expect(repo.getProfile('p1', first.id)!.issn).toBe('1234-5678');
    // 枚举契约健全性：平台与规则键都在冻结常量表内。
    expect(JOURNAL_PLATFORMS).toContain('scholarone');
    expect(JOURNAL_REQUIREMENT_RULE_KEYS).toContain('ai_policy');
  });

  it('round-trips snapshot requirements with full evidence fields', () => {
    const profile = createProfile();
    const snapshot = repo.createSnapshot(profile.id, 'case-1', '首次调研');
    expect(snapshot.caseId).toBe('case-1');
    expect(repo.latestSnapshot(profile.id)!.id).toBe(snapshot.id);
    expect(repo.getSnapshot(snapshot.id)!.note).toBe('首次调研');

    const saved = repo.replaceRequirements(snapshot.id, [
      {
        ruleKey: 'word_limit',
        valueText: '正文不超过 8000 词',
        sourceUrl: 'https://example.com/author-guidelines',
        sourceTitle: 'Author Guidelines',
        evidenceSnippet: 'Manuscripts should not exceed 8,000 words.',
        confidence: 'high',
      },
      {
        ruleKey: 'ai_policy',
        valueText: '需声明 AI 使用情况',
        sourceUrl: 'https://example.com/ai-policy',
        sourceTitle: 'AI Policy',
        evidenceSnippet: 'Authors must disclose the use of generative AI.',
        confidence: 'medium',
      },
    ]);
    expect(saved).toHaveLength(2);
    const listed = repo.listRequirements(snapshot.id);
    expect(listed).toHaveLength(2);
    const wordLimit = listed.find((item) => item.ruleKey === 'word_limit')!;
    // 证据字段完整保留：出处 URL / 原文摘录 / 置信度。
    expect(wordLimit.ruleType).toBe('official_requirement');
    expect(wordLimit.sourceUrl).toBe('https://example.com/author-guidelines');
    expect(wordLimit.evidenceSnippet).toBe('Manuscripts should not exceed 8,000 words.');
    expect(wordLimit.confidence).toBe('high');
    expect(wordLimit.retrievedAt).toBeGreaterThan(0);
    // 契约层面 ruleType 被结构固定为官方要求。
    expect(JournalRequirementSchema.shape.ruleType.parse('official_requirement')).toBe('official_requirement');
    // 再次 replace：旧行被替换而非追加。
    repo.replaceRequirements(snapshot.id, [{ ruleKey: 'abstract_limit', valueText: '摘要不超过 250 词' }]);
    const after = repo.listRequirements(snapshot.id);
    expect(after).toHaveLength(1);
    expect(after[0]!.ruleKey).toBe('abstract_limit');
  });

  it('deduplicates corpus items by doi or normalized title', () => {
    const profile = createProfile();
    const snapshot = repo.createSnapshot(profile.id, null, '');
    const added = repo.addCorpusItems(profile.id, snapshot.id, [
      { title: 'Paper A', doi: '10.1000/XYZ', source: 'openalex', year: 2023, authors: ['Alice', 'Bob'] },
      { title: 'Paper B', source: 'crossref', year: 2022 },
    ]);
    expect(added).toHaveLength(2);
    expect(added[0]!.fulltextAvailable).toBe(false);
    // 重复 doi（大小写不同）与重复标题（空白/大小写差异）都被跳过。
    const duplicates = repo.addCorpusItems(profile.id, snapshot.id, [
      { title: 'Paper A copy', doi: '10.1000/xyz', source: 'crossref' },
      { title: '  paper b ', source: 'browser' },
    ]);
    expect(duplicates).toHaveLength(0);
    expect(repo.listCorpusItems(profile.id)).toHaveLength(2);
    expect(repo.listCorpusItems(profile.id, 1)).toHaveLength(1);
  });

  it('round-trips pattern observations with supporting item ids', () => {
    const profile = createProfile();
    const snapshot = repo.createSnapshot(profile.id, null, '');
    const corpus = repo.addCorpusItems(profile.id, snapshot.id, [
      { title: 'Paper A', doi: '10.1000/a' },
      { title: 'Paper B', doi: '10.1000/b' },
    ]);
    const saved = repo.replacePatternObservations(snapshot.id, [
      {
        patternKey: 'abstract',
        observation: '近年摘要普遍采用结构化四段式',
        evidenceLevel: 'abstract',
        sampleSize: 2,
        supportingItemIds: corpus.map((item) => item.id),
        confidence: 'medium',
      },
    ]);
    expect(saved).toHaveLength(1);
    const listed = repo.listPatternObservations(snapshot.id);
    expect(listed).toHaveLength(1);
    expect(listed[0]!.supportingItemIds).toEqual(corpus.map((item) => item.id));
    expect(listed[0]!.evidenceLevel).toBe('abstract');
    expect(listed[0]!.sampleSize).toBe(2);
  });

  it('creates gap items and transitions their status open -> planned -> applied', () => {
    const gaps = repo.createGapItems('case-1', [
      {
        severity: 'must_fix',
        title: '摘要超长',
        problem: '摘要 400 词，超出 250 词上限',
        evidence: 'Author Guidelines: abstract <= 250 words',
        sourceType: 'official_requirement',
        affectedLocation: 'Abstract',
        recommendedAction: '压缩摘要至 250 词以内',
        estimatedImpact: 'high',
      },
    ]);
    expect(gaps).toHaveLength(1);
    const gap = gaps[0]!;
    expect(gap.status).toBe('open');
    expect(gap.requiresResearcherJudgment).toBe(false);

    const planned = repo.updateGapItem('case-1', gap.id, { status: 'planned' })!;
    expect(planned.status).toBe('planned');
    expect(repo.listGapItems('case-1', 'planned')).toHaveLength(1);
    expect(repo.listGapItems('case-1', 'open')).toHaveLength(0);
    const applied = repo.updateGapItem('case-1', gap.id, { status: 'applied' })!;
    expect(applied.status).toBe('applied');
    expect(applied.updatedAt).toBeGreaterThanOrEqual(applied.createdAt);
    // 其他 case 的 itemId 不可越权更新。
    expect(repo.updateGapItem('case-x', gap.id, { status: 'dismissed' })).toBeUndefined();
  });

  it('creates a plan with items in one transaction and stamps approvedAt on approval', () => {
    const gaps = repo.createGapItems('case-1', [
      { severity: 'must_fix', title: '摘要超长', sourceType: 'official_requirement' },
    ]);
    const { plan, items } = repo.createPlan('case-1', [
      { gapItemId: gaps[0]!.id, title: '压缩摘要', action: '重写摘要至 250 词', risk: '可能丢失次要结论', involvesResearcherJudgment: true },
      { title: '补充数据可用性声明', action: '在正文末尾新增 Data Availability 小节' },
    ]);
    expect(plan.status).toBe('draft');
    expect(plan.approvedAt).toBeNull();
    expect(items).toHaveLength(2);
    expect(items[0]!.gapItemId).toBe(gaps[0]!.id);
    expect(items[0]!.involvesResearcherJudgment).toBe(true);
    expect(items[0]!.status).toBe('pending');
    expect(repo.getPlan(plan.id)!.id).toBe(plan.id);
    expect(repo.latestPlanForCase('case-1')!.id).toBe(plan.id);

    const approved = repo.setPlanStatus(plan.id, 'approved')!;
    expect(approved.status).toBe('approved');
    expect(approved.approvedAt).not.toBeNull();
    expect(approved.appliedAt).toBeNull();
    const applied = repo.setPlanStatus(plan.id, 'applied')!;
    expect(applied.appliedAt).not.toBeNull();
    // 时间戳只写一次：重复进入 approved 不覆盖已有 approvedAt。
    const again = repo.setPlanStatus(plan.id, 'approved')!;
    expect(again.approvedAt).toBe(approved.approvedAt);

    const updatedItem = repo.updatePlanItem(plan.id, items[0]!.id, {
      status: 'applied',
      afterText: '压缩后的摘要……',
      outcomeId: 'out-1',
      outcomeVersion: 2,
    })!;
    expect(updatedItem.status).toBe('applied');
    expect(updatedItem.outcomeId).toBe('out-1');
    expect(updatedItem.outcomeVersion).toBe(2);
    expect(repo.listPlanItems(plan.id)).toHaveLength(2);
  });

  it('cascades profile deletion to snapshots, requirements, corpus and observations', () => {
    const profile = createProfile();
    const snapshot = repo.createSnapshot(profile.id, 'case-1', '');
    repo.replaceRequirements(snapshot.id, [{ ruleKey: 'word_limit', valueText: 'x' }]);
    repo.addCorpusItems(profile.id, snapshot.id, [{ title: 'Paper A', doi: '10.1000/a' }]);
    repo.replacePatternObservations(snapshot.id, [{ patternKey: 'title', observation: 'y' }]);

    db.prepare('DELETE FROM journal_profiles WHERE id = ?').run(profile.id);
    const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    expect(count('journal_profile_snapshots')).toBe(0);
    expect(count('journal_requirements')).toBe(0);
    expect(count('journal_corpus_items')).toBe(0);
    expect(count('journal_pattern_observations')).toBe(0);
  });

  it('cascades case deletion to gap items and optimization plans', () => {
    const gaps = repo.createGapItems('case-1', [{ severity: 'optional', title: 't', sourceType: 'manuscript' }]);
    const { plan } = repo.createPlan('case-1', [{ gapItemId: gaps[0]!.id, title: 'x' }]);
    db.prepare('DELETE FROM submission_cases WHERE id = ?').run('case-1');
    const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    expect(count('submission_gap_items')).toBe(0);
    expect(count('submission_optimization_plans')).toBe(0);
    expect(count('submission_optimization_items')).toBe(0);
    void plan;
  });
});
