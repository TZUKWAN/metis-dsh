import { describe, expect, it } from 'vitest';
import { ZipWriter } from '../../engine/export/renderers/ZipWriter.js';
import { OutcomePptxService } from '../../electron/OutcomePptxService.js';
import { OutcomeWordDocxService } from '../../electron/OutcomeWordDocxService.js';

function docxNestedTable(): Buffer {
  const zip = new ZipWriter();
  zip.addFile('word/document.xml', Buffer.from('<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:tbl><w:tr><w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/></w:tcPr><w:p><w:r><w:t>外层文字</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>内层 A</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>内层 B</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:tc></w:tr></w:tbl><w:sectPr/></w:body></w:document>'));
  return zip.toBuffer();
}
function pptxMasterAndTransition(): Buffer {
  const zip = new ZipWriter();
  zip.addFile('ppt/presentation.xml', Buffer.from('<?xml version="1.0"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst><p:sldSz cx="12192000" cy="6858000" type="screen16x9"/></p:presentation>'));
  zip.addFile('ppt/_rels/presentation.xml.rels', Buffer.from('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>'));
  zip.addFile('ppt/slides/slide1.xml', Buffer.from('<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr/><p:grpSpPr/></p:spTree></p:cSld><p:transition spd="fast"/><p:sld/></p:sld>'));
  zip.addFile('ppt/slideMasters/slideMaster1.xml', Buffer.from('<p:sldMaster xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:sp><p:nvSpPr/></p:sp></p:spTree></p:cSld></p:sldMaster>'));
  return zip.toBuffer();
}

describe('Office codec downgrade details', () => {
  it('keeps an outer DOCX table row and cell intact when nested table markup is present', () => {
    const imported = new OutcomeWordDocxService().importBuffer(docxNestedTable());
    const table = imported.document.blocks.find((block) => block.kind === 'table');
    expect(imported.warnings.map((item) => item.code)).toContain('unsupported_table_layout');
    expect(table).toMatchObject({ kind: 'table', rows: [['外层文字内层 A内层 B']] });
  });

  it('reports non-empty master and transition constructs as explicit PPTX downgrade warnings', () => {
    const imported = new OutcomePptxService().importBuffer(pptxMasterAndTransition());
    const codes = imported.warnings.map((item) => item.code);
    expect(codes).toContain('unsupported_animation');
    expect(codes).toContain('unsupported_master');
    expect(imported.document.pages).toHaveLength(1);
  });
});
