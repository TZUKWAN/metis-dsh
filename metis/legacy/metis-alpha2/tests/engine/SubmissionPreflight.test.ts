/** @vitest-environment node */
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { SCHEMA_SQL } from '../../engine/persistence/schema.js';
import type { WordDocument } from '../../engine/runtime/OutcomeRuntimeContract.js';
import { JournalProfileRepository } from '../../electron/JournalProfileRepository.js';
import { OutcomeRepository } from '../../electron/OutcomeRepository.js';
import { SubmissionPackageRepository } from '../../electron/SubmissionPackageRepository.js';
import { SubmissionPreflightService } from '../../electron/SubmissionPreflightService.js';
import { SubmissionRepository } from '../../electron/SubmissionRepository.js';

// ─── 测试工具 ────────────────────────────────────────────────

type WordBlock = WordDocument['blocks'][number];
const heading = (id: string, text: string): WordBlock => ({ id, kind: 'heading', level: 1, text });
const paragraph = (id: string, text: string): WordBlock => ({ id, kind: 'paragraph', text });

function manuscriptDoc(bodyText: string, extra: WordBlock[] = []): WordDocument {
  return {
    type: 'word',
    page: {},
    header: '',
    footer: '',
    blocks: [
      heading('b-title', 'A Study of Testing Methods'),
      heading('b-abs-h', 'Abstract'),
      paragraph('b-abs', 'This paper studies testing methods for desktop research tools.'),
      heading('b-kw-h', 'Keywords'),
      paragraph('b-kw', 'testing, tools, research'),
      heading('b-intro', 'Introduction'),
      paragraph('b-body', bodyText),
      ...extra,
      heading('b-ref-h', 'References'),
      paragraph('b-r1', '[1] Smith 2020 Testing.'),
      paragraph('b-r2', '[2] Lee 2021 Methods.'),
    ],
  };
}

// ─── 测试主体 ────────────────────────────────────────────────

