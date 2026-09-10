/**
 * DOCX renderer — produces a valid Microsoft Word .docx file (OOXML)
 * using only Node.js built-ins (zlib for ZIP).
 *
 * A .docx file is a ZIP archive containing specific XML parts:
 *
 * - [Content_Types].xml       — declares MIME types for parts
 * - _rels/.rels               — root relationship to document.xml
 * - word/_rels/document.xml.rels — document relationships
 * - word/document.xml         — the main document body
 * - word/styles.xml           — paragraph and character styles
 * - word/footnotes.xml        — footnote definitions (real OOXML footnotes)
 *
 * Supported content:
 * - Title, headings (H1–H3), body paragraphs
 * - Tables (from record fields)
 * - Validated PNG/JPEG/GIF images in word/media with DrawingML relationships
 * - Real OOXML footnotes (from raw-transcript/model-prompt fields)
 * - Bibliography section (from citations scope)
 * - Caption text for figure/table references
 * - Evidence appendix (from evidence scope, styled as appendix)
 * - Section breaks with page size
 * - Artifact provenance table
 */

import type {
  RenderInput,
  RenderResult,
} from './RendererTypes.js';
import type { ResearchExportRecord } from '../ResearchExportBuilder.js';
import {
  SCOPE_TITLES,
  collectScopedRecords,
  escapeXml,
  splitLines,
} from './RendererTypes.js';
import {
  validateResearchImagePayload,
  type ValidatedResearchImage,
} from './ImageSupport.js';
import { ZipWriter } from './ZipWriter.js';

// ── OOXML XML builders ────────────────────────────────────────────

interface PreparedImage extends ValidatedResearchImage {
  source: object;
  relationshipId: string;
  fileName: string;
  caption: string;
  drawingId: number;
  widthEmu: number;
  heightEmu: number;
}

type PreparedImages =
  | { ok: true; images: PreparedImage[]; bySource: Map<object, PreparedImage> }
  | { ok: false; error: string };

const EMU_PER_PIXEL = 9_525;
const MAX_IMAGE_WIDTH_EMU = 6.5 * 914_400;
const MAX_IMAGE_HEIGHT_EMU = 8.5 * 914_400;

function drawingExtent(widthPx: number, heightPx: number): { widthEmu: number; heightEmu: number } {
  const intrinsicWidth = widthPx * EMU_PER_PIXEL;
  const intrinsicHeight = heightPx * EMU_PER_PIXEL;
  const scale = Math.min(
    1,
    MAX_IMAGE_WIDTH_EMU / intrinsicWidth,
    MAX_IMAGE_HEIGHT_EMU / intrinsicHeight,
  );
  return {
    widthEmu: Math.max(1, Math.round(intrinsicWidth * scale)),
    heightEmu: Math.max(1, Math.round(intrinsicHeight * scale)),
  };
}

function prepareImages(input: RenderInput): PreparedImages {
  const images: PreparedImage[] = [];
  const bySource = new Map<object, PreparedImage>();
  for (const { records } of collectScopedRecords(input)) {
    for (const record of records) {
      for (const source of record.images) {
        const validation = validateResearchImagePayload(source);
        if (!validation.ok) return { ok: false, error: validation.reason };
        const ordinal = images.length + 1;
        const extent = drawingExtent(validation.image.widthPx, validation.image.heightPx);
        const image: PreparedImage = {
          ...validation.image,
          source,
          relationshipId: `rId${ordinal + 2}`,
          fileName: `image${ordinal}.${validation.image.extension}`,
          caption: source.caption,
          drawingId: ordinal,
          ...extent,
        };
        images.push(image);
        bySource.set(source, image);
      }
    }
  }
  return { ok: true, images, bySource };
}

