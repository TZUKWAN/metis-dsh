/**
 * DEEPSEEK-301 (fix round) — DOCX structure + CJK verification tests.
 *
 * Verifies:
 * - Real OOXML parts: footnotes.xml, document.xml.rels, styles.xml
 * - Real footnote references in document.xml
 * - Bibliography section from citations scope
 * - Evidence appendix
 * - Caption paragraphs
 * - Chinese/CJK content survives the OOXML pipeline (UTF-8 round-trip)
 * - No placeholder or corrupt output
 */

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { renderDocx } from '../DocxRenderer.js';
import type { RenderInput } from '../RendererTypes.js';

function decompressBuffers(buf: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  let offset = 0;
  while (offset < buf.length - 4) {
    if (buf.readUInt32LE(offset) !== 0x04034b50) break;
    const method = buf.readUInt16LE(offset + 8);
    const compSize = buf.readUInt32LE(offset + 18);
    const nameLen = buf.readUInt16LE(offset + 26);
    const extraLen = buf.readUInt16LE(offset + 28);
    const name = buf.subarray(offset + 30, offset + 30 + nameLen).toString('utf8');
    const dataOffset = offset + 30 + nameLen + extraLen;
    const compressed = buf.subarray(dataOffset, dataOffset + compSize);
    const data = method === 8 ? inflateRawSync(compressed) : compressed;
    entries.set(name, Buffer.from(data));
    offset = dataOffset + compSize;
  }
  return entries;
}

function decompressAll(buf: Buffer): Map<string, string> {
  return new Map(
    [...decompressBuffers(buf).entries()].map(([name, data]) => [name, data.toString('utf8')]),
  );
}

const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlV9Z8AAAAASUVORK5CYII=';
const PNG_BYTES = Buffer.from(PNG_BASE64, 'base64');
const PNG_SHA256 = createHash('sha256').update(PNG_BYTES).digest('hex');

function makeCjkInput(): RenderInput {
  return {
    request: {
      exportId: 'ex_' + 'a'.repeat(32),
      projectId: 'proj_test-001',
      artifactId: 'artifact_test-001',
      destinationCapabilityId: 'fc_' + 'b'.repeat(32),
      displayName: '中文学术论文导出测试',
      scopes: ['project', 'citations', 'evidence'],
      format: 'docx',
      privacyProfile: 'private-local',
      redaction: {
        stripSecrets: true,
        stripAbsolutePaths: true,
        stripPersonalData: true,
        pseudonymizeParticipants: true,
        omitRawTranscripts: false,
        omitModelPrompts: false,
        omitToolArguments: true,
      },
      requestedAt: 1700000000000,
      artifactVersion: 7,
      artifactManifestDigest: 'd'.repeat(64),
    },
    records: new Map([
      ['project', [
        {
          id: 'rec1',
          title: '研究摘要',
          content: '本文研究了深度学习在自然语言处理中的应用。\n实验结果表明，模型准确率达到95%。',
          sensitivity: 'none',
          fields: [
            { key: '作者', value: '张三', sensitivity: 'none' },
            { key: 'caption', value: '图1：模型架构图', sensitivity: 'none' },
            { key: '原始逐字稿', value: '受访者说了一些敏感内容', sensitivity: 'raw-transcript' },
          ],
          images: [{
            id: 'figure-1',
            mediaType: 'image/png',
            base64Data: PNG_BASE64,
            sha256: PNG_SHA256,
            widthPx: 1,
            heightPx: 1,
            caption: '图1：模型架构图（嵌入图片）',
          }],
        },
      ]],
      ['citations', [
        {
          id: 'cite_wang2024',
          title: 'Wang et al. 2024',
          content: '王明, 李华. 《深度学习方法研究》. 计算机学报, 2024.',
          sensitivity: 'none',
          fields: [],
          images: [],
        },
      ]],
      ['evidence', [
        {
          id: 'ev1',
          title: '实验数据',
          content: '样本量：n=200，准确率：93.5%。',
          sensitivity: 'none',
          fields: [
            { key: '数据集', value: '中文NLP语料库', sensitivity: 'none' },
          ],
          images: [],
        },
      ]],
    ]),
  };
}

