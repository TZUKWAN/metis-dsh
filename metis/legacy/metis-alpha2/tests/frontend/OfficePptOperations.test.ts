import { describe, expect, it } from 'vitest';
import type { PptDocument } from '../../engine/runtime/OutcomeRuntimeContract';
import { addPptElement, deletePptPage, duplicatePptPage, pptDocumentStats, setPptElementLayer, updatePptElementProps } from '../../src/components/OfficePptOperations';

const doc: PptDocument = {
  type: 'ppt', ratio: '16:9', theme: {}, templateId: null, generationSkillId: null,
  pages: [{ id: 'slide-1', title: '封面', pageType: 'cover', humanModified: false, status: 'complete', elements: [
    { id: 'text-1', type: 'text', x: 1, y: 1, width: 10, height: 2, locked: false, props: { text: 'Title', zIndex: 1 } },
    { id: 'image-1', type: 'image', x: 2, y: 4, width: 8, height: 6, locked: false, props: { mediaId: 'media-1', zIndex: 2 } },
  ] }],
};

describe('OfficePptOperations', () => {
  it('adds a real editable element to the selected slide', () => {
    const result = addPptElement(doc, 0, 'text');
    expect(result.pages[0]?.elements.at(-1)).toEqual(expect.objectContaining({ type: 'text', locked: false, props: expect.objectContaining({ text: '输入文本' }) }));
    expect(result.pages[0]?.humanModified).toBe(true);
  });

  it('duplicates a slide with fresh page and element ids', () => {
    const result = duplicatePptPage(doc, 0);
    expect(result.pages).toHaveLength(2);
    expect(result.pages[1]?.id).not.toBe(result.pages[0]?.id);
    expect(result.pages[1]?.elements[0]?.id).not.toBe(result.pages[0]?.elements[0]?.id);
    expect(result.pages[1]?.humanModified).toBe(true);
  });

  it('refuses to delete the only slide', () => {
    expect(deletePptPage(doc, 0)).toEqual(doc);
  });

  it('does not mutate a locked element and preserves unknown props', () => {
    const locked = { ...doc, pages: [{ ...doc.pages[0]!, elements: [{ ...doc.pages[0]!.elements[0]!, locked: true, props: { text: 'x', custom: 'keep' } }] }] };
    expect(updatePptElementProps(locked, 0, 'text-1', { text: 'changed' })).toEqual(locked);
    expect(updatePptElementProps(doc, 0, 'text-1', { text: 'changed', custom: 'keep' }).pages[0]?.elements[0]?.props).toEqual({ text: 'changed', zIndex: 1, custom: 'keep' });
  });

  it('moves an element to the front with a deterministic layer value', () => {
    const result = setPptElementLayer(doc, 0, 'text-1', 'front');
    expect(result.pages[0]?.elements[0]?.props.zIndex).toBe(3);
  });

  it('returns slide and element statistics', () => {
    expect(pptDocumentStats(doc)).toEqual({ slides: 1, elements: 2, text: 1, images: 1, charts: 0 });
  });
});
