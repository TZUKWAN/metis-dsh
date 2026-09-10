/**
 * Submission Package Service — 投稿材料包组装/导出/冻结服务（学术投稿生命周期 P2b）。
 *
 * 职责：在 SubmissionPackageRepository（纯持久化 + frozen 硬边界）之上提供
 * 面向用例的动词：assemble（自动登记主稿件）、attachOutcome / attachFile
 * （挂载材料）、exportToDisk（落盘导出）、freeze（预检通过后才允许冻结）、
 * validate（重算 hash 与版本新鲜度复核）。
 *
 * 证据纪律（与 SubmissionPreflightService / SubmissionGapService 一致）：
 *  - contentHash 一律是对「成果版本内容 JSON.stringify 编码串」或「外部文件
 *    原始字节」的真实 sha256（sha256:<hex>），可复算，绝不登记估造值；
 *  - attachFile 只登记路径 + hash + 文件名，文件内容不进 SQLite；
 *  - freeze 前置门槛是该 case 最近一次预检 passed=true；无预检或带 block
 *    一律拒绝并返回真实 blockers，不凭空放行；
 *  - exportToDisk 优先复用 OutcomeWordDocxService 导出真实 .docx；docxService
 *    未注入或文档非 word 时退化为导出纯文本 .md，并在返回里如实标注 format，
 *    不把退化路径伪装成 docx。
 */
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { z } from 'zod';
import type { OutcomeDocument } from '../engine/runtime/OutcomeRuntimeContract.js';
import {
  SUBMISSION_PACKAGE_FILE_TYPES,
  type SubmissionPackage,
  type SubmissionPackageFile,
  type SubmissionPackageFileValidationStatus,
  type SubmissionPreflightCheck,
} from '../engine/submission/SubmissionPackageContract.js';
import { extractManuscriptPlainText } from './SubmissionGapService.js';
import type { JournalProfileRepository } from './JournalProfileRepository.js';
import type { OutcomeRepository } from './OutcomeRepository.js';
import type { OutcomeWordDocxService } from './OutcomeWordDocxService.js';
import type { SubmissionPackageRepository } from './SubmissionPackageRepository.js';
import type { SubmissionPreflightService } from './SubmissionPreflightService.js';
import type { SubmissionRepository } from './SubmissionRepository.js';

// ─── 公共契约 ────────────────────────────────────────────────

export type SubmissionPackageErrorCode =
  | 'invalid_request'
  | 'case_not_found'
  | 'package_not_found'
  | 'package_frozen'
  | 'manuscript_not_found'
  | 'outcome_not_found'
  | 'file_not_found'
  | 'export_dir_unavailable'
  | 'preflight_not_passed';

export const SubmissionPackageAssembleRequestSchema = z.strictObject({
  projectId: z.string().min(1),
  caseId: z.string().min(1),
});
export type SubmissionPackageAssembleRequest = z.infer<typeof SubmissionPackageAssembleRequestSchema>;

export const SubmissionPackageAttachOutcomeRequestSchema = z.strictObject({
  projectId: z.string().min(1),
  packageId: z.string().min(1),
  outcomeId: z.string().min(1),
  type: z.enum(SUBMISSION_PACKAGE_FILE_TYPES),
  required: z.boolean().optional(),
  note: z.string().max(20000).optional(),
});
export type SubmissionPackageAttachOutcomeRequest = z.infer<typeof SubmissionPackageAttachOutcomeRequestSchema>;

export const SubmissionPackageAttachFileRequestSchema = z.strictObject({
  projectId: z.string().min(1),
  packageId: z.string().min(1),
  type: z.enum(SUBMISSION_PACKAGE_FILE_TYPES),
  filePath: z.string().min(1).max(2000),
  required: z.boolean().optional(),
});
export type SubmissionPackageAttachFileRequest = z.infer<typeof SubmissionPackageAttachFileRequestSchema>;

export const SubmissionPackageScopedRequestSchema = z.strictObject({
  projectId: z.string().min(1),
  packageId: z.string().min(1),
});
export type SubmissionPackageScopedRequest = z.infer<typeof SubmissionPackageScopedRequestSchema>;

export type SubmissionPackageAssembleResult =
  | { ok: true; package: SubmissionPackage; files: SubmissionPackageFile[] }
  | { ok: false; code: SubmissionPackageErrorCode };

export type SubmissionPackageAttachResult =
  | { ok: true; file: SubmissionPackageFile }
  | { ok: false; code: SubmissionPackageErrorCode };