describe('DocxRenderer — structure and CJK', () => {
  const input = makeCjkInput();

  it('produces valid DOCX with PK ZIP signature', () => {
    const result = renderDocx(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bytes[0]).toBe(0x50);
    expect(result.bytes[1]).toBe(0x4b);
  });

  it('ZIP contains all required OOXML parts', () => {
    const result = renderDocx(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const entries = decompressAll(Buffer.from(result.bytes));
    expect(entries.has('[Content_Types].xml')).toBe(true);
    expect(entries.has('_rels/.rels')).toBe(true);
    expect(entries.has('word/document.xml')).toBe(true);
    expect(entries.has('word/styles.xml')).toBe(true);
    expect(entries.has('word/footnotes.xml')).toBe(true);
    expect(entries.has('word/_rels/document.xml.rels')).toBe(true);
    expect(entries.has('word/media/image1.png')).toBe(true);
  });

  it('document.xml contains CJK Chinese title and content (UTF-8 round-trip)', () => {
    const result = renderDocx(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const entries = decompressAll(Buffer.from(result.bytes));
    const doc = entries.get('word/document.xml') ?? '';
    expect(doc).toContain('中文学术论文导出测试');
    expect(doc).toContain('研究摘要');
    expect(doc).toContain('深度学习在自然语言处理中的应用');
    expect(doc).toContain('模型准确率达到95%');
  });

  it('document.xml contains real footnote references (w:footnoteReference)', () => {
    const result = renderDocx(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const entries = decompressAll(Buffer.from(result.bytes));
    const doc = entries.get('word/document.xml') ?? '';
    expect(doc).toContain('w:footnoteReference');
  });

  it('footnotes.xml contains footnote definitions with CJK text', () => {
    const result = renderDocx(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const entries = decompressAll(Buffer.from(result.bytes));
    const fns = entries.get('word/footnotes.xml') ?? '';
    expect(fns).toContain('footnote');
    // Should contain the sensitive field text as footnote body
    expect(fns).toContain('受访者说了一些敏感内容');
  });

  it('document.xml contains Bibliography section with citation', () => {
    const result = renderDocx(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const entries = decompressAll(Buffer.from(result.bytes));
    const doc = entries.get('word/document.xml') ?? '';
    expect(doc).toContain('Bibliography');
    expect(doc).toContain('cite_wang2024');
    expect(doc).toContain('王明, 李华');
  });

  it('document.xml contains Evidence Appendix section', () => {
    const result = renderDocx(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const entries = decompressAll(Buffer.from(result.bytes));
    const doc = entries.get('word/document.xml') ?? '';
    expect(doc).toContain('Evidence Appendix');
    expect(doc).toContain('实验数据');
  });

  it('document.xml contains Caption paragraph for figure reference', () => {
    const result = renderDocx(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const entries = decompressAll(Buffer.from(result.bytes));
    const doc = entries.get('word/document.xml') ?? '';
    expect(doc).toContain('Caption');
    expect(doc).toContain('图1：模型架构图');
    expect(doc).toContain('图1：模型架构图（嵌入图片）');
  });

  it('embeds image bytes with drawing markup, extent, relationship, and content type', () => {
    const result = renderDocx(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const binaryEntries = decompressBuffers(Buffer.from(result.bytes));
    expect(binaryEntries.get('word/media/image1.png')).toEqual(PNG_BYTES);
    const entries = decompressAll(Buffer.from(result.bytes));
    const doc = entries.get('word/document.xml') ?? '';
    expect(doc).toContain('<w:drawing>');
    expect(doc).toContain('<wp:inline');
    expect(doc).toMatch(/<wp:extent cx="\d+" cy="\d+"\/>/u);
    expect(doc).toContain('<a:blip r:embed="rId3"/>');
    expect(doc).toContain('descr="图1：模型架构图（嵌入图片）"');
    const rels = entries.get('word/_rels/document.xml.rels') ?? '';
    expect(rels).toContain('relationships/image');
    expect(rels).toContain('Id="rId3"');
    expect(rels).toContain('Target="media/image1.png"');
    const contentTypes = entries.get('[Content_Types].xml') ?? '';
    expect(contentTypes).toContain('Extension="png" ContentType="image/png"');
  });

  it('writes the exact artifact binding into DOCX provenance', () => {
    const result = renderDocx(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const doc = decompressAll(Buffer.from(result.bytes)).get('word/document.xml') ?? '';
    expect(doc).toContain('Artifact Version');
    expect(doc).toContain('Artifact ID');
    expect(doc).toContain('artifact_test-001');
    expect(doc).toContain('>7<');
    expect(doc).toContain('Artifact Manifest SHA-256');
    expect(doc).toContain('d'.repeat(64));
  });

  it('document.xml.rels references footnotes.xml', () => {
    const result = renderDocx(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const entries = decompressAll(Buffer.from(result.bytes));
    const rels = entries.get('word/_rels/document.xml.rels') ?? '';
    expect(rels).toContain('footnotes');
    expect(rels).toContain('Target="footnotes.xml"');
  });

  it('Content_Types.xml declares footnotes override', () => {
    const result = renderDocx(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const entries = decompressAll(Buffer.from(result.bytes));
    const ct = entries.get('[Content_Types].xml') ?? '';
    expect(ct).toContain('footnotes');
  });

  it('styles.xml defines eastAsia font (SimSun) for CJK', () => {
    const result = renderDocx(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const entries = decompressAll(Buffer.from(result.bytes));
    const styles = entries.get('word/styles.xml') ?? '';
    expect(styles).toContain('eastAsia');
    expect(styles).toContain('SimSun');
  });

  it('styles.xml defines Caption, FootnoteText, Appendix styles', () => {
    const result = renderDocx(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const entries = decompressAll(Buffer.from(result.bytes));
    const styles = entries.get('word/styles.xml') ?? '';
    expect(styles).toContain('Caption');
    expect(styles).toContain('FootnoteText');
    expect(styles).toContain('Appendix');
  });

  it('DOCX bytes are non-trivial (> 2KB with CJK + footnotes)', () => {
    const result = renderDocx(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bytes.length).toBeGreaterThan(2048);
  });

  it('fails closed when an image digest is tampered', () => {
    const project = [...(input.records.get('project') ?? [])].map((record) => ({
      ...record,
      images: record.images.map((image) => ({ ...image, sha256: '0'.repeat(64) })),
    }));
    const records = new Map(input.records);
    records.set('project', project);
    const tampered: RenderInput = { ...input, records };
    const result = renderDocx(tampered);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/SHA-256 mismatch/u);
  });

  it.each([
    ['unsupported SVG', { mediaType: 'image/svg+xml', base64Data: PNG_BASE64, sha256: PNG_SHA256 }],
    ['invalid base64', { mediaType: 'image/png', base64Data: 'not-base64', sha256: PNG_SHA256 }],
  ])('fails closed for %s image payload', (_label, override) => {
    const project = [...(input.records.get('project') ?? [])].map((record) => ({
      ...record,
      images: record.images.map((image) => ({ ...image, ...override })),
    }));
    const records = new Map(input.records);
    records.set('project', project as never);
    const invalidInput = { ...input, records } as RenderInput;
    expect(renderDocx(invalidInput).ok).toBe(false);
  });

  it('fails closed when intrinsic image dimensions exceed the safe limit', () => {
    const oversized = Buffer.from(PNG_BYTES);
    oversized.writeUInt32BE(10_001, 16);
    const oversizedBase64 = oversized.toString('base64');
    const oversizedSha256 = createHash('sha256').update(oversized).digest('hex');
    const project = [...(input.records.get('project') ?? [])].map((record) => ({
      ...record,
      images: record.images.map((image) => ({
        ...image,
        base64Data: oversizedBase64,
        sha256: oversizedSha256,
      })),
    }));
    const records = new Map(input.records);
    records.set('project', project);
    expect(renderDocx({ ...input, records }).ok).toBe(false);
  });

  it('fail-closed: empty records does not crash', () => {
    const emptyInput: RenderInput = {
      request: { ...input.request, scopes: ['audit'] },
      records: new Map(),
    };
    const result = renderDocx(emptyInput);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const entries = decompressAll(Buffer.from(result.bytes));
    const doc = entries.get('word/document.xml') ?? '';
    expect(doc).toContain('w:document');
    expect(doc).toContain('Artifact Provenance');
  });
});
