import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { WordDocument } from '../../engine/runtime/OutcomeRuntimeContract.js';
import { OutcomeWordDocxService } from '../../electron/OutcomeWordDocxService.js';
import { readGenofficeAnchor } from '../../electron/office/genofficeBridge.js';

const Fixtures = path.resolve(__dirname, '../../tests/fixtures/genoffice');
const kitchenSinkBytes = () => new Uint8Array(readFileSync(path.join(Fixtures, 'kitchen-sink.docx')));
const metisReportBytes = () => new Uint8Array(readFileSync(path.join(Fixtures, 'metis-report.docx')));

async function importWithArchive(source: Uint8Array): Promise<{ document: WordDocument; archiveId: string }> {
  const archiveId = 'om-test-archive-1';
  const service = new OutcomeWordDocxService({
    engine: 'genoffice',
    persistOriginalArchive: async () => archiveId,
  });
  const imported = await service.importBufferV2(source);
  return { document: imported.document, archiveId };
}

function anchorOf(block: WordDocument['blocks'][number]): number | null {
  return readGenofficeAnchor(block);
}

describe('OutcomeWordDocxService GenOffice path', () => {
  it('imports with per-block patch anchors and full structure', async () => {
    const service = new OutcomeWordDocxService({ engine: 'genoffice' });
    const imported = await service.importBufferV2(kitchenSinkBytes());
    expect(imported.warnings.length).toBe(0);
    const anchors = imported.document.blocks.map((block) => anchorOf(block));
    expect(anchors.every((anchor) => typeof anchor === 'number')).toBe(true);
    const kinds = imported.document.blocks.map((block) => block.kind);
    expect(kinds).toContain('heading');
    expect(kinds).toContain('paragraph');
    expect(kinds).toContain('table');
    expect(kinds).toContain('image');
  });

  it('round-trips an untouched import byte-identically', async () => {
    const source = kitchenSinkBytes();
    const imported = await importWithArchive(source);
    const exporter = new OutcomeWordDocxService({
      engine: 'genoffice',
      resolveOriginalArchive: async (mediaId) => mediaId === imported.archiveId ? Buffer.from(source) : undefined,
    });
    const exported = await exporter.exportManagedDocument(imported.document);
    expect(Buffer.from(exported.bytes).equals(Buffer.from(source))).toBe(true);
  });

  it('round-trips a METIS legacy export byte-identically', async () => {
    const source = metisReportBytes();
    const imported = await importWithArchive(source);
    const exporter = new OutcomeWordDocxService({
      engine: 'genoffice',
      resolveOriginalArchive: async (mediaId) => mediaId === imported.archiveId ? Buffer.from(source) : undefined,
    });
    const exported = await exporter.exportManagedDocument(imported.document);
    expect(Buffer.from(exported.bytes).equals(Buffer.from(source))).toBe(true);
  });

  it('persists and re-reads the original archive through the service options', async () => {
    const source = kitchenSinkBytes();
    let stored: Buffer | undefined;
    const importer = new OutcomeWordDocxService({
      engine: 'genoffice',
      persistOriginalArchive: async (archive) => {
        stored = Buffer.from(archive);
        return 'om-test-archive-1';
      },
    });
    const imported = await importer.importBufferV2(new Uint8Array(source));
    expect(stored).toBeDefined();
    expect((imported.document.page as Record<string, unknown>)._originalArchiveMediaId).toBe('om-test-archive-1');
    const exporter = new OutcomeWordDocxService({
      engine: 'genoffice',
      resolveOriginalArchive: async (mediaId) => (mediaId === 'om-test-archive-1' ? stored : undefined),
    });
    const exported = await exporter.exportManagedDocument(imported.document);
    expect(Buffer.from(exported.bytes).equals(Buffer.from(source))).toBe(true);
  });

  it('applies a controlled text edit through the patch path and keeps other blocks original', async () => {
    const source = kitchenSinkBytes();
    const imported = await importWithArchive(source);
    const target = imported.document.blocks.find((block) => block.kind === 'paragraph' && (block.text ?? '').trim().length > 0);
    expect(target).toBeDefined();
    const edited: WordDocument = {
      ...imported.document,
      blocks: imported.document.blocks.map((block) =>
        block.id === target!.id ? { ...block, text: '[METIS P1] 受控编辑后的段落内容。' } : block,
      ),
    };
    const exporter = new OutcomeWordDocxService({
      engine: 'genoffice',
      resolveOriginalArchive: async (mediaId) => mediaId === imported.archiveId ? Buffer.from(source) : undefined,
      resolveManagedImage: async () => ({
        mediaId: 'om-test-image',
        mediaType: 'image/png' as const,
        displayName: 'test.png',
        bytes: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'),
      }),
    });
    const exported = await exporter.exportManagedDocument(edited);
    expect(exported.warnings.length).toBe(0);
    const reparsed = await new OutcomeWordDocxService({ engine: 'genoffice' }).importBufferV2(new Uint8Array(exported.bytes));
    const visible = reparsed.document.blocks.some((block) => (block.text ?? '').includes('[METIS P1]'));
    expect(visible).toBe(true);
    const untouched = reparsed.document.blocks.filter((block) => !(block.text ?? '').includes('[METIS P1]'));
    expect(untouched.length).toBeGreaterThan(0);
    for (const block of untouched) expect(anchorOf(block)).not.toBeNull();
  });

  it('supports appending and deleting blocks through the patch path', async () => {
    const source = kitchenSinkBytes();
    const imported = await importWithArchive(source);
    const withoutFirst = imported.document.blocks.slice(1);
    const appended: WordDocument = {
      ...imported.document,
      blocks: [
        { id: 'genoffice-new-1', kind: 'paragraph', text: '[METIS P1] 追加的新段落。', style: {} },
        ...withoutFirst,
        { id: 'genoffice-new-2', kind: 'heading', level: 2, text: '[METIS P1] 追加的结尾标题。', style: {} },
      ],
    };
    const exporter = new OutcomeWordDocxService({
      engine: 'genoffice',
      resolveOriginalArchive: async (mediaId) => mediaId === imported.archiveId ? Buffer.from(source) : undefined,
    });
    const exported = await exporter.exportManagedDocument(appended);
    const reparsed = await new OutcomeWordDocxService({ engine: 'genoffice' }).importBufferV2(new Uint8Array(exported.bytes));
    const texts = reparsed.document.blocks.map((block) => block.text ?? '').join('\n');
    expect(texts).toContain('追加的新段落');
    expect(texts).toContain('追加的结尾标题');
    expect(reparsed.document.blocks.length).toBe(appended.blocks.length);
  });

  it('falls back to the legacy codec when the original archive is unavailable', async () => {
    const service = new OutcomeWordDocxService({ engine: 'legacy' });
    const imported = await service.importBufferV2(Buffer.from(kitchenSinkBytes()));
    const exporter = new OutcomeWordDocxService({
      resolveOriginalArchive: async () => undefined,
    });
    const exported = await exporter.exportManagedDocument(imported.document);
    expect(exported.bytes.length).toBeGreaterThan(1000);
    const reparsed = await service.importBufferV2(Buffer.from(exported.bytes));
    expect(reparsed.document.blocks.length).toBeGreaterThan(0);
  });

  it('commits imported images through the GenOffice extraction path', async () => {
    const service = new OutcomeWordDocxService({ engine: 'genoffice' });
    const imported = await service.importBufferV2(kitchenSinkBytes());
    const imageBlocks = imported.document.blocks.filter((block) => block.kind === 'image');
    expect(imageBlocks.length).toBeGreaterThan(0);
    const persisted: string[] = [];
    const committed = await service.commitImportedMedia(
      Buffer.from(kitchenSinkBytes()),
      imported.document,
      async (image) => {
        const id = `om-committed-${persisted.length + 1}`;
        persisted.push(id);
        return { id, mediaType: image.mediaType, displayName: image.displayName };
      },
      async () => undefined,
    );
    expect(persisted.length).toBe(imageBlocks.length);
    for (const block of committed.blocks) {
      if (block.kind === 'image') expect(block.imageRef?.startsWith('genoffice-image-')).toBe(false);
    }
  });
});
