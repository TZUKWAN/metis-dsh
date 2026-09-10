/** @vitest-environment node */
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SCHEMA_SQL } from '../../engine/persistence/schema.js';
import type { WordDocument } from '../../engine/runtime/OutcomeRuntimeContract.js';
import type { AgentLoop } from '../../engine/core/AgentLoop.js';
import { CoverLetterService, COVER_LETTER_FACT_PLACEHOLDERS } from '../../electron/CoverLetterService.js';
import { JournalProfileRepository } from '../../electron/JournalProfileRepository.js';
import { OutcomeRepository } from '../../electron/OutcomeRepository.js';
import { OutcomeWordDocxService } from '../../electron/OutcomeWordDocxService.js';
import { SubmissionPackageRepository } from '../../electron/SubmissionPackageRepository.js';
import {
  SubmissionPackageService,
  hashOutcomeVersionContent,
} from '../../electron/SubmissionPackageService.js';
import { SubmissionPreflightService } from '../../electron/SubmissionPreflightService.js';
import { SubmissionRepository } from '../../electron/SubmissionRepository.js';

// ─── 测试工具 ────────────────────────────────────────────────

type WordBlock = WordDocument['blocks'][number];
const heading = (id: string, text: string): WordBlock => ({ id, kind: 'heading', level: 1, text });
const paragraph = (id: string, text: string): WordBlock => ({ id, kind: 'paragraph', text });

function manuscriptDoc(bodyText: string): WordDocument {
  return {
    type: 'word',
    page: {},
    header: '',
    footer: '',
    blocks: [
      heading('b-title', 'A Study of Testing Methods'),
      heading('b-abs-h', 'Abstract'),
      paragraph('b-abs', 'This paper studies testing methods for desktop research tools.'),
      heading('b-intro', 'Introduction'),
      paragraph('b-body', bodyText),
      heading('b-ref-h', 'References'),
      paragraph('b-r1', '[1] Smith 2020 Testing.'),
    ],
  };
}

const wordText = (doc: WordDocument): string =>
  doc.blocks.map((block) => block.text ?? '').filter(Boolean).join('\n');

/** mock agentLoop：返回一个 completed 且 finalVerified 的真实结构（走 runEphemeralChatTurn 全链路）。 */
function mockAgentLoop(answer: string): Pick<AgentLoop, 'run'> {
  return {
    run: async () => ({
      status: 'completed' as const,
      finalText: answer,
      finalVerified: true,
      messages: [],
      turnsUsed: 1,
      toolResults: [],
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      errors: [],
      traceEvents: [],
    }),
  };
}

// ─── 测试主体 ────────────────────────────────────────────────

