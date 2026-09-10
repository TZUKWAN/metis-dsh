import { describe, expect, it } from 'vitest';
import { ImageGenerationSettingsUpdateSchema, OutcomeCreateRequestSchema, OutcomeImageGenerateRequestSchema, OutcomeImageGenerateResultSchema, OutcomeMediaSchema, OutcomePptxImportCommitRequestSchema, OutcomePptxImportResultSchema, OutcomeWordDocxImportCommitRequestSchema, OutcomeWordDocxImportResultSchema, PptDocumentSchema } from '../../engine/runtime/OutcomeRuntimeContract.js';

describe('OutcomeRuntimeContract image generation boundary', () => {
  it('accepts a project-scoped image request without filesystem authority', () => {
    expect(OutcomeImageGenerateRequestSchema.safeParse({ projectId: 'project-1', outcomeId: 'outcome-1', prompt: 'A blue research chart', visualContext: '16:9 theme', quality: 'high' }).success).toBe(true);
  });
  it('rejects control-character prompts', () => {
    expect(OutcomeImageGenerateRequestSchema.safeParse({ projectId: 'project-1', outcomeId: 'outcome-1', prompt: 'bad\u0000prompt' }).success).toBe(false);
  });
  it('only accepts the fixed secure Vault key reference', () => {
    expect(ImageGenerationSettingsUpdateSchema.safeParse({ provider: 'OpenAI', model: 'gpt-image-1', endpoint: 'https://api.example.test/images', defaultQuality: 'standard', apiKeyRef: '$' + '{secret:OUTCOME_IMAGE_API_KEY}' }).success).toBe(true);
    expect(ImageGenerationSettingsUpdateSchema.safeParse({ provider: 'OpenAI', model: 'gpt-image-1', endpoint: 'https://api.example.test/images', defaultQuality: 'standard', apiKeyRef: '$' + '{secret:OTHER_KEY}' }).success).toBe(false);
    expect(ImageGenerationSettingsUpdateSchema.safeParse({ provider: 'OpenAI', model: 'gpt-image-1', endpoint: 'http://api.example.test/images', defaultQuality: 'standard', apiKeyRef: null }).success).toBe(false);
  });
  it('accepts SVG as a durable media handle while keeping generation output raster-only', () => {
    expect(OutcomeMediaSchema.safeParse({ id:'om-svg', mediaType:'image/svg+xml', displayName:'figure.svg', byteLength:128 }).success).toBe(true);
    expect(OutcomeImageGenerateResultSchema.safeParse({ ok: true, mimeType: 'image/png', media: { id:'om-1', mediaType:'image/png', displayName:'AI-generated.png', byteLength:8 } }).success).toBe(true);
    expect(OutcomeImageGenerateResultSchema.safeParse({ ok: true, mimeType: 'image/png', dataUrl: 'data:image/png;base64,iVBORw0KGgo=' }).success).toBe(false);
    expect(OutcomeImageGenerateResultSchema.safeParse({ ok: true, mimeType: 'image/gif', media: { id:'om-1', mediaType:'image/png', displayName:'AI-generated.png', byteLength:8 } }).success).toBe(false);
  });
  it('retains integer-grid PPT canonical validation for generated image elements', () => {
    expect(PptDocumentSchema.safeParse({ type: 'ppt', ratio: '16:9', theme: {}, templateId: null, pages: [{ id: 'slide-1', title: 'Slide', pageType: 'content', humanModified: true, status: 'complete', elements: [{ id: 'image-1', type: 'image', x: 20, y: 10, width: 9, height: 6, locked: false, props: { src: 'data:image/png;base64,iVBORw0KGgo=' } }] }] }).success).toBe(true);
    expect(PptDocumentSchema.safeParse({ type: 'ppt', ratio: '16:9', theme: {}, templateId: null, pages: [{ id: 'slide-1', title: 'Slide', pageType: 'content', humanModified: true, status: 'complete', elements: [{ id: 'image-1', type: 'image', x: 20.5, y: 10, width: 9, height: 6, locked: false, props: {} }] }] }).success).toBe(false);
    expect(PptDocumentSchema.safeParse({ type: 'ppt', ratio: '16:9', theme: {}, templateId: null, pages: [{ id: 'slide-1', title: 'Slide', pageType: 'content', humanModified: true, status: 'complete', elements: [{ id: 'image-1', type: 'image', x: 20, y: 10, width: 9.25, height: 6, locked: false, props: {} }] }] }).success).toBe(false);
  });

  it('preserves an explicit import actor when an imported Word document becomes its first immutable version', () => {
    const content = { type: 'word', blocks: [{ id: 'p-1', kind: 'paragraph', text: '来自外部 DOCX' }], page: { paper: 'A4' }, header: '', footer: '' };
    expect(OutcomeCreateRequestSchema.safeParse({ projectId: 'project-1', categoryId: null, title: '外部报告', kind: 'word', content, note: '导入 external.docx', actor: 'import' }).data).toMatchObject({ actor: 'import' });
    expect(OutcomeCreateRequestSchema.safeParse({ projectId: 'project-1', categoryId: null, title: '外部报告', kind: 'word', content, note: '导入 external.docx', actor: 'forged' }).success).toBe(false);
  });
  it('requires a main-owned import token and typed document for PPTX media commit', () => {
    const document = { type: 'ppt' as const, ratio: '16:9' as const, theme: {}, templateId: null, generationSkillId: null, pages: [] };
    expect(OutcomePptxImportCommitRequestSchema.safeParse({ projectId: 'project-1', importToken: 'pptx-import-1', document }).success).toBe(true);
    expect(OutcomePptxImportCommitRequestSchema.safeParse({ projectId: 'project-1', importToken: '../outside', document }).success).toBe(false);
    expect(OutcomePptxImportResultSchema.safeParse({ ok: true, fileName: 'deck.pptx', importToken: 'pptx-import-1', document, warnings: [] }).success).toBe(true);
    expect(OutcomePptxImportResultSchema.safeParse({ ok: true, fileName: 'deck.pptx', document, warnings: [] }).success).toBe(false);
  });
  it('requires a main-owned DOCX token and safe image preview metadata for media commit', () => {
    const document = { type: 'word' as const, blocks: [{ id: 'docx-import-image-1', kind: 'image' as const, imageRef: 'docx-import-image-1', mediaType: 'image/png' as const, displayName: 'figure.png' }], page: {}, header: '', footer: '' };
    const preview = { images: [{ blockId: 'docx-import-image-1', mediaType: 'image/png' as const, displayName: 'figure.png', byteLength: 128 }] };
    expect(OutcomeWordDocxImportCommitRequestSchema.safeParse({ projectId: 'project-1', importToken: 'docx-import-1', document }).success).toBe(true);
    expect(OutcomeWordDocxImportResultSchema.safeParse({ ok: true, fileName: 'report.docx', importToken: 'docx-import-1', document, preview, warnings: [] }).success).toBe(true);
    expect(OutcomeWordDocxImportResultSchema.safeParse({ ok: true, fileName: 'report.docx', importToken: 'docx-import-1', document, preview: { images: [{ ...preview.images[0], bytes: 'leak' }] }, warnings: [] }).success).toBe(false);
    expect(OutcomeWordDocxImportCommitRequestSchema.safeParse({ projectId: 'project-1', importToken: '../outside', document }).success).toBe(false);
  });
});
