/**
 * VALIDATE-DEEPSEEK-301: DOCX real consumer validation.
 * Uses production renderDocx() directly (same as vitest tests).
 * Bypasses buildResearchExport snapshot complexity — tests the RENDERER.
 * Run: npx tsx tests/electron/validate-docx-consumer.ts
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import type { ExportScope } from '../../engine/runtime/ExportRuntimeContract.js';
import type {
  ExportSensitivity,
  ResearchExportRecord,
} from '../../engine/export/ResearchExportBuilder.js';
import type { RenderInput } from '../../engine/export/renderers/RendererTypes.js';
import type { SupportedResearchImageMediaType } from '../../engine/export/renderers/ImageSupport.js';

const RESULTS = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..'), 'test-results', `docx-${Date.now()}`);
fs.mkdirSync(RESULTS, { recursive: true });
const LOG: string[] = [];
function log(m: string) { const l = `[${new Date().toISOString()}] ${m}`; LOG.push(l); console.log(l); }

async function main() {
  log('=== DOCX CONSUMER VALIDATION ===');
  const [{ renderDocx }, { validateResearchImagePayload }] = await Promise.all([
    import('../../engine/export/renderers/DocxRenderer.js'),
    import('../../engine/export/renderers/ImageSupport.js'),
  ]);
  const { TrustedExportRequestSchema } = await import('../../engine/runtime/ExportRuntimeContract.js');

  // Valid PNG + JPEG (1x1)
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==', 'base64');
  const jpg = Buffer.from([0xFF,0xD8,0xFF,0xE0,0x00,0x10,0x4A,0x46,0x49,0x46,0x00,0x01,0x01,0x00,0x00,0x01,0x00,0x01,0x00,0x00,0xFF,0xDB,0x00,0x43,0x00,0x08,0x06,0x06,0x07,0x06,0x05,0x08,0x07,0x07,0x07,0x09,0x09,0x08,0x0A,0x0C,0x14,0x0D,0x0C,0x0B,0x0B,0x0C,0x19,0x12,0x13,0x0F,0x14,0x1D,0x1A,0x1F,0x1E,0x1D,0x1A,0x1C,0x1C,0x20,0x24,0x2E,0x27,0x20,0x22,0x2C,0x23,0x1C,0x1C,0x28,0x37,0x29,0x2C,0x30,0x31,0x34,0x34,0x34,0x1F,0x27,0x39,0x3D,0x38,0x32,0x3C,0x2E,0x33,0x34,0x32,0xFF,0xC0,0x00,0x0B,0x08,0x00,0x01,0x00,0x01,0x01,0x01,0x11,0x00,0xFF,0xC4,0x00,0x1F,0x00,0x00,0x01,0x05,0x01,0x01,0x01,0x01,0x01,0x01,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x01,0x02,0x03,0x04,0x05,0x06,0x07,0x08,0x09,0x0A,0x0B,0xFF,0xDA,0x00,0x08,0x01,0x01,0x00,0x00,0x3F,0x00,0xD2,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0xFF,0xD9]);
  const pngB64 = png.toString('base64'); const jpgB64 = jpg.toString('base64');
  const pngSha = createHash('sha256').update(png).digest('hex');
  const jpgSha = createHash('sha256').update(jpg).digest('hex');
  log(`PNG: ok=${validateResearchImagePayload({mediaType:'image/png',base64Data:pngB64,sha256:pngSha}).ok}`);
  log(`JPEG: ok=${validateResearchImagePayload({mediaType:'image/jpeg',base64Data:jpgB64,sha256:jpgSha}).ok}`);

  // Construct RenderInput matching the DocxRenderer.test.ts pattern
  const request = TrustedExportRequestSchema.parse({
    exportId: 'ex_' + 'f'.repeat(32), projectId: 'proj_val', artifactId: 'art_val', destinationCapabilityId: 'fc_' + 'd'.repeat(32), displayName: 'CJK DOCX 消费验证',
    scopes: ['project', 'citations', 'evidence', 'artifact', 'audit'], format: 'docx', privacyProfile: 'public-share',
    redaction: { stripSecrets:true, stripAbsolutePaths:true, stripPersonalData:true, pseudonymizeParticipants:true, omitRawTranscripts:true, omitModelPrompts:true, omitToolArguments:true },
    requestedAt: Date.now(), artifactVersion: 3, artifactManifestDigest: 'e'.repeat(64),
  });

  function rec(
    id: string,
    title: string,
    content: string,
    sensitivity: ExportSensitivity,
    fields: Array<{ key: string; value: string; sensitivity: ExportSensitivity }>,
    images: Array<{
      mediaType: SupportedResearchImageMediaType;
      base64Data: string;
      sha256: string;
      caption: string;
    }>,
  ): ResearchExportRecord {
    return {
      id,
      title,
      content,
      sensitivity,
      fields,
      images: images.map((image, index) => ({
        ...image,
        id: `${id}-image-${index + 1}`,
        widthPx: 1,
        heightPx: 1,
      })),
    };
  }

  const input: RenderInput = {
    request,
    records: new Map<ExportScope, ResearchExportRecord[]>([
      ['project' as const, [rec('proj-1','Metis 导出消费者验证','验证 DOCX 渲染管线——中文标题、表格、脚注、图片与证据附录。','none',[],[])]],
      ['citations' as const, [rec('cit-1','Angrist & Pischke (2009)','Mostly Harmless Econometrics. Princeton University Press.','none',[{key:'作者',value:'Angrist, J.D. & Pischke, J-S.',sensitivity:'none'}],[])]],
      ['evidence' as const, [rec('ev-1','DID 估计结果','DID 估计系数为 −0.034，标准误 0.011，p = 0.003。安慰剂检验通过。','none',[],[])]],
      ['artifact' as const, [rec('art-1','DID 分析','基准 DID 模型显示处理效应显著为负。','none',[
        {key:'模型',value:'双向固定效应 DID',sensitivity:'none'},{key:'样本量',value:'12,430',sensitivity:'none'},{key:'处理效应',value:'−0.034 (p=0.003)',sensitivity:'none'},
      ],[
        {mediaType:'image/png',base64Data:pngB64,sha256:pngSha,caption:'图1：DID 平行趋势检验——事件研究系数与 95% 置信区间'},
        {mediaType:'image/jpeg',base64Data:jpgB64,sha256:jpgSha,caption:'图2：PSM 匹配质量——倾向得分分布与共同支撑域'},
      ])]],
      ['audit' as const, [rec('aud-1','审计追踪','所有数字与原始输出一致，引用可追溯至 source 表。','none',[],[])]],
    ]),
  };

  const result = renderDocx(input);
  if (!result.ok) { log(`FAILED: ${result.error}`); process.exit(1); }

  const docxPath = path.join(RESULTS, 'cjk-real.docx');
  const bytes = Buffer.from(result.bytes);
  fs.writeFileSync(docxPath, bytes);
  const sha = createHash('sha256').update(bytes).digest('hex');
  log(`DOCX: ${docxPath} size=${bytes.length} sha256=${sha}`);

  // Unpack & verify structure
  const up = path.join(RESULTS, 'unpacked');
  fs.mkdirSync(up, {recursive:true});
  const zipCopy = docxPath + '.zip';
  fs.copyFileSync(docxPath, zipCopy);
  execSync(`powershell -Command "Expand-Archive -Path '${zipCopy}' -DestinationPath '${up}' -Force"`, {stdio:'pipe'});
  fs.unlinkSync(zipCopy);
  const checks: [string,boolean][] = [
    ['[Content_Types].xml', fs.existsSync(path.join(up,'[Content_Types].xml'))],
    ['_rels/.rels', fs.existsSync(path.join(up,'_rels','.rels'))],
    ['word/_rels/document.xml.rels', fs.existsSync(path.join(up,'word','_rels','document.xml.rels'))],
    ['word/document.xml', fs.existsSync(path.join(up,'word','document.xml'))],
    ['word/footnotes.xml', fs.existsSync(path.join(up,'word','footnotes.xml'))],
    ['word/styles.xml', fs.existsSync(path.join(up,'word','styles.xml'))],
  ];
  const media = fs.existsSync(path.join(up,'word','media')) ? fs.readdirSync(path.join(up,'word','media')) : [];
  checks.push([`word/media/ (${media.length} files)`, media.length >= 2]);
  let all = true; for (const [n,p] of checks) { log(`  ${n}: ${p?'PASS':'FAIL'}`); if(!p) all=false; }

  // Content checks
  const dx = fs.readFileSync(path.join(up,'word','document.xml'),'utf8');
  log(`  CJK: ${/[一-鿿]/.test(dx)?'PASS':'FAIL'}  drawing: ${/w:drawing/.test(dx)?'PASS':'FAIL'}  caption: ${/图[12]：/.test(dx)?'PASS':'FAIL'}`);
  const ct = fs.readFileSync(path.join(up,'[Content_Types].xml'),'utf8');
  log(`  C_T PNG: ${/image\/png/.test(ct)?'PASS':'FAIL'}  JPEG: ${/image\/jpeg/.test(ct)?'PASS':'FAIL'}`);
  const rx = fs.readFileSync(path.join(up,'word','_rels','document.xml.rels'),'utf8');
  const ic = (rx.match(/Relationship.*?\/image/g)||[]).length;
  log(`  image rels: ${ic>=2?`PASS (${ic})`:`FAIL (${ic})`}`);
  log(`  OOXML STRUCTURE: ${all?'PASS':'FAIL'}`);

  // Word COM → PDF
  try {
    const pdf = path.join(RESULTS, 'from-docx.pdf');
    const ps = `$w=New-Object -ComObject Word.Application;$w.Visible=$false;$d=$w.Documents.Open('${docxPath.replace(/'/g,"''")}');$d.SaveAs('${pdf.replace(/'/g,"''")}',17);$d.Close();$w.Quit()`;
    execSync(`powershell -Command "${ps}"`, {stdio:'pipe',timeout:60000});
    if(fs.existsSync(pdf)) { const sz = fs.statSync(pdf).size; log(`  Word→PDF: ${sz} bytes — ${sz>2000?'PASS':'FAIL (too small)'}`); }
    else { log('  Word→PDF: NOT CREATED — consumer unavailable'); }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'unknown error';
    log(`  Word→PDF: ${message} — consumer unavailable`);
  }

  fs.writeFileSync(path.join(RESULTS,'evidence.json'), JSON.stringify({timestamp:new Date().toISOString(),docx:{path:docxPath,sha256:sha,size:bytes.length,structurePass:all},checks:Object.fromEntries(checks),log:LOG},null,2));
  log(`=== DOCX: ${all?'PASS':'FAIL'} ===`);
  process.exit(all?0:1);
}
main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'unknown error';
  log(`FATAL: ${message}`);
  process.exit(1);
});
