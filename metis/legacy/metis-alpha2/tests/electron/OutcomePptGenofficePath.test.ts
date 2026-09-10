import { readFileSync } from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import type { PptDocument } from '../../engine/runtime/OutcomeRuntimeContract.js';
import { OutcomePptxService } from '../../electron/OutcomePptxService.js';
import { GENOFFICE_PPTX_ORIGINAL_ARCHIVE_KEY } from '../../electron/office/genofficePptxBridge.js';

const fixture = (name: string): Buffer => readFileSync(path.resolve(__dirname, '../../tests/fixtures/genoffice', name));

async function zipXmlEntries(bytes: Buffer): Promise<Map<string, string>> {
  const zip = await JSZip.loadAsync(bytes);
  const result = new Map<string, string>();
  for (const name of Object.keys(zip.files)) {
    if (zip.files[name]!.dir) continue;
    if (/\.xml$|\.rels$/u.test(name)) result.set(name, await zip.files[name]!.async('string'));
  }
  return result;
}

function withArchive(document: PptDocument): PptDocument {
  return {
    ...document,
    theme: { ...document.theme, [GENOFFICE_PPTX_ORIGINAL_ARCHIVE_KEY]: 'ppt-archive-1' },
  };
}

describe('OutcomePptxService GenOffice path', () => {
  it('imports slides with stable element anchors', async () => {
    const service = new OutcomePptxService({ engine: 'genoffice' });
    const result = await service.importBufferV2(fixture('01_standard_business.pptx'));
    expect(result.document.pages.length).toBeGreaterThan(0);
    const anchored = result.document.pages.flatMap((page) => page.elements)
      .filter((element) => typeof element.props._genofficeSpIndex === 'number');
    expect(anchored.length).toBeGreaterThan(0);
  });

  it('keeps XML entries unchanged for an untouched imported deck', async () => {
    const source = fixture('01_standard_business.pptx');
    const service = new OutcomePptxService({ engine: 'genoffice' });
    const imported = await service.importBufferV2(source);
    const exported = await new OutcomePptxService({ engine: 'genoffice',
      resolveOriginalArchive: async (id) => id === 'ppt-archive-1' ? source : undefined,
    }).exportManagedDocument(withArchive(imported.document));
    const before = await zipXmlEntries(source);
    const after = await zipXmlEntries(Buffer.from(exported.bytes));
    for (const [name, xml] of before) expect(after.get(name), name).toBe(xml);
  });

  it('applies a text edit through the GenOffice surgical patch path', async () => {
    const source = fixture('05_unicode_cjk_emoji.pptx');
    const service = new OutcomePptxService({ engine: 'genoffice' });
    const imported = await service.importBufferV2(source);
    const target = imported.document.pages.flatMap((page) => page.elements)
      .find((element) => typeof element.props.text === 'string' && element.props.text.trim().length > 0);
    expect(target).toBeDefined();
    const edited: PptDocument = {
      ...withArchive(imported.document),
      pages: imported.document.pages.map((page) => ({
        ...page,
        elements: page.elements.map((element) => element.id === target!.id
          ? { ...element, props: { ...element.props, text: '[METIS P2] edited text' } }
          : element),
      })),
    };
    const exported = await new OutcomePptxService({ engine: 'genoffice',
      resolveOriginalArchive: async () => source,
    }).exportManagedDocument(edited);
    const reparsed = await service.importBufferV2(Buffer.from(exported.bytes));
    const text = reparsed.document.pages.flatMap((page) => page.elements)
      .map((element) => typeof element.props.text === 'string' ? element.props.text : '')
      .join('\n');
    expect(text).toContain('[METIS P2] edited text');
  });

  it('does not silently discard a newly added element', async () => {
    const source = fixture('01_standard_business.pptx');
    const service = new OutcomePptxService({ engine: 'genoffice' });
    const imported = await service.importBufferV2(source);
    const withNew: PptDocument = {
      ...withArchive(imported.document),
      pages: imported.document.pages.map((page, index) => index === 0 ? {
        ...page,
        elements: [...page.elements, { id: 'new-p2-element', type: 'text', x: 1, y: 1, width: 10, height: 2, locked: false, props: { text: 'new' } }],
      } : page),
    };
    const exported = await new OutcomePptxService({ engine: 'genoffice',
      resolveOriginalArchive: async () => source,
    }).exportManagedDocument(withNew);
    const reparsed = await service.importBufferV2(Buffer.from(exported.bytes));
    const text = reparsed.document.pages.flatMap((page) => page.elements)
      .map((element) => typeof element.props.text === 'string' ? element.props.text : '')
      .join('\n');
    expect(text).toContain('new');
  });
});
