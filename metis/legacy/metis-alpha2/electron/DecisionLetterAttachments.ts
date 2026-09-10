/**
 * DecisionLetterAttachments — 决定信附件文本提取。
 *
 * 职责：把编辑邮件附件（DOCX / PDF / 纯文本）提取为纯文本，供
 * SubmissionReviewService 的确定性解析拆解 Reviewer 意见。
 *
 * 诚实边界（刘总红线）：
 *  - 提取不出文本就如实返回失败原因，绝不生成占位/示例文本；
 *  - 不认识的类型如实报 unsupported_type；
 *  - 单个附件失败不影响其他附件（逐条返回，由调用方汇总 warning）。
 */
import JSZip from 'jszip';

export interface AttachmentTextResult {
  ok: boolean;
  /** 提取成功时的纯文本；失败时为空串。 */
  text: string;
  /** 失败原因（unsupported_type / extract_failed:<detail>）。 */
  reason: string;
}

/** 提取文本总长上限：决定信正文极少超过此值，防异常巨型文档。 */
const TEXT_LIMIT = 300_000;

/** 按扩展名粗分类别；无扩展名时回退 MIME 类型判断。 */
function classify(filename: string, mimeType: string): 'docx' | 'pdf' | 'text' | 'unknown' {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.docx')) return 'docx';
  if (lower.endsWith('.pdf')) return 'pdf';
  if (lower.endsWith('.txt') || lower.endsWith('.md') || lower.endsWith('.csv')) return 'text';
  if (/wordprocessingml/iu.test(mimeType)) return 'docx';
  if (/^application\/pdf$/iu.test(mimeType)) return 'pdf';
  if (/^text\//iu.test(mimeType)) return 'text';
  return 'unknown';
}

/** DOCX → 纯文本：解 zip 读 word/document.xml，按段落聚合 w:t 文本。 */
async function extractDocx(data: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(data);
  const entry = zip.file('word/document.xml');
  if (!entry) throw new Error('missing_word_document_xml');
  const xml = await entry.async('string');
  // 段落边界换行，段内拼接各 w:t 文本；XML 实体做最小还原。
  return xml
    .replace(/<w:p[ >]/gu, '\n<w:p ')
    .replace(/<w:t[^>]*>([^<]*)<\/w:t>/gu, (_m, text: string) => text)
    .replace(/<[^>]+>/gu, '')
    .replace(/&lt;/gu, '<').replace(/&gt;/gu, '>').replace(/&amp;/gu, '&')
    .replace(/&quot;/gu, '"').replace(/&apos;/gu, "'")
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

/** PDF → 纯文本：pdfjs-dist v4 ESM 动态导入（与 engine/research/PdfReader 同模式）。 */
async function extractPdf(data: Buffer): Promise<string> {
  const pdfjs = await import('pdfjs-dist') as typeof import('pdfjs-dist');
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    useSystemFonts: true,
  }).promise;
  const pages: string[] = [];
  for (let pageNum = 1; pageNum <= doc.numPages; pageNum += 1) {
    const page = await doc.getPage(pageNum);
    const content = await page.getTextContent();
    pages.push(content.items.map((item) => ('str' in item ? item.str : '')).join(' '));
    if (pages.join('\n').length > TEXT_LIMIT) break;
  }
  return pages.join('\n').trim();
}

/**
 * 提取单个附件的纯文本。永不抛异常：失败以 { ok:false, reason } 返回。
 */
export async function extractAttachmentText(attachment: {
  filename: string; mimeType: string; data: Buffer;
}): Promise<AttachmentTextResult> {
  try {
    const kind = classify(attachment.filename, attachment.mimeType);
    let text = '';
    if (kind === 'docx') text = await extractDocx(attachment.data);
    else if (kind === 'pdf') text = await extractPdf(attachment.data);
    else if (kind === 'text') text = attachment.data.toString('utf8');
    else return { ok: false, text: '', reason: 'unsupported_type' };
    if (!text.trim()) return { ok: false, text: '', reason: 'empty_text' };
    return { ok: true, text: text.slice(0, TEXT_LIMIT), reason: '' };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, text: '', reason: `extract_failed:${detail.slice(0, 120)}` };
  }
}
