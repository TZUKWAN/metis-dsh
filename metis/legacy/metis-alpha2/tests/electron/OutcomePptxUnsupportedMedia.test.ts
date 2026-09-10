import { describe, expect, it } from 'vitest';
import { ZipWriter } from '../../engine/export/renderers/ZipWriter.js';
import type { PptDocument } from '../../engine/runtime/OutcomeRuntimeContract.js';
import { OutcomePptxService } from '../../electron/OutcomePptxService.js';

const MEDIA = {
  gif: Buffer.from('GIF89a-unsupported-test'),
  webp: Buffer.from('RIFF----WEBP-unsupported-test'),
  svg: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
};
function fixture(extension: keyof typeof MEDIA): Buffer {
  const zip = new ZipWriter();
  zip.addFile('ppt/presentation.xml', Buffer.from('<?xml version="1.0"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst><p:sldSz cx="12192000" cy="6858000" type="screen16x9"/></p:presentation>'));
  zip.addFile('ppt/_rels/presentation.xml.rels', Buffer.from('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>'));
  zip.addFile('ppt/slides/_rels/slide1.xml.rels', Buffer.from(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.${extension}"/></Relationships>`));
  zip.addFile('ppt/slides/slide1.xml', Buffer.from('<?xml version="1.0"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:cSld><p:spTree><p:nvGrpSpPr/><p:grpSpPr/><p:pic><p:nvPicPr><p:cNvPr id="2" name="unsupported"/></p:nvPicPr><p:blipFill><a:blip r:embed="rId1"/></p:blipFill><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="2000000" cy="2000000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic></p:spTree></p:cSld></p:sld>'));
  zip.addFile(`ppt/media/image1.${extension}`, MEDIA[extension]);
  return zip.toBuffer();
}

const unsupportedDocument = (mediaType: 'image/gif' | 'image/webp' | 'image/svg+xml'): PptDocument => ({
  type: 'ppt', ratio: '16:9', theme: {}, templateId: null, generationSkillId: null,
  pages: [{ id: 'slide-1', title: '不支持媒体', pageType: 'content', humanModified: false, status: 'complete', elements: [{ id: 'image-1', type: 'image', x: 1, y: 1, width: 5, height: 4, locked: false, props: { mediaId: 'media-1', mediaType, displayName: 'unsupported-image' } }] }],
});

describe('OutcomePptxService unsupported media', () => {
  it.each([['gif', 'image/gif'], ['webp', 'image/webp'], ['svg', 'image/svg+xml']] as const)('identifies %s media and reports unsupported_media without fabricating extraction', (extension, mediaType) => {
    const imported = new OutcomePptxService().importBuffer(fixture(extension));
    expect(imported.warnings).toContainEqual({ code: 'unsupported_media', message: `${mediaType} 图片当前不能安全写入 Outcomes 媒体库，已保留为可见占位。` });
    expect(imported.document.pages[0]?.elements[0]?.props).not.toHaveProperty('extractedImage');
  });

  it.each([['image/gif', 'image/gif'], ['image/webp', 'image/webp'], ['image/svg+xml', 'image/svg+xml']] as const)('exports %s as a visible placeholder with an explicit downgrade', (mediaType, expectedType) => {
    const exported = new OutcomePptxService({ resolveManagedImage: async () => undefined }).exportDocument(unsupportedDocument(mediaType));
    expect(exported.warnings).toContainEqual({ code: 'unsupported_media', message: `${expectedType} 图片当前不能安全写入 Outcomes 媒体库，已保留为可见占位。` });
    expect(exported.bytes.toString('utf8')).not.toContain('ppt/media/');
  });
});