/** 导出落盘的单条结果：format 如实标注真实写出的格式（docx / markdown 退化 / copy）。 */
export type SubmissionPackageExportedFile = { fileId: string; path: string; format: 'docx' | 'markdown' | 'copy' };
export type SubmissionPackageExportFailure = { fileId: string; code: string; message: string };

export type SubmissionPackageExportResult =
  | { ok: true; dir: string; exported: SubmissionPackageExportedFile[]; failures: SubmissionPackageExportFailure[] }
  | { ok: false; code: SubmissionPackageErrorCode };

export type SubmissionPackageFreezeResult =
  | { ok: true; package: SubmissionPackage }
  | { ok: false; code: SubmissionPackageErrorCode; blockers?: SubmissionPreflightCheck[] };

export type SubmissionPackageFileValidation = {
  fileId: string;
  type: SubmissionPackageFile['type'];
  status: SubmissionPackageFileValidationStatus;
  reason: string;
};
export type SubmissionPackageValidateResult =
  | {
      ok: true;
      results: SubmissionPackageFileValidation[];
      summary: { valid: number; invalid: number; needsConfirmation: number; pending: number };
    }
  | { ok: false; code: SubmissionPackageErrorCode };

export interface SubmissionPackageServiceOptions {
  submissionRepository: SubmissionRepository;
  packageRepository: SubmissionPackageRepository;
  outcomeRepository: OutcomeRepository;
  journalRepository: JournalProfileRepository;
  /** 可选：docx 真实导出能力；缺省时 outcome 类文件退化为 .md 纯文本导出。 */
  docxService?: OutcomeWordDocxService;
  /** 可选：预检服务（P2c 装配前联动预留；当前 freeze 直接读 latestPreflightRun）。 */
  preflightService?: SubmissionPreflightService;
  /** 可选：导出根目录（<userDataDir>/submissions/<caseId>/round-<round>/）。 */
  userDataDir?: string;
}

// ─── 纯函数工具（导出供 CoverLetterService / 测试复算） ────────

/** 成果版本内容指纹：对 JSON.stringify 编码串做真实 sha256。 */
export function hashOutcomeVersionContent(content: OutcomeDocument): string {
  return 'sha256:' + createHash('sha256').update(JSON.stringify(content)).digest('hex');
}

/** 外部文件字节指纹。 */
export function hashFileBytes(bytes: Buffer): string {
  return 'sha256:' + createHash('sha256').update(bytes).digest('hex');
}