function buildContentTypesXml(images: readonly PreparedImage[]): string {
  const defaults = new Map<string, string>();
  for (const image of images) defaults.set(image.extension, image.mediaType);
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '<Default Extension="xml" ContentType="application/xml"/>',
    ...[...defaults.entries()].map(([extension, mediaType]) => (
      `<Default Extension="${extension}" ContentType="${mediaType}"/>`
    )),
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>',
    '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>',
    '<Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/>',
    '</Types>',
  ].join('\n');
}

function buildRootRelsXml(): string {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>',
    '</Relationships>',
  ].join('\n');
}

function buildDocumentRelsXml(images: readonly PreparedImage[]): string {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes" Target="footnotes.xml"/>',
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>',
    ...images.map((image) => (
      `<Relationship Id="${image.relationshipId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${image.fileName}"/>`
    )),
    '</Relationships>',
  ].join('\n');
}

function buildStylesXml(): string {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
    '<w:docDefaults>',
    '<w:rPrDefault><w:rPr>',
    '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri" w:eastAsia="SimSun"/>',
    '<w:sz w:val="22"/>',
    '</w:rPr></w:rPrDefault>',
    '<w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault>',
    '</w:docDefaults>',
    '<w:style w:type="paragraph" w:styleId="Title">',
    '<w:name w:val="Title"/>',
    '<w:pPr><w:spacing w:after="240" w:before="0"/></w:pPr>',
    '<w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:b/><w:sz w:val="40"/></w:rPr>',
    '</w:style>',
    '<w:style w:type="paragraph" w:styleId="Heading1">',
    '<w:name w:val="heading 1"/>',
    '<w:pPr><w:keepNext/><w:spacing w:before="360" w:after="120"/></w:pPr>',
    '<w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:b/><w:sz w:val="28"/></w:rPr>',
    '</w:style>',
    '<w:style w:type="paragraph" w:styleId="Heading2">',
    '<w:name w:val="heading 2"/>',
    '<w:pPr><w:keepNext/><w:spacing w:before="280" w:after="100"/></w:pPr>',
    '<w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:b/><w:sz w:val="24"/></w:rPr>',
    '</w:style>',
    '<w:style w:type="paragraph" w:styleId="Caption">',
    '<w:name w:val="caption"/>',
    '<w:pPr><w:keepNext/></w:pPr>',
    '<w:rPr><w:i/><w:sz w:val="20"/></w:rPr>',
    '</w:style>',
    '<w:style w:type="paragraph" w:styleId="FootnoteText">',
    '<w:name w:val="footnote text"/>',
    '<w:pPr><w:spacing w:after="40"/></w:pPr>',
    '<w:rPr><w:sz w:val="18"/></w:rPr>',
    '</w:style>',
    '<w:style w:type="paragraph" w:styleId="Appendix">',
    '<w:name w:val="appendix"/>',
    '<w:pPr><w:spacing w:before="480" w:after="120"/><w:pageBreakBefore/></w:pPr>',
    '<w:rPr><w:b/><w:sz w:val="28"/></w:rPr>',
    '</w:style>',
    '</w:styles>',
  ].join('\n');
}

// ── Paragraph builders ────────────────────────────────────────────

function paragraph(styleId: string | null, text: string): string {
  const pPr = styleId
    ? `<w:pPr><w:pStyle w:val="${styleId}"/></w:pPr>`
    : '';
  return `<w:p>${pPr}<w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`;
}

/** Paragraph with a footnote reference at the end */
function paragraphWithFootnote(styleId: string | null, text: string, footnoteId: number): string {
  const pPr = styleId
    ? `<w:pPr><w:pStyle w:val="${styleId}"/></w:pPr>`
    : '';
  return `<w:p>${pPr}` +
    `<w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>` +
    `<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr>` +
    `<w:footnoteReference w:id="${footnoteId}"/></w:r>` +
    `</w:p>`;
}

/** Caption paragraph for figures/tables */
function caption(text: string): string {
  return paragraph('Caption', text);
}