describe('SubmissionPackageService + CoverLetterService', () => {
  let db: Database.Database;
  let outcomeRepo: OutcomeRepository;
  let submissionRepo: SubmissionRepository;
  let journalRepo: JournalProfileRepository;
  let packageRepo: SubmissionPackageRepository;
  let preflight: SubmissionPreflightService;
  let packages: SubmissionPackageService;
  let tempDirs: string[];

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
    packages = new SubmissionPackageService({
      submissionRepository: submissionRepo,
      packageRepository: packageRepo,
      outcomeRepository: outcomeRepo,
      journalRepository: journalRepo,
    });
    tempDirs = [];
  });

  afterEach(async () => {
    for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
    db.close();
  });

  async function makeTempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'metis-p2b-'));
    tempDirs.push(dir);
    return dir;
  }

  /** 建源成果（v1）+ case。 */
  function seedCase(bodyText = 'word word word') {
    const source = outcomeRepo.create({
      projectId: 'p1',
      categoryId: null,
      title: '论文一',
      kind: 'word',
      content: manuscriptDoc(bodyText),
      note: '初稿',
    });
    const { submissionCase } = submissionRepo.createCase({
      projectId: 'p1',
      title: '论文一',
      sourceOutcomeId: source.outcome.id,
      sourceOutcomeVersion: 1,
      targetJournalName: 'Journal of Testing',
    });
    return { source, submissionCase };
  }

  // ── assemble ───────────────────────────────────────────────

  it('assemble 建 draft 包并登记 main_manuscript，hash 为可复算的真实 sha256', async () => {
    const { source, submissionCase } = seedCase();
    const result = await packages.assemble({ projectId: 'p1', caseId: submissionCase.id });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.package.status).toBe('draft');
    expect(result.package.round).toBe(1);
    expect(result.files).toHaveLength(1);
    const file = result.files[0]!;
    expect(file.type).toBe('main_manuscript');
    expect(file.outcomeId).toBe(source.outcome.id);
    expect(file.outcomeVersion).toBe(1);
    expect(file.required).toBe(true);
    expect(file.filename).toBe('论文一-v1.docx');
    // hash 真实可复算：sha256(JSON.stringify(版本内容))。
    const expected = 'sha256:' + createHash('sha256').update(JSON.stringify(source.version.content)).digest('hex');
    expect(file.contentHash).toBe(expected);
    expect(file.contentHash).toBe(hashOutcomeVersionContent(source.version.content));
  });

  it('assemble 幂等：同版本不重复建行；成果升版后更新条目并重置 validationStatus', async () => {
    const { source, submissionCase } = seedCase();
    const first = await packages.assemble({ projectId: 'p1', caseId: submissionCase.id });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    // 同版本重复 assemble：仍只有一行，fileId 不变。
    const again = await packages.assemble({ projectId: 'p1', caseId: submissionCase.id });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.package.id).toBe(first.package.id);
    expect(again.files).toHaveLength(1);
    expect(again.files[0]!.id).toBe(first.files[0]!.id);

    // 成果升到 v2 → assemble 更新同一条目，hash 换为 v2 内容，校验状态打回 pending。
    packageRepo.updatePackageFile(first.package.id, first.files[0]!.id, { validationStatus: 'valid' });
    outcomeRepo.save({
      projectId: 'p1',
      outcomeId: source.outcome.id,
      baseVersion: 1,
      content: manuscriptDoc('changed body text'),
      note: '修订',
      actor: 'human',
      sources: [],
    });
    const bumped = await packages.assemble({ projectId: 'p1', caseId: submissionCase.id });
    expect(bumped.ok).toBe(true);
    if (!bumped.ok) return;
    expect(bumped.files).toHaveLength(1);
    const file = bumped.files[0]!;
    expect(file.id).toBe(first.files[0]!.id);
    expect(file.outcomeVersion).toBe(2);
    expect(file.filename).toBe('论文一-v2.docx');
    expect(file.validationStatus).toBe('pending');
    const v2 = outcomeRepo.get('p1', source.outcome.id)!;
    expect(file.contentHash).toBe(hashOutcomeVersionContent(v2.version.content));
  });

  it('assemble 错误分支：case 不存在 → case_not_found；无稿件 → manuscript_not_found', async () => {
    const missing = await packages.assemble({ projectId: 'p1', caseId: 'case-x' });
    expect(missing).toEqual({ ok: false, code: 'case_not_found' });
    const { source, submissionCase } = seedCase();
    outcomeRepo.archive('p1', source.outcome.id);
    const gone = await packages.assemble({ projectId: 'p1', caseId: submissionCase.id });
    expect(gone).toEqual({ ok: false, code: 'manuscript_not_found' });
  });

  // ── attachOutcome / attachFile ─────────────────────────────

  it('attachOutcome 挂载成果当前版本并按 (type, outcomeId) 幂等', async () => {
    const { submissionCase } = seedCase();
    const assembled = await packages.assemble({ projectId: 'p1', caseId: submissionCase.id });
    expect(assembled.ok).toBe(true);
    if (!assembled.ok) return;
    const letter = outcomeRepo.create({
      projectId: 'p1',
      categoryId: null,
      title: 'Cover Letter｜Journal of Testing',
      kind: 'word',
      content: manuscriptDoc('letter body'),
      note: '',
      actor: 'ai',
    });
    const attached = await packages.attachOutcome({
      projectId: 'p1',
      packageId: assembled.package.id,
      outcomeId: letter.outcome.id,
      type: 'cover_letter',
      required: true,
    });
    expect(attached.ok).toBe(true);
    if (!attached.ok) return;
    expect(attached.file.type).toBe('cover_letter');
    expect(attached.file.outcomeVersion).toBe(1);
    expect(attached.file.contentHash).toBe(hashOutcomeVersionContent(letter.version.content));

    // 同成果同版本重复挂载：不新增行。
    const again = await packages.attachOutcome({
      projectId: 'p1',
      packageId: assembled.package.id,
      outcomeId: letter.outcome.id,
      type: 'cover_letter',
    });
    expect(again.ok).toBe(true);
    expect(packageRepo.listPackageFiles(assembled.package.id)).toHaveLength(2);
  });

  it('attachFile 登记外部文件：只存路径+文件名+真实 sha256，内容不进库', async () => {
    const { submissionCase } = seedCase();
    const assembled = await packages.assemble({ projectId: 'p1', caseId: submissionCase.id });
    expect(assembled.ok).toBe(true);
    if (!assembled.ok) return;
    const dir = await makeTempDir();
    const filePath = join(dir, 'supplementary-data.csv');
    await writeFile(filePath, 'a,b,c\n1,2,3\n', 'utf8');

    const attached = await packages.attachFile({
      projectId: 'p1',
      packageId: assembled.package.id,
      type: 'supplementary',
      filePath,
    });
    expect(attached.ok).toBe(true);
    if (!attached.ok) return;
    expect(attached.file.filename).toBe('supplementary-data.csv');
    expect(attached.file.artifactPath).toBe(filePath);
    expect(attached.file.outcomeId).toBeNull();
    const expected = 'sha256:' + createHash('sha256').update(Buffer.from('a,b,c\n1,2,3\n', 'utf8')).digest('hex');
    expect(attached.file.contentHash).toBe(expected);

    const missing = await packages.attachFile({
      projectId: 'p1',
      packageId: assembled.package.id,
      type: 'supplementary',
      filePath: join(dir, 'not-there.zip'),
    });
    expect(missing).toEqual({ ok: false, code: 'file_not_found' });
  });

  // ── freeze ─────────────────────────────────────────────────

  it('freeze：无预检 → 拒绝；预检带 block → 拒绝并附 blockers；passed → 成功并追加事件', async () => {
    const { submissionCase } = seedCase();
    const assembled = await packages.assemble({ projectId: 'p1', caseId: submissionCase.id });
    expect(assembled.ok).toBe(true);
    if (!assembled.ok) return;

    // 无预检 → preflight_not_passed。
    const noRun = await packages.freeze({ projectId: 'p1', packageId: assembled.package.id });
    expect(noRun.ok).toBe(false);
    if (noRun.ok) return;
    expect(noRun.code).toBe('preflight_not_passed');

    // 带 block 的预检（字数超限）→ 拒绝并附真实 blockers。
    const profile = journalRepo.upsertProfile('p1', { canonicalName: 'Journal of Testing' });
    const snapshot = journalRepo.createSnapshot(profile.id, submissionCase.id, '调研');
    journalRepo.replaceRequirements(snapshot.id, [{
      ruleKey: 'word_limit',
      valueText: '正文不超过 2 词',
      sourceUrl: 'https://example.com/guidelines',
      sourceTitle: 'Guidelines',
      evidenceSnippet: 'No more than 2 words.',
      confidence: 'high',
    }]);
    submissionRepo.updateCase('p1', { caseId: submissionCase.id, targetJournalId: profile.id });
    const blockedRun = await preflight.run({ projectId: 'p1', caseId: submissionCase.id });
    expect(blockedRun.ok && !blockedRun.run.passed).toBe(true);
    const blocked = await packages.freeze({ projectId: 'p1', packageId: assembled.package.id });
    expect(blocked.ok).toBe(false);
    if (blocked.ok) return;
    expect(blocked.code).toBe('preflight_not_passed');
    expect(blocked.blockers!.length).toBeGreaterThan(0);
    expect(blocked.blockers!.some((check) => check.checkKey === 'word_count')).toBe(true);

    // 换一个无期刊要求的 case：预检 passed=true → 冻结成功 + 事件落库。
    const clean = seedCase();
    const cleanAssembled = await packages.assemble({ projectId: 'p1', caseId: clean.submissionCase.id });
    expect(cleanAssembled.ok).toBe(true);
    if (!cleanAssembled.ok) return;
    const passedRun = await preflight.run({ projectId: 'p1', caseId: clean.submissionCase.id });
    expect(passedRun.ok && passedRun.run.passed).toBe(true);
    const frozen = await packages.freeze({ projectId: 'p1', packageId: cleanAssembled.package.id });
    expect(frozen.ok).toBe(true);
    if (!frozen.ok) return;
    expect(frozen.package.status).toBe('frozen');
    expect(frozen.package.frozenAt).not.toBeNull();
    const events = submissionRepo.listEvents('p1', clean.submissionCase.id);
    const event = events.find((item) => item.type === 'package_frozen');
    expect(event).toBeDefined();
    expect(event!.source).toBe('human');
    expect(event!.metadata).toMatchObject({ packageId: frozen.package.id, round: 1, fileCount: 1 });

    // frozen 后 attach 拒绝。
    const afterFreeze = await packages.attachOutcome({
      projectId: 'p1',
      packageId: frozen.package.id,
      outcomeId: clean.source.outcome.id,
      type: 'cover_letter',
    });
    expect(afterFreeze).toEqual({ ok: false, code: 'package_frozen' });
  });

  // ── validate ───────────────────────────────────────────────

  it('validate：hash 匹配→valid；成果升版→needs_confirmation；hash 被改→invalid；外部文件被改→invalid', async () => {
    const { source, submissionCase } = seedCase();
    const assembled = await packages.assemble({ projectId: 'p1', caseId: submissionCase.id });
    expect(assembled.ok).toBe(true);
    if (!assembled.ok) return;
    const packageId = assembled.package.id;

    const dir = await makeTempDir();
    const filePath = join(dir, 'supp.txt');
    await writeFile(filePath, 'v1 bytes', 'utf8');
    const attached = await packages.attachFile({ projectId: 'p1', packageId, type: 'supplementary', filePath });
    expect(attached.ok).toBe(true);

    // 初始：全部 valid。
    const initial = await packages.validate({ projectId: 'p1', packageId });
    expect(initial.ok).toBe(true);
    if (!initial.ok) return;
    expect(initial.summary.valid).toBe(2);
    const stored = packageRepo.listPackageFiles(packageId);
    expect(stored.every((file) => file.validationStatus === 'valid')).toBe(true);

    // 成果升版（pinned v1 hash 仍匹配，但已非最新）→ needs_confirmation。
    outcomeRepo.save({
      projectId: 'p1',
      outcomeId: source.outcome.id,
      baseVersion: 1,
      content: manuscriptDoc('revised'),
      note: 'v2',
      actor: 'human',
      sources: [],
    });
    const drifted = await packages.validate({ projectId: 'p1', packageId });
    expect(drifted.ok).toBe(true);
    if (!drifted.ok) return;
    const manuscript = drifted.results.find((item) => item.type === 'main_manuscript')!;
    expect(manuscript.status).toBe('needs_confirmation');
    expect(manuscript.reason).toContain('v2');

    // 登记 hash 被篡改 → invalid。
    const manuscriptFile = packageRepo.listPackageFiles(packageId).find((file) => file.type === 'main_manuscript')!;
    packageRepo.updatePackageFile(packageId, manuscriptFile.id, { contentHash: 'sha256:tampered' });
    // 外部文件内容被改 → invalid。
    await writeFile(filePath, 'tampered bytes', 'utf8');
    const tampered = await packages.validate({ projectId: 'p1', packageId });
    expect(tampered.ok).toBe(true);
    if (!tampered.ok) return;
    expect(tampered.summary.invalid).toBe(2);
    expect(tampered.results.find((item) => item.fileId === manuscriptFile.id)!.reason).toContain('hash');
    const supp = tampered.results.find((item) => item.type === 'supplementary')!;
    expect(supp.status).toBe('invalid');
  });

  // ── exportToDisk ───────────────────────────────────────────

  it('exportToDisk 退化路径（无 docxService）：outcome→.md 纯文本，外部文件→copy，真实落盘', async () => {
    const { submissionCase } = seedCase('export body text');
    const assembled = await packages.assemble({ projectId: 'p1', caseId: submissionCase.id });
    expect(assembled.ok).toBe(true);
    if (!assembled.ok) return;
    const dir = await makeTempDir();
    const filePath = join(dir, 'supp.csv');
    await writeFile(filePath, 'x,y\n', 'utf8');
    await packages.attachFile({ projectId: 'p1', packageId: assembled.package.id, type: 'supplementary', filePath });

    const userDataDir = await makeTempDir();
    const withDir = new SubmissionPackageService({
      submissionRepository: submissionRepo,
      packageRepository: packageRepo,
      outcomeRepository: outcomeRepo,
      journalRepository: journalRepo,
      userDataDir,
    });
    const result = await withDir.exportToDisk({ projectId: 'p1', packageId: assembled.package.id });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.dir).toBe(join(userDataDir, 'submissions', submissionCase.id, 'round-1'));
    expect(result.failures).toHaveLength(0);
    expect(result.exported).toHaveLength(2);

    const manuscript = result.exported.find((item) => item.path.endsWith('.md'))!;
    expect(manuscript.format).toBe('markdown');
    const mdText = await readFile(manuscript.path, 'utf8');
    expect(mdText).toContain('export body text');

    const copy = result.exported.find((item) => item.format === 'copy')!;
    expect(await readFile(copy.path, 'utf8')).toBe('x,y\n');

    // 无 userDataDir → 结构化错误。
    const noDir = await packages.exportToDisk({ projectId: 'p1', packageId: assembled.package.id });
    expect(noDir).toEqual({ ok: false, code: 'export_dir_unavailable' });
  });

  it('exportToDisk 复用真实 OutcomeWordDocxService：word 文档导出为真实 .docx（PK 头）', async () => {
    const { submissionCase } = seedCase('docx body text');
    const assembled = await packages.assemble({ projectId: 'p1', caseId: submissionCase.id });
    expect(assembled.ok).toBe(true);
    if (!assembled.ok) return;
    const userDataDir = await makeTempDir();
    const withDocx = new SubmissionPackageService({
      submissionRepository: submissionRepo,
      packageRepository: packageRepo,
      outcomeRepository: outcomeRepo,
      journalRepository: journalRepo,
      docxService: new OutcomeWordDocxService(),
      userDataDir,
    });
    const result = await withDocx.exportToDisk({ projectId: 'p1', packageId: assembled.package.id });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.exported).toHaveLength(1);
    expect(result.exported[0]!.format).toBe('docx');
    expect(result.exported[0]!.path.endsWith('论文一-v1.docx')).toBe(true);
    const bytes = await readFile(result.exported[0]!.path);
    // 真实 OOXML zip：PK\x03\x04 本地文件头签名。
    expect(bytes.readUInt32LE(0)).toBe(0x04034b50);
  });

  // ── CoverLetterService ─────────────────────────────────────

  function coverLetters(options: { agentLoop?: Pick<AgentLoop, 'run'> } = {}): CoverLetterService {
    return new CoverLetterService({
      submissionRepository: submissionRepo,
      journalRepository: journalRepo,
      outcomeRepository: outcomeRepo,
      packageRepository: packageRepo,
      ...(options.agentLoop ? { agentLoop: options.agentLoop } : {}),
    });
  }

  it('模板模式（无 agentLoop）：含全部 [待确认：] 占位，needsConfirmation 非空，不编造作者事实', async () => {
    const { submissionCase } = seedCase();
    const service = coverLetters();
    const result = await service.generate({ projectId: 'p1', caseId: submissionCase.id });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.extraction).toBe('template');
    expect(result.needsConfirmation).toEqual([...COVER_LETTER_FACT_PLACEHOLDERS]);

    const detail = outcomeRepo.get('p1', result.outcomeId)!;
    expect(detail.outcome.title).toBe('Cover Letter｜Journal of Testing');
    expect(detail.outcome.kind).toBe('word');
    expect(detail.version.createdBy).toBe('ai');
    const text = wordText(detail.version.content as WordDocument);
    // 全部事实门控占位在场。
    for (const fact of COVER_LETTER_FACT_PLACEHOLDERS) {
      expect(text).toContain(`[待确认：${fact}]`);
    }
    // 已知事实如实写入；无邮箱/基金号形态的编造内容。
    expect(text).toContain('Journal of Testing');
    expect(text).toContain('论文一');
    expect(text).toContain('This paper studies testing methods');
    expect(/[\w.]+@[\w.]+/u.test(text)).toBe(false);
  });

  it('LLM 模式（mock agentLoop）：正文落库为成果，缺失占位被确定性补齐', async () => {
    const { submissionCase } = seedCase();
    const llmAnswer = [
      'Dear Editor,',
      'We submit "论文一" to Journal of Testing.',
      'Author: [待确认：作者姓名]',
      'Sincerely,',
    ].join('\n');
    const service = coverLetters({ agentLoop: mockAgentLoop(llmAnswer) });
    const result = await service.generate({ projectId: 'p1', caseId: submissionCase.id });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.extraction).toBe('llm');
    const detail = outcomeRepo.get('p1', result.outcomeId)!;
    const text = wordText(detail.version.content as WordDocument);
    expect(text).toContain('Dear Editor,');
    // LLM 漏掉的占位被补齐，且全文不出现编造的邮箱。
    for (const fact of COVER_LETTER_FACT_PLACEHOLDERS) {
      expect(text).toContain(`[待确认：${fact}]`);
    }
    expect(/[\w.]+@[\w.]+/u.test(text)).toBe(false);
  });

  it('重复生成：同一 Cover Letter 成果 save 新版本，不新建成果；自动挂进 draft 投稿包', async () => {
    const { submissionCase } = seedCase();
    // 先有 draft 包（assemble 建包），再生成 Cover Letter。
    const assembled = await packages.assemble({ projectId: 'p1', caseId: submissionCase.id });
    expect(assembled.ok).toBe(true);
    if (!assembled.ok) return;

    const service = coverLetters();
    const first = await service.generate({ projectId: 'p1', caseId: submissionCase.id });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.version).toBe(1);

    const second = await service.generate({ projectId: 'p1', caseId: submissionCase.id });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.outcomeId).toBe(first.outcomeId);
    expect(second.version).toBe(2);
    // 项目中该标题的成果只有一个。
    expect(outcomeRepo.list('p1', 'Cover Letter').filter((item) => item.title === 'Cover Letter｜Journal of Testing')).toHaveLength(1);

    // 自动挂进 draft 包：cover_letter 条目指向该成果最新版本，hash 真实。
    const files = packageRepo.listPackageFiles(assembled.package.id);
    const letter = files.find((file) => file.type === 'cover_letter');
    expect(letter).toBeDefined();
    expect(letter!.outcomeId).toBe(first.outcomeId);
    expect(letter!.outcomeVersion).toBe(2);
    const detail = outcomeRepo.get('p1', first.outcomeId)!;
    expect(letter!.contentHash).toBe(hashOutcomeVersionContent(detail.version.content));

    // 事件落库：cover_letter_generated × 2，source 'agent'。
    const events = submissionRepo.listEvents('p1', submissionCase.id).filter((item) => item.type === 'cover_letter_generated');
    expect(events).toHaveLength(2);
    expect(events.every((event) => event.source === 'agent')).toBe(true);
    expect(events[1]!.metadata).toMatchObject({ outcomeId: first.outcomeId, version: 2, extraction: 'template' });
  });

  it('Cover Letter 错误分支：case 不存在 → case_not_found', async () => {
    const service = coverLetters();
    const result = await service.generate({ projectId: 'p1', caseId: 'case-x' });
    expect(result).toEqual({ ok: false, code: 'case_not_found' });
  });
});
