/**
 * JobQueueService — PDF 全文抽取管道（T2/T10）。
 *
 * 用最小合法 PDF fixture 验证：pdfjs 真实抽取 → 质量检查 → 写回 papers.pdf_text。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JobQueueService } from '../../electron/JobQueueService.js';
import { PersistenceStore } from '../../engine/persistence/PersistenceStore.js';

/** 生成一页、含指定文本的最小合法 PDF（Type1 Helvetica，无需嵌入字体）。 */
function buildMinimalPdf(text: string): Buffer {
  const content = `BT /F1 14 Tf 72 700 Td (${text.replace(/([()\\])/gu, '\\$1')}) Tj ET`;
  const objects: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

let tmpDir: string;
let store: PersistenceStore;
let service: JobQueueService;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-jobs-'));
  store = new PersistenceStore(path.join(tmpDir, 'test.db'));
  service = new JobQueueService({ dataDir: tmpDir, store });
});

afterEach(() => {
  store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('JobQueueService — PDF 全文抽取', () => {
  it('真实抽取最小 PDF 并写回 papers.pdf_text', async () => {
    const pdfPath = path.join(tmpDir, 'sample.pdf');
    fs.writeFileSync(pdfPath, buildMinimalPdf('METIS full text extraction works'));
    store.savePaper({
      id: 'paper-extract-1',
      title: '抽取测试论文',
      authors: [],
      year: 2024,
      venue: '',
      abstract: '',
      pdfPath,
      tags: [],
      notes: '',
      readStatus: 'unread',
      rating: 0,
      addedAt: Date.now(),
    });

    const result = await service.extractPdfText(pdfPath);
    expect(result.quality.pages).toBe(1);
    expect(result.text).toContain('METIS full text extraction works');

    const job = service.enqueueExtract('paper-extract-1', pdfPath);
    expect(job).not.toBeNull();
    await waitForJob(service, job!.id);
    const updated = store.getPapers().find((row) => row.id === 'paper-extract-1')!;
    expect(updated.pdfText).toContain('METIS full text extraction works');
  });

  it('空文本 PDF 被标记为可疑（扫描件）但不失败', async () => {
    const pdfPath = path.join(tmpDir, 'blank.pdf');
    // 合法但无文字的 PDF（空内容流）。
    fs.writeFileSync(pdfPath, buildMinimalPdf(''));
    const result = await service.extractPdfText(pdfPath);
    expect(result.quality.suspicious).toBe(true);
  });

  it('文件不存在时作业失败并带错误信息', async () => {
    const job = service.enqueueExtract('paper-missing', path.join(tmpDir, 'nope.pdf'));
    expect(job).not.toBeNull();
    const finished = await waitForJob(service, job!.id);
    expect(finished.status).toBe('failed');
    expect(finished.error).toContain('pdf_not_found');
  });

  it('批量回填跳过已有全文的文献', async () => {
    store.savePaper({
      id: 'paper-has-text',
      title: '已有全文',
      authors: [], year: 2024, venue: '', abstract: '',
      pdfPath: path.join(tmpDir, 'a.pdf'),
      pdfText: '[p1] 已有全文内容',
      tags: [], notes: '', readStatus: 'unread', rating: 0, addedAt: Date.now(),
    });
    store.savePaper({
      id: 'paper-no-text',
      title: '缺全文',
      authors: [], year: 2024, venue: '', abstract: '',
      pdfPath: path.join(tmpDir, 'missing.pdf'),
      tags: [], notes: '', readStatus: 'unread', rating: 0, addedAt: Date.now(),
    });
    const job = service.enqueueBacklog();
    // 只有一篇缺全文（且它的 PDF 文件不存在 → 计入 failed，不算 extracted）。
    expect(job).not.toBeNull();
    const finished = await waitForJob(service, job!.id);
    expect(finished.status).toBe('done');
    expect(finished.result).toEqual({ extracted: 0, failed: 1 });
  });
});

async function waitForJob(service: JobQueueService, jobId: string) {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const job = service.queue.list().find((j) => j.id === jobId);
    if (job && job.status !== 'queued' && job.status !== 'running') return job;
    if (Date.now() > deadline) throw new Error(`job ${jobId} did not finish in time`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