function imageDrawing(image: PreparedImage): string {
  const name = escapeXml(image.fileName);
  const description = escapeXml(image.caption);
  return [
    '<w:p><w:r><w:drawing>',
    `<wp:inline distT="0" distB="0" distL="0" distR="0">`,
    `<wp:extent cx="${image.widthEmu}" cy="${image.heightEmu}"/>`,
    `<wp:docPr id="${image.drawingId}" name="${name}" descr="${description}"/>`,
    '<a:graphic>',
    '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">',
    '<pic:pic>',
    `<pic:nvPicPr><pic:cNvPr id="${image.drawingId}" name="${name}" descr="${description}"/><pic:cNvPicPr/></pic:nvPicPr>`,
    `<pic:blipFill><a:blip r:embed="${image.relationshipId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>`,
    '<pic:spPr>',
    `<a:xfrm><a:off x="0" y="0"/><a:ext cx="${image.widthEmu}" cy="${image.heightEmu}"/></a:xfrm>`,
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>',
    '</pic:spPr>',
    '</pic:pic>',
    '</a:graphicData>',
    '</a:graphic>',
    '</wp:inline>',
    '</w:drawing></w:r></w:p>',
  ].join('');
}

function appendRecordImages(
  parts: string[],
  record: ResearchExportRecord,
  imageBySource: ReadonlyMap<object, PreparedImage>,
): void {
  for (const source of record.images) {
    const image = imageBySource.get(source);
    if (!image) throw new Error('Validated DOCX image mapping is unavailable');
    parts.push(imageDrawing(image));
    parts.push(caption(image.caption));
  }
}

function tableRow(cells: string[], header: boolean): string {
  const cellXml = cells
    .map((cell) => {
      const rPr = header ? '<w:rPr><w:b/></w:rPr>' : '';
      return `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/></w:tcPr>` +
        `<w:p><w:r>${rPr}<w:t xml:space="preserve">${escapeXml(cell)}</w:t></w:r></w:p></w:tc>`;
    })
    .join('');
  return `<w:tr>${cellXml}</w:tr>`;
}

function table(headers: string[], rows: string[][]): string {
  const headerRow = tableRow(headers, true);
  const dataRows = rows.map((row) => tableRow(row, false)).join('');
  const borders = [
    '<w:tblPr>',
    '<w:tblW w:w="0" w:type="auto"/>',
    '<w:tblBorders>',
    '<w:top w:val="single" w:sz="4" w:space="0" w:color="CCCCCC"/>',
    '<w:left w:val="single" w:sz="4" w:space="0" w:color="CCCCCC"/>',
    '<w:bottom w:val="single" w:sz="4" w:space="0" w:color="CCCCCC"/>',
    '<w:right w:val="single" w:sz="4" w:space="0" w:color="CCCCCC"/>',
    '<w:insideH w:val="single" w:sz="4" w:space="0" w:color="CCCCCC"/>',
    '<w:insideV w:val="single" w:sz="4" w:space="0" w:color="CCCCCC"/>',
    '</w:tblBorders>',
    '</w:tblPr>',
  ].join('');
  return `<w:tbl>${borders}${headerRow}${dataRows}</w:tbl>`;
}

// ── Footnotes XML ─────────────────────────────────────────────────

interface FootnoteEntry {
  id: number;
  text: string;
}

function buildFootnotesXml(footnotes: FootnoteEntry[]): string {
  const parts: string[] = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
  ];

  // Required separator footnote (id 0) and continuation (id -1)
  parts.push(
    '<w:footnote w:type="separator" w:id="-1">' +
    '<w:p><w:r><w:separator/></w:r></w:p></w:footnote>',
  );
  parts.push(
    '<w:footnote w:type="continuationSeparator" w:id="0">' +
    '<w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>',
  );

  for (const fn of footnotes) {
    parts.push(
      `<w:footnote w:id="${fn.id}">` +
      `<w:p><w:pPr><w:pStyle w:val="FootnoteText"/></w:pPr>` +
      `<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr>` +
      `<w:footnoteRef/></w:r>` +
      `<w:r><w:t xml:space="preserve"> ${escapeXml(fn.text)}</w:t></w:r>` +
      `</w:p></w:footnote>`,
    );
  }

  parts.push('</w:footnotes>');
  return parts.join('\n');
}