describe('SubmissionPreflightService + SubmissionPackageRepository', () => {
  let db: Database.Database;
  let outcomeRepo: OutcomeRepository;
  let submissionRepo: SubmissionRepository;
  let journalRepo: JournalProfileRepository;
  let packageRepo: SubmissionPackageRepository;
  let preflight: SubmissionPreflightService;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec('PRAGMA foreign_keys = ON;');
    db.exec(SCHEMA_SQL);
    db.prepare("INSERT INTO projects (id,title,created_at,updated_at) VALUES ('p1','项目一',1,1)").run();
    outcomeRepo = new OutcomeRepository(db);
    submissionRepo = new SubmissionRepository(db);
    journalRepo = new JournalProfileRepository(db);
    packageRepo = new SubmissionPackageRepository(db);
    preflight = new SubmissionPreflightService({
      submissionRepository: submissionRepo,
      journalRepository: journalRepo,
      outcomeRepository: outcomeRepo,
      packageRepository: packageRepo,
    });
  });

  /** 建源成果（v1）+ case；带 journal 时建 profile/snapshot/requirements 并回填 targetJournalId。 */
  function seedCase(options: {
    bodyWords?: number;
    extra?: WordBlock[];
    withJournal?: boolean;
    requirements?: Parameters<JournalProfileRepository['replaceRequirements']>[1];
  } = {}) {
    const source = outcomeRepo.create({
      projectId: 'p1',
      categoryId: null,
      title: '论文一',
      kind: 'word',
      content: manuscriptDoc('word '.repeat(options.bodyWords ?? 10), options.extra ?? []),
      note: '初稿',
    });
    const { submissionCase } = submissionRepo.createCase({
      projectId: 'p1',
      title: '论文一',
      sourceOutcomeId: source.outcome.id,
      sourceOutcomeVersion: 1,
      targetJournalName: 'Journal of Testing',
    });
    let snapshotId: string | null = null;
    if (options.withJournal) {
      const profile = journalRepo.upsertProfile('p1', { canonicalName: 'Journal of Testing' });
      snapshotId = journalRepo.createSnapshot(profile.id, submissionCase.id, '调研').id;
      if (options.requirements) journalRepo.replaceRequirements(snapshotId, options.requirements);
      submissionRepo.updateCase('p1', { caseId: submissionCase.id, targetJournalId: profile.id });
    }
    return { source, submissionCase, snapshotId };
  }

  const checkOf = (checks: Array<{ checkKey: string }>, key: string) => {
    const found = checks.find((check) => check.checkKey === key);
    expect(found, `缺少检查项 ${key}`).toBeDefined();
    return found!;
  };

  // ── 预检判定 ───────────────────────────────────────────────

  it('字数超限 → word_count block，passed=false，并追加 preflight_run 事件', async () => {
    const { submissionCase } = seedCase({
      bodyWords: 140,
      withJournal: true,
      requirements: [{
        ruleKey: 'word_limit',
        valueText: '正文不超过 100 词',
        sourceUrl: 'https://example.com/author-guidelines',
        sourceTitle: 'Author Guidelines',
        evidenceSnippet: 'Manuscripts should not exceed 100 words.',
        confidence: 'high',
      }],
    });
    const result = await preflight.run({ projectId: 'p1', caseId: submissionCase.id });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const wordCount = checkOf(result.checks, 'word_count');
    expect(wordCount.level).toBe('block');
    expect(wordCount.source).toBe('requirement');
    expect(wordCount.detail).toContain('100');
    expect(result.run.passed).toBe(false);
    expect(result.run.blockCount).toBe(1);
    expect(result.run.outcomeVersion).toBe(1);
    // 事件落库：type/source/metadata 完整。
    const events = submissionRepo.listEvents('p1', submissionCase.id);
    const event = events.find((item) => item.type === 'preflight_run');
    expect(event).toBeDefined();
    expect(event!.source).toBe('system');
    expect(event!.metadata).toMatchObject({ passed: false, blockCount: 1, runId: result.run.id });
  });

  it('字数在上限内 → word_count pass，passed=true（其余无官方要求的项 warn 不阻断）', async () => {
    const { submissionCase } = seedCase({
      bodyWords: 10,
      withJournal: true,
      requirements: [{ ruleKey: 'word_limit', valueText: '正文不超过 100 词' }],
    });
    const result = await preflight.run({ projectId: 'p1', caseId: submissionCase.id });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(checkOf(result.checks, 'word_count').level).toBe('pass');
    expect(result.run.passed).toBe(true);
    expect(result.run.blockCount).toBe(0);
    expect(result.run.warnCount).toBeGreaterThan(0);
  });

  it('无期刊快照 → requirement 类检查不通过也不失败，标 warn 并注明未抓取官方要求', async () => {
    const { submissionCase } = seedCase({ bodyWords: 5000, withJournal: false });
    const result = await preflight.run({ projectId: 'p1', caseId: submissionCase.id });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 无快照：字数即使 5000 也绝不能凭空编造 block。
    expect(result.run.passed).toBe(true);
    expect(result.run.blockCount).toBe(0);
    for (const key of ['word_count', 'abstract', 'keywords', 'section_structure', 'reference_style', 'figures_tables']) {
      const check = checkOf(result.checks, key);
      expect(check.level).toBe('warn');
      expect(check.detail).toContain('未抓取官方要求');
    }
    // 无盲审/AI 要求 → 对应检查如实 pass 并注明。
    expect(checkOf(result.checks, 'blind_author_names').level).toBe('pass');
    expect(checkOf(result.checks, 'ai_policy').level).toBe('pass');
  });

  it('官方要求 Cover Letter 而投稿包缺失 → file_cover_letter block；登记后重跑转 pass', async () => {
    const { submissionCase } = seedCase({
      withJournal: true,
      requirements: [{ ruleKey: 'cover_letter', valueText: 'A cover letter is required.' }],
    });
    const first = await preflight.run({ projectId: 'p1', caseId: submissionCase.id });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(checkOf(first.checks, 'file_cover_letter').level).toBe('block');
    expect(first.run.passed).toBe(false);

    // 建投稿包并登记 Cover Letter 后重跑：阻断解除。
    const pkg = packageRepo.createPackage(submissionCase.id);
    packageRepo.addPackageFile(pkg.id, { type: 'cover_letter', filename: 'cover-letter.docx', required: true });
    const second = await preflight.run({ projectId: 'p1', caseId: submissionCase.id });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(checkOf(second.checks, 'file_cover_letter').level).toBe('pass');
    expect(checkOf(second.checks, 'file_main_manuscript').level).toBe('pass');
    expect(second.run.passed).toBe(true);
  });

  it('盲审检查：期刊无 blind_review 要求 → 三个 blind_* 全部 pass', async () => {
    const { submissionCase } = seedCase({ withJournal: true, requirements: [] });
    const result = await preflight.run({ projectId: 'p1', caseId: submissionCase.id });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const key of ['blind_author_names', 'blind_affiliation', 'blind_acknowledgement']) {
      expect(checkOf(result.checks, key).level).toBe('pass');
    }
  });

  it('期刊要求盲审 → blind 身份类检查 warn 需要研究者确认（无名片设置，绝不假装已核验）', async () => {
    const { submissionCase } = seedCase({
      withJournal: true,
      requirements: [{ ruleKey: 'blind_review', valueText: 'Double-blind review: remove author names and affiliations.' }],
    });
    const result = await preflight.run({ projectId: 'p1', caseId: submissionCase.id });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(checkOf(result.checks, 'blind_author_names').level).toBe('warn');
    expect(checkOf(result.checks, 'blind_author_names').detail).toContain('需要研究者确认');
    expect(checkOf(result.checks, 'blind_affiliation').level).toBe('warn');
    // 稿件无致谢内容 → 致谢项可确定性 pass。
    expect(checkOf(result.checks, 'blind_acknowledgement').level).toBe('pass');
  });

  it('声明检查：官方要求基金声明而稿件缺失 → block；稿件含声明 → pass', async () => {
    const requirements = [{ ruleKey: 'funding' as const, valueText: 'A funding statement is mandatory.' }];
    const missing = seedCase({ withJournal: true, requirements });
    const missingResult = await preflight.run({ projectId: 'p1', caseId: missing.submissionCase.id });
    expect(missingResult.ok).toBe(true);
    if (!missingResult.ok) return;
    expect(checkOf(missingResult.checks, 'statement_funding').level).toBe('block');
    expect(missingResult.run.passed).toBe(false);

    const present = seedCase({
      withJournal: true,
      requirements,
      extra: [paragraph('b-fund', 'Funding: This work was supported by the National Foundation (grant no. 123).')],
    });
    const presentResult = await preflight.run({ projectId: 'p1', caseId: present.submissionCase.id });
    expect(presentResult.ok).toBe(true);
    if (!presentResult.ok) return;
    expect(checkOf(presentResult.checks, 'statement_funding').level).toBe('pass');
  });

  it('官方要求无法解析数值 → warn 无法自动核验而非瞎判', async () => {
    const { submissionCase } = seedCase({
      withJournal: true,
      requirements: [{ ruleKey: 'word_limit', valueText: '篇幅宜适中，符合本刊惯例' }],
    });
    const result = await preflight.run({ projectId: 'p1', caseId: submissionCase.id });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const check = checkOf(result.checks, 'word_count');
    expect(check.level).toBe('warn');
    expect(check.detail).toContain('无法自动核验');
    expect(result.run.passed).toBe(true);
  });

  it('错误分支：case 不存在 → case_not_found；稿件被删除 → manuscript_not_found', async () => {
    const missing = await preflight.run({ projectId: 'p1', caseId: 'case-x' });
    expect(missingResultCode(missing)).toBe('case_not_found');

    const { source, submissionCase } = seedCase();
    outcomeRepo.archive('p1', source.outcome.id);
    const gone = await preflight.run({ projectId: 'p1', caseId: submissionCase.id });
    expect(missingResultCode(gone)).toBe('manuscript_not_found');

    function missingResultCode(result: Awaited<ReturnType<typeof preflight.run>>): string {
      expect(result.ok).toBe(false);
      return result.ok ? '' : result.code;
    }
  });

  // ── 持久化往返 ─────────────────────────────────────────────

  it('run+checks 持久化往返一致，latestPreflightRun 取最新一次', async () => {
    const { submissionCase } = seedCase({ withJournal: false });
    const first = await preflight.run({ projectId: 'p1', caseId: submissionCase.id });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const storedRun = packageRepo.latestPreflightRun(submissionCase.id)!;
    expect(storedRun.id).toBe(first.run.id);
    expect(storedRun.passed).toBe(first.run.passed);
    expect(storedRun.outcomeId).toBe(first.run.outcomeId);
    const storedChecks = packageRepo.listPreflightChecks(first.run.id);
    expect(storedChecks).toHaveLength(first.checks.length);
    expect(storedChecks.map((check) => check.checkKey).sort()).toEqual(first.checks.map((check) => check.checkKey).sort());
    for (const check of storedChecks) {
      expect(check.runId).toBe(first.run.id);
      expect(check.caseId).toBe(submissionCase.id);
    }

    const second = await preflight.run({ projectId: 'p1', caseId: submissionCase.id });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.run.id).not.toBe(first.run.id);
    expect(packageRepo.latestPreflightRun(submissionCase.id)!.id).toBe(second.run.id);
    // 第一次 run 的 checks 仍可完整回读（append-only）。
    expect(packageRepo.listPreflightChecks(first.run.id)).toHaveLength(first.checks.length);
  });

  // ── 投稿包生命周期 ─────────────────────────────────────────

  it('package 生命周期：create(round 递增) → addFile → freeze → frozen 后拒绝增删改', async () => {
    const { submissionCase } = seedCase();
    const first = packageRepo.createPackage(submissionCase.id);
    expect(first.round).toBe(1);
    expect(first.status).toBe('draft');
    expect(first.frozenAt).toBeNull();
    const second = packageRepo.createPackage(submissionCase.id);
    expect(second.round).toBe(2);
    expect(packageRepo.listPackages(submissionCase.id).map((pkg) => pkg.round)).toEqual([1, 2]);
    expect(packageRepo.latestPackageForCase(submissionCase.id)!.id).toBe(second.id);
    expect(packageRepo.latestPackageForCase(submissionCase.id, 1)!.id).toBe(first.id);

    const file = packageRepo.addPackageFile(second.id, {
      type: 'main_manuscript',
      filename: 'manuscript.docx',
      contentHash: 'sha256:deadbeef',
      required: true,
      note: '工作稿导出',
    });
    expect(packageRepo.listPackageFiles(second.id)).toHaveLength(1);

    const frozen = packageRepo.freezePackage(second.id)!;
    expect(frozen.status).toBe('frozen');
    expect(frozen.frozenAt).not.toBeNull();

    // frozen 硬边界：增/改/删全部拒绝。
    expect(() => packageRepo.addPackageFile(second.id, { type: 'cover_letter', filename: 'cl.docx' })).toThrow('submission_package_frozen');
    expect(() => packageRepo.updatePackageFile(second.id, file.id, { note: '改' })).toThrow('submission_package_frozen');
    expect(() => packageRepo.removePackageFile(second.id, file.id)).toThrow('submission_package_frozen');
    // 文件未被破坏。
    expect(packageRepo.listPackageFiles(second.id)).toHaveLength(1);
    // 已冻结的包不再是 draft，不影响第一轮仍可用。
    expect(packageRepo.getPackage(first.id)!.status).toBe('draft');
  });

  it('updatePackageFile 修改可变字段并保留 contentHash，removePackageFile 真实删除', async () => {
    const { submissionCase } = seedCase();
    const pkg = packageRepo.createPackage(submissionCase.id);
    const file = packageRepo.addPackageFile(pkg.id, {
      type: 'supplementary',
      filename: 'supp.zip',
      contentHash: 'sha256:abc123',
    });
    const updated = packageRepo.updatePackageFile(pkg.id, file.id, {
      filename: 'supp-v2.zip',
      validationStatus: 'valid',
      note: '已核对',
    })!;
    expect(updated.filename).toBe('supp-v2.zip');
    expect(updated.validationStatus).toBe('valid');
    expect(updated.note).toBe('已核对');
    // 未修改的字段原样保留（含 hash）。
    expect(updated.contentHash).toBe('sha256:abc123');
    expect(updated.type).toBe('supplementary');
    expect(packageRepo.removePackageFile(pkg.id, file.id)).toBe(true);
    expect(packageRepo.listPackageFiles(pkg.id)).toHaveLength(0);
  });
});
