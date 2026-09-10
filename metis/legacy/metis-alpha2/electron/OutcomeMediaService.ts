/** Managed PDF/image files for project-scoped Outcomes. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { OutcomeMedia } from '../engine/runtime/OutcomeRuntimeContract.js';
import { exportStandaloneSvg, roundTripStandaloneSvg } from './OutcomeSvgSecurity.js';

const MAX_BYTES = 20 * 1024 * 1024;
type MediaRow = { id:string; project_id:string; outcome_id:string; media_type:OutcomeMedia['mediaType']; display_name:string; stored_name:string; byte_length:number; sha256:string; created_at:number };
export type OutcomePptxManagedImageReference = { mediaId: string; mediaType: 'image/png' | 'image/jpeg' | 'image/svg+xml'; displayName: string };
export type OutcomePptxManagedImage = OutcomePptxManagedImageReference & { bytes: Buffer };
export type OutcomeWordDocxManagedImageReference = { mediaId: string; mediaType?: 'image/png' | 'image/jpeg'; displayName?: string };
export type OutcomeWordDocxManagedImage = { mediaId: string; mediaType: 'image/png' | 'image/jpeg'; displayName: string; bytes: Buffer };
type OutcomeWordDocxImageMediaType = OutcomeWordDocxManagedImage['mediaType'];
const isWordDocxImageMediaType = (mediaType: OutcomeMedia['mediaType']): mediaType is OutcomeWordDocxImageMediaType => mediaType === 'image/png' || mediaType === 'image/jpeg';
const types: Record<string, OutcomeMedia['mediaType']> = Object.freeze({ '.pdf':'application/pdf', '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.svg':'image/svg+xml', '.xlsx':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.xlsm':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
const OOXML_ZIP_SIGNATURE = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const signatureOk = (bytes: Buffer, type: OutcomeMedia['mediaType']) => type === 'application/pdf' ? bytes.subarray(0,5).equals(Buffer.from('%PDF-')) : type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || type === 'application/vnd.openxmlformats-officedocument.presentationml.presentation' || type === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ? bytes.subarray(0,4).equals(OOXML_ZIP_SIGNATURE) : type === 'image/png' ? bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) : type === 'image/jpeg' ? bytes.subarray(0,3).equals(Buffer.from([255,216,255])) : type === 'image/svg+xml' ? (() => { try { return roundTripStandaloneSvg(exportStandaloneSvg(bytes)).equals(bytes); } catch { return false; } })() : false;
const summary = (row: MediaRow): OutcomeMedia => ({ id:row.id, mediaType:row.media_type, displayName:row.display_name, byteLength:row.byte_length });
const withoutControlCharacters = (value: string): string => Array.from(value)
  .filter((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code > 31 && (code < 127 || code > 159);
  })
  .join('');
const safePathSegment = (value: string): boolean => /^[A-Za-z0-9._-]+$/u.test(value)
  && value !== '.'
  && value !== '..';
const managedPath = (directory: string, storedName: string): string | undefined => safePathSegment(storedName)
  ? path.resolve(directory, storedName)
  : undefined;
export class OutcomeMediaService {
  constructor(private readonly db: Database.Database, private readonly root: string) {}
  private owned(projectId:string,outcomeId:string) { return this.db.prepare('SELECT id FROM outcomes WHERE id=? AND project_id=? AND deleted_at IS NULL').get(outcomeId,projectId) as {id:string}|undefined; }
  private asRow(row: MediaRow|undefined) { return row ? summary(row) : undefined; }
  private projectDirectory(projectId: string): string | undefined {
    if (!safePathSegment(projectId)) return undefined;
    const root = path.resolve(this.root);
    const directory = path.resolve(root, projectId);
    return directory !== root && directory.startsWith(root + path.sep) ? directory : undefined;
  }
  private async existingManagedPath(projectId: string, storedName: string): Promise<string | undefined> {
    const directory = this.projectDirectory(projectId);
    const target = directory ? managedPath(directory, storedName) : undefined;
    if (!directory || !target || !target.startsWith(directory + path.sep)) return undefined;
    try {
      const rootStat = await fs.promises.lstat(path.resolve(this.root));
      const directoryStat = await fs.promises.lstat(directory);
      const targetStat = await fs.promises.lstat(target);
      return rootStat.isDirectory() && !rootStat.isSymbolicLink()
        && directoryStat.isDirectory() && !directoryStat.isSymbolicLink()
        && targetStat.isFile() && !targetStat.isSymbolicLink()
        ? target
        : undefined;
    } catch { return undefined; }
  }
  async importFromDialog(projectId:string,outcomeId:string, sourcePath:string):Promise<OutcomeMedia|undefined> {
    if (!this.owned(projectId,outcomeId)) return undefined;
    const extension=path.extname(sourcePath).toLowerCase(); const mediaType=types[extension]; if(!mediaType) return undefined;
    let bytes:Buffer; try { const stat=await fs.promises.stat(sourcePath); if(!stat.isFile() || stat.size<=0 || stat.size>MAX_BYTES) return undefined; bytes=await fs.promises.readFile(sourcePath); } catch { return undefined; }
    return this.persistBytes(projectId,outcomeId,bytes,mediaType,path.basename(sourcePath),extension);
  }
  /**
   * Persists provider output in the same project/outcome-private storage used
   * by user imports.  Callers receive a durable OutcomeMedia handle instead of
   * a process-local data URL, so the renderer can read it through
   * outcomes:media:read after reload.
   */
  async persistGenerated(projectId:string,outcomeId:string, bytes:Buffer, mediaType:Extract<OutcomeMedia['mediaType'],'image/png'|'image/jpeg'|'image/svg+xml'>, displayName:string):Promise<OutcomeMedia|undefined> {
    const extension=mediaType === 'image/png' ? '.png' : mediaType === 'image/jpeg' ? '.jpg' : '.svg';
    return this.persistBytes(projectId,outcomeId,bytes,mediaType,displayName,extension);
  }
  private async persistBytes(projectId:string,outcomeId:string, bytes:Buffer, mediaType:OutcomeMedia['mediaType'], displayNameInput:string, extension:string):Promise<OutcomeMedia|undefined> {
    if (!this.owned(projectId,outcomeId) || bytes.length===0 || bytes.length>MAX_BYTES || !signatureOk(bytes,mediaType)) return undefined;
    const id='om-'+randomUUID(); const sha256=createHash('sha256').update(bytes).digest('hex'); const displayName=withoutControlCharacters(path.basename(displayNameInput)).slice(0,512); if(!displayName) return undefined;
    const directory = this.projectDirectory(projectId); if (!directory) return undefined;
    const rootPath = path.resolve(this.root);
    try {
      await fs.promises.mkdir(rootPath, { recursive: true });
      const rootStat = await fs.promises.lstat(rootPath);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return undefined;
      await fs.promises.mkdir(directory,{recursive:true});
      const directoryStat = await fs.promises.lstat(directory);
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) return undefined;
    } catch { return undefined; }
    const storedName=sha256+'-'+randomBytes(12).toString('hex')+extension; const target=managedPath(directory,storedName); if(!target) return undefined;
    try { await fs.promises.writeFile(target,bytes,{mode:0o600,flag:'wx'}); } catch { return undefined; }
    const now=Date.now(); try { this.db.prepare('INSERT INTO outcome_media (id,project_id,outcome_id,media_type,display_name,stored_name,byte_length,sha256,created_at) VALUES (?,?,?,?,?,?,?,?,?)').run(id,projectId,outcomeId,mediaType,displayName,storedName,bytes.length,sha256,now); } catch { await fs.promises.unlink(target).catch(()=>undefined); return undefined; }
    return {id,mediaType,displayName,byteLength:bytes.length};
  }
  async readDataUrl(projectId:string,outcomeId:string,mediaId:string):Promise<string|undefined> {
    if(!this.owned(projectId,outcomeId)) return undefined; const row=this.db.prepare('SELECT * FROM outcome_media WHERE id=? AND project_id=? AND outcome_id=?').get(mediaId,projectId,outcomeId) as MediaRow|undefined; if(!row) return undefined;
    const target = await this.existingManagedPath(projectId, row.stored_name); if (!target) return undefined;
    try { const bytes=await fs.promises.readFile(target); if(bytes.length!==row.byte_length || createHash('sha256').update(bytes).digest('hex')!==row.sha256 || !signatureOk(bytes,row.media_type)) return undefined; return 'data:'+row.media_type+';base64,'+bytes.toString('base64'); } catch { return undefined; }
  }
  /** Read one project/outcome-owned document byte stream after integrity checks. */
  async readBytes(projectId: string, outcomeId: string, mediaId: string): Promise<{ bytes: Buffer; mediaType: OutcomeMedia['mediaType']; displayName: string } | undefined> {
    if (!this.owned(projectId, outcomeId) || !mediaId) return undefined;
    const row = this.db.prepare('SELECT * FROM outcome_media WHERE id=? AND project_id=? AND outcome_id=?').get(mediaId, projectId, outcomeId) as MediaRow | undefined;
    if (!row) return undefined;
    const target = await this.existingManagedPath(projectId, row.stored_name);
    if (!target) return undefined;
    try {
      const bytes = await fs.promises.readFile(target);
      if (bytes.length !== row.byte_length || createHash('sha256').update(bytes).digest('hex') !== row.sha256 || !signatureOk(bytes, row.media_type)) return undefined;
      return { bytes, mediaType: row.media_type, displayName: row.display_name };
    } catch { return undefined; }
  }
  /** Remove only freshly-created media handles after a failed import commit. */
  async removeGenerated(projectId:string,outcomeId:string,mediaIds:readonly string[]):Promise<void> {
    if (!this.owned(projectId,outcomeId) || mediaIds.length === 0) return;
    const rows = this.db.prepare(`SELECT id,stored_name FROM outcome_media WHERE project_id = ? AND outcome_id = ? AND id IN (${mediaIds.map(() => '?').join(',')})`).all(projectId, outcomeId, ...mediaIds) as Array<{ id:string; stored_name:string }>;
    const directory = this.projectDirectory(projectId);
    if (!directory) return;
    const candidates = await Promise.all(rows.map(async (row) => ({ row, target: managedPath(directory, row.stored_name), existing: await this.existingManagedPath(projectId, row.stored_name) })));
    const removable = candidates.filter((candidate): candidate is typeof candidate & { target: string; existing: string } => Boolean(candidate.target && candidate.existing));
    this.db.transaction(() => { for (const candidate of removable) this.db.prepare('DELETE FROM outcome_media WHERE id = ? AND project_id = ? AND outcome_id = ?').run(candidate.row.id, projectId, outcomeId); })();
    await Promise.all(removable.map((candidate) => fs.promises.unlink(candidate.existing).catch(() => undefined)));
  }
  /**
   * Unlink managed files by stored_name after an outcome has been permanently
   * deleted from the database.  Best-effort: the DB rows are already gone, so
   * a missing file must never fail the purge.
   */
  async purgeFiles(projectId:string, storedNames:readonly string[]):Promise<void> {
    if (storedNames.length === 0) return;
    const directory = this.projectDirectory(projectId);
    if (!directory) return;
    await Promise.all(storedNames.map(async (storedName) => {
      const target = await this.existingManagedPath(projectId, storedName);
      if (target) await fs.promises.unlink(target).catch(() => undefined);
    }));
  }
  /**
   * Private binary reader for a PPTX export that is already scoped to one
   * project/outcome by the main-process handler.  It deliberately verifies the
   * renderer-held handle against the durable row, rather than trusting props
   * from the editable PptDocument.  Nothing about the managed file path leaks
   * through this API.
   */
  async readImageForPptxExport(projectId:string,outcomeId:string, reference:OutcomePptxManagedImageReference):Promise<OutcomePptxManagedImage|undefined> {
    if (!this.owned(projectId,outcomeId) || !reference.mediaId || !reference.displayName || !['image/png','image/jpeg','image/svg+xml'].includes(reference.mediaType)) return undefined;
    const row=this.db.prepare('SELECT * FROM outcome_media WHERE id=? AND project_id=? AND outcome_id=?').get(reference.mediaId,projectId,outcomeId) as MediaRow|undefined;
    if (!row || row.media_type !== reference.mediaType || row.display_name !== reference.displayName || !['image/png','image/jpeg','image/svg+xml'].includes(row.media_type)) return undefined;
    const target = await this.existingManagedPath(projectId, row.stored_name); if (!target) return undefined;
    try {
      const bytes=await fs.promises.readFile(target);
      if(bytes.length!==row.byte_length || createHash('sha256').update(bytes).digest('hex')!==row.sha256 || !signatureOk(bytes,row.media_type)) return undefined;
      return { mediaId: row.id, mediaType: row.media_type, displayName: row.display_name, bytes } as OutcomePptxManagedImage;
    } catch { return undefined; }
  }
  /** Resolves one exact project/outcome-owned PNG/JPEG for DOCX export. */
  async readImageForWordDocxExport(projectId:string,outcomeId:string, mediaId:string):Promise<OutcomeWordDocxManagedImage|undefined> {
    if (!this.owned(projectId,outcomeId) || !mediaId) return undefined;
    const row=this.db.prepare('SELECT * FROM outcome_media WHERE id=? AND project_id=? AND outcome_id=?').get(mediaId,projectId,outcomeId) as MediaRow|undefined;
    if (!row || !isWordDocxImageMediaType(row.media_type)) return undefined;
    const target = await this.existingManagedPath(projectId, row.stored_name); if (!target) return undefined;
    try {
      const bytes=await fs.promises.readFile(target);
      if(bytes.length!==row.byte_length || createHash('sha256').update(bytes).digest('hex')!==row.sha256 || !signatureOk(bytes,row.media_type)) return undefined;
      return { mediaId: row.id, mediaType: row.media_type, displayName: row.display_name, bytes };
    } catch { return undefined; }
  }
  /** Reads one exact project/outcome-owned safe SVG for standalone file export. */
  /** Persist an original Office package (byte-preserving export anchor) for one outcome version. */
  async persistArchive(projectId: string, outcomeId: string, bytes: Buffer, kind: 'docx' | 'pptx', displayName: string): Promise<OutcomeMedia | undefined> {
    const mediaType = kind === 'docx' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' as const : 'application/vnd.openxmlformats-officedocument.presentationml.presentation' as const;
    return this.persistBytes(projectId, outcomeId, bytes, mediaType, displayName, kind === 'docx' ? '.docx' : '.pptx');
  }
  /** Persist a saved XLSX/PDF copy produced by an external native editor. */
  async persistExternalDocument(projectId: string, outcomeId: string, bytes: Buffer, kind: 'spreadsheet' | 'pdf', displayName: string): Promise<OutcomeMedia | undefined> {
    const mediaType = kind === 'spreadsheet' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' as const : 'application/pdf' as const;
    return this.persistBytes(projectId, outcomeId, bytes, mediaType, displayName, kind === 'spreadsheet' ? '.xlsx' : '.pdf');
  }
  /** Read back a persisted original Office package by media id (ownership checked). */
  async readArchive(projectId: string, outcomeId: string, mediaId: string): Promise<Buffer | undefined> {
    if (!this.owned(projectId, outcomeId) || !mediaId) return undefined;
    const row = this.db.prepare('SELECT * FROM outcome_media WHERE id=? AND project_id=? AND outcome_id=?').get(mediaId, projectId, outcomeId) as MediaRow | undefined;
    if (!row || (row.media_type !== 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' && row.media_type !== 'application/vnd.openxmlformats-officedocument.presentationml.presentation')) return undefined;
    const target = await this.existingManagedPath(projectId, row.stored_name); if (!target) return undefined;
    try {
      const bytes = await fs.promises.readFile(target);
      if (bytes.length !== row.byte_length || createHash('sha256').update(bytes).digest('hex') !== row.sha256) return undefined;
      return bytes;
    } catch { return undefined; }
  }
  async readStandaloneSvg(projectId:string,outcomeId:string, mediaId:string):Promise<Buffer|undefined> {
    if (!this.owned(projectId,outcomeId) || !mediaId) return undefined;
    const row=this.db.prepare('SELECT * FROM outcome_media WHERE id=? AND project_id=? AND outcome_id=?').get(mediaId,projectId,outcomeId) as MediaRow|undefined;
    if (!row || row.media_type!=='image/svg+xml') return undefined;
    const target = await this.existingManagedPath(projectId, row.stored_name); if (!target) return undefined;
    try {
      const bytes=await fs.promises.readFile(target);
      if(bytes.length!==row.byte_length || createHash('sha256').update(bytes).digest('hex')!==row.sha256 || !signatureOk(bytes,row.media_type)) return undefined;
      return bytes;
    } catch { return undefined; }
  }
}