/** 标题 → 安全文件名片段：去掉文件系统非法字符，收敛空白，限长。 */
export function normalizeFilenameStem(title: string, fallback = 'manuscript'): string {
  const stem = title
    .replace(/[\\/:*?"<>|]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 80);
  return stem || fallback;
}

// ─── 服务 ────────────────────────────────────────────────────

export class SubmissionPackageService {
  constructor(private readonly options: SubmissionPackageServiceOptions) {}

  /** 包存在性 + 项目归属校验（经 case 反查 projectId）。 */
  private ownedPackage(projectId: string, packageId: string): SubmissionPackage | undefined {
    const pkg = this.options.packageRepository.getPackage(packageId);
    if (!pkg) return undefined;
    const submissionCase = this.options.submissionRepository.getCase(projectId, pkg.caseId);
    return submissionCase ? pkg : undefined;
  }

  /** 取或建该 case 最新 draft 投稿包（最新包已冻结则开新一轮）。 */
  private draftPackageForCase(caseId: string): SubmissionPackage {
    const latest = this.options.packageRepository.latestPackageForCase(caseId);
    if (latest && latest.status === 'draft') return latest;
    return this.options.packageRepository.createPackage(caseId);
  }

  /**
   * 组装投稿包：取或建最新 draft 包，自动登记 main_manuscript 条目指向当前
   * 工作稿（无工作稿回退源成果）当前版本。幂等：同版本不重复建行；版本变了
   * 更新条目并把 validationStatus 打回 pending。
   */
  async assemble(rawInput: unknown): Promise<SubmissionPackageAssembleResult> {
    const parsed = SubmissionPackageAssembleRequestSchema.safeParse(rawInput);
    if (!parsed.success) return { ok: false, code: 'invalid_request' };
    const { projectId, caseId } = parsed.data;
    const submissionCase = this.options.submissionRepository.getCase(projectId, caseId);
    if (!submissionCase) return { ok: false, code: 'case_not_found' };
    const outcomeId = submissionCase.workingOutcomeId ?? submissionCase.sourceOutcomeId;
    const detail = outcomeId ? this.options.outcomeRepository.get(projectId, outcomeId) : undefined;
    if (!outcomeId || !detail) return { ok: false, code: 'manuscript_not_found' };

    const pkg = this.draftPackageForCase(caseId);
    this.upsertOutcomeFile(pkg, {
      type: 'main_manuscript',
      outcomeId,
      version: detail.version.version,
      title: detail.outcome.title,
      content: detail.version.content,
      required: true,
      note: `主稿件：${detail.outcome.title} v${detail.version.version}`,
    });
    return { ok: true, package: this.options.packageRepository.getPackage(pkg.id)!, files: this.options.packageRepository.listPackageFiles(pkg.id) };
  }

  /** 把任意成果当前版本挂为投稿包文件（按 type+outcomeId 幂等更新；frozen 拒绝）。 */
  async attachOutcome(rawInput: unknown): Promise<SubmissionPackageAttachResult> {
    const parsed = SubmissionPackageAttachOutcomeRequestSchema.safeParse(rawInput);
    if (!parsed.success) return { ok: false, code: 'invalid_request' };
    const { projectId, packageId, outcomeId, type } = parsed.data;
    const pkg = this.ownedPackage(projectId, packageId);
    if (!pkg) return { ok: false, code: 'package_not_found' };
    if (pkg.status === 'frozen') return { ok: false, code: 'package_frozen' };
    const detail = this.options.outcomeRepository.get(projectId, outcomeId);
    if (!detail) return { ok: false, code: 'outcome_not_found' };
    const file = this.upsertOutcomeFile(pkg, {
      type,
      outcomeId,
      version: detail.version.version,
      title: detail.outcome.title,
      content: detail.version.content,
      required: parsed.data.required ?? false,
      note: parsed.data.note ?? '',
    });
    return { ok: true, file };
  }

  /** 登记外部文件（补充材料等）：读真实字节算 sha256，只存路径+hash+文件名。 */
  async attachFile(rawInput: unknown): Promise<SubmissionPackageAttachResult> {
    const parsed = SubmissionPackageAttachFileRequestSchema.safeParse(rawInput);
    if (!parsed.success) return { ok: false, code: 'invalid_request' };
    const { projectId, packageId, type, filePath } = parsed.data;
    const pkg = this.ownedPackage(projectId, packageId);
    if (!pkg) return { ok: false, code: 'package_not_found' };
    if (pkg.status === 'frozen') return { ok: false, code: 'package_frozen' };
    let bytes: Buffer;
    try {
      bytes = await readFile(filePath);
    } catch {
      return { ok: false, code: 'file_not_found' };
    }
    const file = this.options.packageRepository.addPackageFile(pkg.id, {
      type,
      filename: basename(filePath),
      artifactPath: filePath,
      contentHash: hashFileBytes(bytes),
      required: parsed.data.required ?? false,
    });
    return { ok: true, file };
  }

  /**
   * 导出投稿包到磁盘：<userDataDir>/submissions/<caseId>/round-<round>/。
   * outcome 类文件优先经 docxService 写真实 .docx；docxService 缺失或文档非
   * word 时退化为纯文本 .md（format 如实标注）。artifactPath 类文件复制过去。
   * 单文件失败不拖垮整批，真实成功/失败清单都返回。
   */
  async exportToDisk(rawInput: unknown): Promise<SubmissionPackageExportResult> {
    const parsed = SubmissionPackageScopedRequestSchema.safeParse(rawInput);
    if (!parsed.success) return { ok: false, code: 'invalid_request' };
    const { projectId, packageId } = parsed.data;
    const pkg = this.ownedPackage(projectId, packageId);
    if (!pkg) return { ok: false, code: 'package_not_found' };
    if (!this.options.userDataDir) return { ok: false, code: 'export_dir_unavailable' };

    const dir = join(this.options.userDataDir, 'submissions', pkg.caseId, `round-${pkg.round}`);
    await mkdir(dir, { recursive: true });
    const files = this.options.packageRepository.listPackageFiles(pkg.id);
    const exported: SubmissionPackageExportedFile[] = [];
    const failures: SubmissionPackageExportFailure[] = [];
    const usedNames = new Set<string>();

    for (const file of files) {
      try {
        const result = await this.exportOneFile(projectId, pkg, file, dir, usedNames);
        exported.push(result);
      } catch (error) {
        failures.push({ fileId: file.id, code: 'export_failed', message: error instanceof Error ? error.message : String(error) });
      }
    }
    return { ok: true, dir, exported, failures };
  }

  /**
   * 冻结投稿包：前置门槛是该 case 最近一次预检存在且 passed=true
   * （无预检或带 block 一律拒绝并附真实 blockers）；冻结后追加
   * package_frozen 事件（source 'human'）。
   */
  async freeze(rawInput: unknown): Promise<SubmissionPackageFreezeResult> {
    const parsed = SubmissionPackageScopedRequestSchema.safeParse(rawInput);
    if (!parsed.success) return { ok: false, code: 'invalid_request' };
    const { projectId, packageId } = parsed.data;
    const pkg = this.ownedPackage(projectId, packageId);
    if (!pkg) return { ok: false, code: 'package_not_found' };

    const run = this.options.packageRepository.latestPreflightRun(pkg.caseId);
    if (!run) return { ok: false, code: 'preflight_not_passed', blockers: [] };
    if (!run.passed) {
      const blockers = this.options.packageRepository.listPreflightChecks(run.id).filter((check) => check.level === 'block');
      return { ok: false, code: 'preflight_not_passed', blockers };
    }

    const frozen = this.options.packageRepository.freezePackage(pkg.id)!;
    const fileCount = this.options.packageRepository.listPackageFiles(pkg.id).length;
    this.options.submissionRepository.addEvent(projectId, {
      caseId: pkg.caseId,
      type: 'package_frozen',
      source: 'human',
      description: `第 ${frozen.round} 轮投稿包已冻结（${fileCount} 个文件）`,
      metadata: { packageId: frozen.id, round: frozen.round, fileCount },
    });
    return { ok: true, package: frozen };
  }

  /**
   * 复核投稿包文件：重算 hash 与所存 contentHash 对比，并检查 outcome 版本
   * 是否仍是最新。hash 不匹配 → invalid；hash 匹配但已有更新版本 →
   * needs_confirmation；两者皆符 → valid。validationStatus 写回仅限 draft
   * 包（frozen 包是仓储层硬边界，只回报不落库）。
   */
  async validate(rawInput: unknown): Promise<SubmissionPackageValidateResult> {
    const parsed = SubmissionPackageScopedRequestSchema.safeParse(rawInput);
    if (!parsed.success) return { ok: false, code: 'invalid_request' };
    const { projectId, packageId } = parsed.data;
    const pkg = this.ownedPackage(projectId, packageId);
    if (!pkg) return { ok: false, code: 'package_not_found' };

    const files = this.options.packageRepository.listPackageFiles(pkg.id);
    const results: SubmissionPackageFileValidation[] = [];
    for (const file of files) {
      results.push(await this.validateOneFile(projectId, file));
    }
    if (pkg.status === 'draft') {
      for (const result of results) {
        this.options.packageRepository.updatePackageFile(pkg.id, result.fileId, { validationStatus: result.status });
      }
    }
    return {
      ok: true,
      results,
      summary: {
        valid: results.filter((item) => item.status === 'valid').length,
        invalid: results.filter((item) => item.status === 'invalid').length,
        needsConfirmation: results.filter((item) => item.status === 'needs_confirmation').length,
        pending: results.filter((item) => item.status === 'pending').length,
      },
    };
  }

  // ── 内部实现 ───────────────────────────────────────────────

  /** 按 (type, outcomeId) 幂等登记/更新成果类条目；版本变化时重置 validationStatus。 */
  private upsertOutcomeFile(
    pkg: SubmissionPackage,
    input: { type: SubmissionPackageFile['type']; outcomeId: string; version: number; title: string; content: OutcomeDocument; required: boolean; note: string },
  ): SubmissionPackageFile {
    const filename = `${normalizeFilenameStem(input.title)}-v${input.version}.docx`;
    const contentHash = hashOutcomeVersionContent(input.content);
    const existing = this.options.packageRepository
      .listPackageFiles(pkg.id)
      .find((file) => file.type === input.type && file.outcomeId === input.outcomeId);
    if (!existing) {
      return this.options.packageRepository.addPackageFile(pkg.id, {
        type: input.type,
        filename,
        outcomeId: input.outcomeId,
        outcomeVersion: input.version,
        contentHash,
        required: input.required,
        note: input.note,
      });
    }
    if (existing.outcomeVersion === input.version && existing.contentHash === contentHash) {
      return existing;
    }
    // 版本或内容变了：更新条目并失效旧校验结论。
    return this.options.packageRepository.updatePackageFile(pkg.id, existing.id, {
      filename,
      outcomeVersion: input.version,
      contentHash,
      validationStatus: 'pending',
      ...(input.note ? { note: input.note } : {}),
    })!;
  }

  /** 单文件导出；写盘成功后在 draft 包上记录导出路径（artifactPath）。 */
  private async exportOneFile(
    projectId: string,
    pkg: SubmissionPackage,
    file: SubmissionPackageFile,
    dir: string,
    usedNames: Set<string>,
  ): Promise<SubmissionPackageExportedFile> {
    const uniqueName = (name: string): string => {
      if (!usedNames.has(name)) { usedNames.add(name); return name; }
      const dot = name.lastIndexOf('.');
      const stamped = dot > 0 ? `${name.slice(0, dot)}-${file.id}${name.slice(dot)}` : `${name}-${file.id}`;
      usedNames.add(stamped);
      return stamped;
    };

    if (file.outcomeId) {
      const detail = this.options.outcomeRepository.get(projectId, file.outcomeId, file.outcomeVersion ?? undefined);
      if (!detail) throw new Error(`outcome_version_not_found:${file.outcomeId}`);
      const document = detail.version.content;
      if (this.options.docxService && document.type === 'word') {
        const name = uniqueName(file.filename || `${normalizeFilenameStem(detail.outcome.title)}-v${detail.version.version}.docx`);
        const target = join(dir, name);
        await this.options.docxService.exportFile(target, document);
        this.recordExportedPath(pkg, file, target);
        return { fileId: file.id, path: target, format: 'docx' };
      }
      // 退化路径：无 docx 导出能力或非 word 文档 → 纯文本 .md，如实标注。
      const name = uniqueName((file.filename || `${normalizeFilenameStem(detail.outcome.title)}-v${detail.version.version}`).replace(/\.docx$/iu, '') + '.md');
      const target = join(dir, name);
      await writeFile(target, extractManuscriptPlainText(document), 'utf8');
      this.recordExportedPath(pkg, file, target);
      return { fileId: file.id, path: target, format: 'markdown' };
    }

    if (file.artifactPath) {
      const name = uniqueName(file.filename || basename(file.artifactPath));
      const target = join(dir, name);
      await copyFile(file.artifactPath, target);
      return { fileId: file.id, path: target, format: 'copy' };
    }

    throw new Error(`package_file_incomplete:${file.id}`);
  }

  /** draft 包上把导出落盘路径写进条目（artifactPath 记录 + note 标注）；frozen 包跳过。 */
  private recordExportedPath(pkg: SubmissionPackage, file: SubmissionPackageFile, target: string): void {
    if (pkg.status !== 'draft') return;
    if (file.artifactPath) return; // 外部文件本身已有真实来源路径，不覆盖。
    this.options.packageRepository.updatePackageFile(pkg.id, file.id, {
      artifactPath: target,
      note: file.note ? `${file.note}；已导出` : '已导出',
    });
  }

  /** 单文件复核：hash 重算 + outcome 版本新鲜度。 */
  private async validateOneFile(projectId: string, file: SubmissionPackageFile): Promise<SubmissionPackageFileValidation> {
    const base = { fileId: file.id, type: file.type };
    if (file.outcomeId) {
      const pinned = file.outcomeVersion !== null
        ? this.options.outcomeRepository.get(projectId, file.outcomeId, file.outcomeVersion)
        : undefined;
      if (!pinned) return { ...base, status: 'invalid', reason: '登记的成果版本已不存在' };
      const actual = hashOutcomeVersionContent(pinned.version.content);
      if (actual !== file.contentHash) return { ...base, status: 'invalid', reason: '内容 hash 与登记值不匹配' };
      const latest = this.options.outcomeRepository.get(projectId, file.outcomeId);
      if (latest && latest.version.version !== pinned.version.version) {
        return { ...base, status: 'needs_confirmation', reason: `成果已更新至 v${latest.version.version}，投稿包登记的是 v${pinned.version.version}` };
      }
      return { ...base, status: 'valid', reason: 'hash 匹配且版本仍是最新' };
    }
    if (file.artifactPath) {
      let bytes: Buffer;
      try {
        bytes = await readFile(file.artifactPath);
      } catch {
        return { ...base, status: 'invalid', reason: '外部文件不可读取' };
      }
      if (hashFileBytes(bytes) !== file.contentHash) return { ...base, status: 'invalid', reason: '文件内容 hash 与登记值不匹配' };
      return { ...base, status: 'valid', reason: 'hash 匹配' };
    }
    return { ...base, status: 'invalid', reason: '条目既无成果引用也无文件路径' };
  }
}
