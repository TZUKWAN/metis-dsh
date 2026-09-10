import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { parseWordTemplateStyle } from '../../electron/WordTemplateStyleParser.js';

const W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

async function buildDocx(parts: Record<string, string>): Promise<Buffer> {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(parts)) zip.file(name, content);
  return zip.generateAsync({ type: 'nodebuffer' }) as Promise<Buffer>;
}

function stylesXml(extraStyles = ''): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles ${W_NS}>`
    + '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Aptos" w:eastAsia="等线"/><w:sz w:val="20"/></w:rPr></w:rPrDefault></w:docDefaults>'
    + '<w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/>'
    + '<w:pPr><w:spacing w:line="360" w:lineRule="auto"/><w:ind w:firstLine="480"/></w:pPr>'
    + '<w:rPr><w:rFonts w:eastAsia="宋体"/><w:sz w:val="24"/></w:rPr></w:style>'
    + '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/>'
    + '<w:pPr><w:jc w:val="center"/><w:spacing w:before="240" w:after="120"/></w:pPr>'
    + '<w:rPr><w:rFonts w:eastAsia="黑体"/><w:sz w:val="32"/><w:b/></w:rPr></w:style>'
    + extraStyles
    + '</w:styles>';
}

function documentXml(sectPr = '<w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1701" w:bottom="1440" w:left="1701" w:header="720" w:footer="720" w:gutter="0"/>'): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W_NS}><w:body>`
    + '<w:p><w:r><w:t>正文第一段，用于直接格式抽样。</w:t></w:r></w:p>'
    + `<w:sectPr>${sectPr}</w:sectPr>`
    + '</w:body></w:document>';
}

describe('parseWordTemplateStyle', () => {
  it('maps docDefaults → Normal → Heading hierarchy, page size and margins', async () => {
    const archive = await buildDocx({ 'word/styles.xml': stylesXml(), 'word/document.xml': documentXml() });
    const result = parseWordTemplateStyle(archive);

    expect(result.config.body).toMatchObject({
      fontFamily: '宋体',
      fontSizePt: 12,
      lineSpacing: 1.5,
      firstLineIndentChars: 2,
    });
    expect(result.config.headings?.[1]).toMatchObject({
      fontFamily: '黑体',
      fontSizePt: 16,
      align: 'center',
      spaceBeforePt: 12,
      spaceAfterPt: 6,
    });
    expect(result.config.page).toMatchObject({ paper: 'A4', marginTopCm: 2.54, marginLeftCm: 3 });
    expect(result.recognized.some((rule) => rule.includes('1 级标题'))).toBe(true);
    expect(result.recognized.some((rule) => rule.includes('页边距'))).toBe(true);
    expect(result.recognized.some((rule) => rule.includes('纸张：A4'))).toBe(true);
  });

  // Word 默认页边距恰为 1 英寸（1440 twip）；模板没写 pgMar 时不应猜值。
  it('leaves margins unset when the template has no pgMar', async () => {
    const archive = await buildDocx({
      'word/styles.xml': stylesXml(),
      'word/document.xml': documentXml('<w:pgSz w:w="11906" w:h="16838"/>'),
    });
    const result = parseWordTemplateStyle(archive);
    expect(result.config.page?.paper).toBe('A4');
    expect(result.config.page?.marginTopCm).toBeUndefined();
  });

  it('reports custom paper sizes as unmigrated instead of guessing A4', async () => {
    const archive = await buildDocx({
      'word/styles.xml': stylesXml(),
      'word/document.xml': documentXml('<w:pgSz w:w="20000" w:h="25000"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/>'),
    });
    const result = parseWordTemplateStyle(archive);
    expect(result.config.page?.paper).toBeUndefined();
    expect(result.unrecognized.some((item) => item.includes('自定义纸张'))).toBe(true);
    expect(result.config.page?.marginTopCm).toBe(2.54);
  });

  it('reports headers and footers as intentionally unmigrated', async () => {
    const archive = await buildDocx({
      'word/styles.xml': stylesXml(),
      'word/document.xml': documentXml(),
      'word/header1.xml': '<?xml version="1.0"?><w:hdr xmlns:w="x"><w:p><w:r><w:t>某某大学</w:t></w:r></w:p></w:hdr>',
    });
    const result = parseWordTemplateStyle(archive);
    expect(result.unrecognized.some((item) => item.includes('页眉'))).toBe(true);
    expect(result.config.body).toBeDefined();
  });

  it('keeps working when the template has no styles.xml at all', async () => {
    const archive = await buildDocx({ 'word/document.xml': documentXml() });
    const result = parseWordTemplateStyle(archive);
    expect(result.config.body).toBeUndefined();
    expect(result.config.page?.paper).toBe('A4');
  });

  it('rejects non-docx payloads with a structural error', async () => {
    expect(() => parseWordTemplateStyle(Buffer.from('not a zip file'))).toThrow();
  });
});