// ── Document XML ──────────────────────────────────────────────────

function buildDocumentXml(
  input: RenderInput,
  imageBySource: ReadonlyMap<object, PreparedImage>,
): { document: string; footnotes: FootnoteEntry[] } {
  const { request } = input;
  const scoped = collectScopedRecords(input);
  const parts: string[] = [];
  const footnotes: FootnoteEntry[] = [];
  let footnoteIdCounter = 1;

  parts.push('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>');
  parts.push(
    '<w:document'
    + ' xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
    + ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
    + ' xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"'
    + ' xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'
    + ' xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"'
    + '>',
  );
  parts.push('<w:body>');

  // Title
  parts.push(paragraph('Title', request.displayName));

  // Table of Contents (static)
  let hasSections = false;
  for (const { records } of scoped) {
    if (records.length > 0) { hasSections = true; break; }
  }
  if (hasSections) {
    parts.push(paragraph('Heading1', 'Table of Contents'));
    for (const { scope, records } of scoped) {
      if (records.length === 0) continue;
      parts.push(paragraph(null, `- ${SCOPE_TITLES[scope]}`));
    }
  }

  // Body sections — separate evidence/citations as appendix
  for (const { scope, records } of scoped) {
    if (scope === 'evidence' || scope === 'citations') continue;

    const isAppendix = scope === 'audit';
    parts.push(paragraph(isAppendix ? 'Appendix' : 'Heading1', SCOPE_TITLES[scope]));

    for (const record of records) {
      parts.push(paragraph('Heading2', record.title));

      // Body paragraphs — check for footnote-worthy fields
      const fnFields = record.fields.filter(
        (f) => f.sensitivity === 'raw-transcript' || f.sensitivity === 'model-prompt',
      );
      const hasFootnote = fnFields.length > 0 && footnoteIdCounter < 100;

      for (const line of splitLines(record.content)) {
        const trimmed = line.trim();
        if (trimmed.length > 0) {
          // Add footnote reference on the last paragraph if applicable
          if (hasFootnote && trimmed === splitLines(record.content).map((l) => l.trim()).filter(Boolean).pop()) {
            const fnText = fnFields[0]!.value.slice(0, 500);
            footnotes.push({ id: footnoteIdCounter, text: fnText });
            parts.push(paragraphWithFootnote(null, trimmed, footnoteIdCounter));
            footnoteIdCounter++;
          } else {
            parts.push(paragraph(null, trimmed));
          }
        }
      }

      appendRecordImages(parts, record, imageBySource);

      // Figure/table captions
      const captionFields = record.fields.filter(
        (f) => /caption|说明|标题/iu.test(f.key),
      );
      for (const capField of captionFields) {
        parts.push(caption(capField.value));
      }

      // Fields as table (excluding caption fields already rendered)
      const tableFields = record.fields.filter(
        (f) => !/caption|说明|标题/iu.test(f.key)
          && f.sensitivity !== 'raw-transcript'
          && f.sensitivity !== 'model-prompt',
      );
      if (tableFields.length > 0) {
        parts.push(table(
          ['Field', 'Value'],
          tableFields.map((f) => [f.key, f.value]),
        ));
      }
    }
  }

  // ── Citations as Bibliography section ──────────────────────────
  const citationRecords = scoped.find((s) => s.scope === 'citations')?.records ?? [];
  if (citationRecords.length > 0) {
    parts.push(paragraph('Heading1', 'Bibliography'));
    parts.push('<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr></w:p>');
    const bibRows = citationRecords.map((r) => [r.id, r.content]);
    parts.push(table(['Citation ID', 'Reference'], bibRows));
    for (const record of citationRecords) appendRecordImages(parts, record, imageBySource);
  }

  // ── Evidence as Appendix ───────────────────────────────────────
  const evidenceRecords = scoped.find((s) => s.scope === 'evidence')?.records ?? [];
  if (evidenceRecords.length > 0) {
    parts.push(paragraph('Appendix', 'Evidence Appendix'));
    for (const record of evidenceRecords) {
      parts.push(paragraph('Heading2', record.title));
      for (const line of splitLines(record.content)) {
        const trimmed = line.trim();
        if (trimmed.length > 0) parts.push(paragraph(null, trimmed));
      }
      appendRecordImages(parts, record, imageBySource);
      if (record.fields.length > 0) {
        parts.push(table(
          ['Field', 'Value'],
          record.fields.map((f) => [f.key, f.value]),
        ));
      }
    }
  }

  // ── Provenance footer ──────────────────────────────────────────
  parts.push(paragraph('Appendix', 'Artifact Provenance'));
  parts.push(table(
    ['Property', 'Value'],
    [
      ['Export ID', request.exportId],
      ['Project ID', request.projectId],
      ['Format', 'docx'],
      ['Privacy Profile', request.privacyProfile],
      ['Requested At', new Date(request.requestedAt).toISOString()],
      ['Schema Version', '2'],
      ['Artifact ID', request.artifactId],
      ['Artifact Version', String(request.artifactVersion)],
      ['Artifact Manifest SHA-256', request.artifactManifestDigest],
      ['Footnote Count', String(footnotes.length)],
    ],
  ));

  // Section properties
  parts.push(
    '<w:sectPr>',
    '<w:pgSz w:w="12240" w:h="15840"/>',
    '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/>',
    '</w:sectPr>',
  );

  parts.push('</w:body>');
  parts.push('</w:document>');

  return { document: parts.join('\n'), footnotes };
}

