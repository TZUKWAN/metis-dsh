import { describe, expect, it } from 'vitest';
import { extractSlideImages } from '../../electron/OutcomePptxService.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);

function slideWithPic(embedId: string): string {
  return '<p:sld><p:cSld><p:spTree><p:pic><p:nvPicPr><p:cNvPr id="2" name="Picture 1"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="' + embedId + '"/><a:stretch><a:fillRect/></a:stretch></p:blipFill></p:pic></p:spTree></p:cSld></p:sld>';
}

const RELS_PREFIX = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">';
const RELS_SUFFIX = '</Relationships>';

describe('extractSlideImages (PPTX reverse image import)', () => {
  it('extracts a verified PNG image referenced by a slide pic', () => {
    const entries = new Map<string, Buffer>([
      ['ppt/slides/slide1.xml', Buffer.from(slideWithPic('rId2'))],
      ['ppt/slides/_rels/slide1.xml.rels', Buffer.from(RELS_PREFIX + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/>' + RELS_SUFFIX)],
      ['ppt/media/image1.png', PNG],
    ]);
    const found = extractSlideImages(entries, 'ppt/slides/slide1.xml', slideWithPic('rId2'));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ elementOrder: 1, mediaPath: 'ppt/media/image1.png', mediaType: 'image/png' });
    expect(found[0]!.bytes.equals(PNG)).toBe(true);
  });

  it('extracts a verified safe SVG image', () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1"/></svg>');
    const entries = new Map<string, Buffer>([
      ['ppt/slides/slide3.xml', Buffer.from(slideWithPic('rId4'))],
      ['ppt/slides/_rels/slide3.xml.rels', Buffer.from(RELS_PREFIX + '<Relationship Id="rId4" Target="../media/vector.svg"/>' + RELS_SUFFIX)],
      ['ppt/media/vector.svg', svg],
    ]);
    const found = extractSlideImages(entries, 'ppt/slides/slide3.xml', slideWithPic('rId4'));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ mediaType: 'image/svg+xml', displayName: 'vector.svg' });
    expect(found[0]!.bytes).toEqual(svg);
  });

  it('rejects an unsafe SVG media part', () => {
    const entries = new Map<string, Buffer>([
      ['ppt/slides/slide4.xml', Buffer.from(slideWithPic('rId5'))],
      ['ppt/slides/_rels/slide4.xml.rels', Buffer.from(RELS_PREFIX + '<Relationship Id="rId5" Target="../media/unsafe.svg"/>' + RELS_SUFFIX)],
      ['ppt/media/unsafe.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><script>alert(1)</script></svg>')],
    ]);
    expect(extractSlideImages(entries, 'ppt/slides/slide4.xml', slideWithPic('rId5'))).toHaveLength(0);
  });

  it('extracts a verified JPEG image', () => {
    const entries = new Map<string, Buffer>([
      ['ppt/slides/slide2.xml', Buffer.from(slideWithPic('rId3'))],
      ['ppt/slides/_rels/slide2.xml.rels', Buffer.from(RELS_PREFIX + '<Relationship Id="rId3" Target="../media/photo.jpeg"/>' + RELS_SUFFIX)],
      ['ppt/media/photo.jpeg', JPEG],
    ]);
    const found = extractSlideImages(entries, 'ppt/slides/slide2.xml', slideWithPic('rId3'));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ mediaType: 'image/jpeg' });
  });

  it('rejects a media file whose magic bytes do not match its extension', () => {
    const bad = Buffer.from([0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77]);
    const entries = new Map<string, Buffer>([
      ['ppt/slides/slide1.xml', Buffer.from(slideWithPic('rId2'))],
      ['ppt/slides/_rels/slide1.xml.rels', Buffer.from(RELS_PREFIX + '<Relationship Id="rId2" Target="../media/image1.png"/>' + RELS_SUFFIX)],
      ['ppt/media/image1.png', bad],
    ]);
    const found = extractSlideImages(entries, 'ppt/slides/slide1.xml', slideWithPic('rId2'));
    expect(found).toHaveLength(0);
  });

  it('returns an empty list when the pic has no blip binding or media part is absent', () => {
    const noEmbed = slideWithPic('rIdMissing');
    const entries = new Map<string, Buffer>([
      ['ppt/slides/slide1.xml', Buffer.from(noEmbed)],
      ['ppt/slides/_rels/slide1.xml.rels', Buffer.from(RELS_PREFIX + '<Relationship Id="rId2" Target="../media/image1.png"/>' + RELS_SUFFIX)],
    ]);
    const found = extractSlideImages(entries, 'ppt/slides/slide1.xml', noEmbed);
    expect(found).toHaveLength(0);
  });
});