export function renderDocx(input: RenderInput): RenderResult {
  try {
    const prepared = prepareImages(input);
    if (!prepared.ok) return { ok: false, error: prepared.error };
    const { document: documentXml, footnotes } = buildDocumentXml(input, prepared.bySource);
    const stylesXml = buildStylesXml();
    const contentTypesXml = buildContentTypesXml(prepared.images);
    const rootRelsXml = buildRootRelsXml();
    const documentRelsXml = buildDocumentRelsXml(prepared.images);
    const footnotesXml = buildFootnotesXml(footnotes);

    const zip = new ZipWriter();
    zip.addFile('[Content_Types].xml', Buffer.from(contentTypesXml, 'utf8'));
    zip.addFile('_rels/.rels', Buffer.from(rootRelsXml, 'utf8'));
    zip.addFile('word/document.xml', Buffer.from(documentXml, 'utf8'));
    zip.addFile('word/styles.xml', Buffer.from(stylesXml, 'utf8'));
    zip.addFile('word/footnotes.xml', Buffer.from(footnotesXml, 'utf8'));
    zip.addFile('word/_rels/document.xml.rels', Buffer.from(documentRelsXml, 'utf8'));
    for (const image of prepared.images) {
      zip.addFile(`word/media/${image.fileName}`, image.bytes);
    }

    const bytes = zip.toBuffer();

    // Fail-closed: require both the local header and the ZIP end-of-central-directory.
    if (
      bytes.length < 22
      || bytes.readUInt32LE(0) !== 0x04034b50
      || bytes.readUInt32LE(bytes.length - 22) !== 0x06054b50
    ) {
      return { ok: false, error: 'DOCX ZIP structure check failed' };
    }

    return {
      ok: true,
      bytes,
      mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      extension: '.docx',
    };
  } catch (err) {
    return {
      ok: false,
      error: `DOCX rendering failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
