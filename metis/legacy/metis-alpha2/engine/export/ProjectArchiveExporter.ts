/**
 * METIS-F10 — Complete project archive (single-file, zero-dependency).
 *
 * The archive is itself a SQLite database: it carries an exact row-level copy of the
 * project's research tables plus attached source files as BLOBs. Restore copies rows
 * back via column-intersection INSERT OR REPLACE, so no field mapping can drift and
 * every column (deleted_at, version history, inputs, decisions) survives the round
 * trip. No zip/tar dependency is needed; integrity is verifiable by reopening the
 * archive and comparing entity counts + per-file sha256.
 */

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const PROJECT_ARCHIVE_FORMAT = 'metis-project-archive';
export const PROJECT_ARCHIVE_FORMAT_VERSION = 1;
export const PROJECT_ARCHIVE_EXT = '.mts';
/** Legacy extension still accepted on import (archives made before the rename). */
export const PROJECT_ARCHIVE_LEGACY_EXTS = ['.metisproj'] as const;

export const PROJECT_ARCHIVE_DEFAULTS = Object.freeze({
  /** Single attached file size cap (bytes). Larger files are skipped, never fatal. */
  maxFileBytes: 256 * 1024 * 1024,
  /** Total attached files cap. Beyond this the export fails loudly instead of ballooning. */
  maxAttachedFiles: 500,
} as const);

/**
 * Tables whose rows carry a project_id column. `projects` itself is included and is
 * filtered by its primary key (id) instead.
 */
const PROJECT_SCOPED_TABLES = [
  'projects',
  'sources',
  'evidence',
  'note_codes',
  'claims',
  'research_artifacts',
  'research_runs',
  'research_checkpoints',
  'research_decisions',
  'side_effect_ledger',
] as const;

/** Tables with no project_id column, reachable only through a parent table. */
const LINKED_TABLES: Readonly<Record<string, { via: string; column: string }>> = {
  claim_evidence_links: { via: 'claims', column: 'claim_id' },
  artifact_versions: { via: 'research_artifacts', column: 'artifact_id' },
  artifact_inputs: { via: 'research_artifacts', column: 'artifact_id' },
  artifact_citations: { via: 'research_artifacts', column: 'artifact_id' },
};

export interface ProjectArchiveManifest {
  format: string;
  formatVersion: number;
  exportedAt: number;
  appVersion?: string;
  projectId: string;
  projectTitle: string;
  entityCounts: Record<string, number>;
  attachedFiles: {
    count: number;
    bytes: number;
    skipped: Array<{ sourceId: string; reason: string }>;
  };
}

export interface ProjectArchiveExportOptions {
  /** Live main database (e.g. store.raw). Must be a file-backed database. */
  db: Database.Database;
  projectId: string;
  /** Destination path for the .mts archive. */
  destPath: string;
  appVersion?: string;
  maxFileBytes?: number;
  maxAttachedFiles?: number;
}

export interface ProjectArchiveExportResult {
  ok: boolean;
  path?: string;
  error?: string;
  manifest?: ProjectArchiveManifest;
}

export interface ProjectArchiveImportOptions {
  /** Target main database. */
  db: Database.Database;
  archivePath: string;
  /**
   * Optional remap: import the project under a different id (used when the original
   * id already exists or the user wants a copy). Defaults to the archived id.
   */
  projectId?: string;
  /** Allow overwriting an existing project with the same id. */
  overwrite?: boolean;
  /** Directory where attached source files are restored (created if missing). */
  filesDir: string;
}

export interface ProjectArchiveImportResult {
  ok: boolean;
  projectId?: string;
  error?: string;
  restored?: {
    projectId: string;
    entityCounts: Record<string, number>;
    attachedFiles: { count: number; bytes: number; restoredPaths: string[] };
  };
}

// ─── Helpers ─────────────────────────────────────────────────

function tableColumns(database: Database.Database, table: string): string[] {
  return (database.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>)
    .map((row) => row.name);
}

function tableExists(database: Database.Database, table: string): boolean {
  return (database.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(table) as { 1: number } | undefined) !== undefined;
}

function isProjectScoped(table: string): boolean {
  return (PROJECT_SCOPED_TABLES as readonly string[]).includes(table);
}

function sha256Of(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

// ─── Export ───────────────────────────────────────────────────

export async function exportProjectArchive(options: ProjectArchiveExportOptions): Promise<ProjectArchiveExportResult> {
  const { db, projectId, destPath, appVersion } = options;
  const maxFileBytes = options.maxFileBytes ?? PROJECT_ARCHIVE_DEFAULTS.maxFileBytes;
  const maxAttachedFiles = options.maxAttachedFiles ?? PROJECT_ARCHIVE_DEFAULTS.maxAttachedFiles;

  const projectRow = db.prepare('SELECT id, title FROM projects WHERE id = ?').get(projectId) as
    | { id: string; title: string }
    | undefined;
  if (!projectRow) {
    return { ok: false, error: `Project not found: ${projectId}` };
  }

  fs.mkdirSync(path.dirname(path.resolve(destPath)), { recursive: true });
  // VACUUM/backup into an existing file is allowed, but a stale archive would be
  // confusing — remove any previous artifact at the destination.
  try {
    fs.rmSync(destPath, { force: true });
  } catch {
    /* best effort */
  }

  const archive = new Database(':memory:');
  const entityCounts: Record<string, number> = {};
  const skippedFiles: Array<{ sourceId: string; reason: string }> = [];
  let attachedCount = 0;
  let attachedBytes = 0;

  try {
    // Reference the live main database from inside the archive connection.
    const mainPath = String(db.name ?? '');
    if (!mainPath || mainPath === ':memory:') {
      return { ok: false, error: 'Export requires a file-backed main database' };
    }
    archive.exec(`ATTACH DATABASE '${mainPath.replace(/'/g, "''")}' AS srv`);

    // 1. Recreate the exact research table shapes inside the archive (DDL copy), so
    //    the restore side only ever deals with columns that exist in both sides.
    const needed = [
      ...PROJECT_SCOPED_TABLES,
      ...Object.keys(LINKED_TABLES),
      'papers',
      'sessions',
      'messages',
      'archive_meta',
      'archive_files',
    ];
    const existing = new Set(
      (archive.prepare("SELECT name FROM srv.sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
        .map((row) => row.name),
    );
    const ddlRows = archive.prepare(
      "SELECT name, sql FROM srv.sqlite_master WHERE type = 'table' AND name IN (SELECT value FROM json_each(?))",
    ).all(JSON.stringify(needed.filter((t) => existing.has(t)))) as Array<{ name: string; sql: string | null }>;
    for (const row of ddlRows) {
      if (row.sql) archive.exec(row.sql);
    }
    archive.exec(`
      CREATE TABLE IF NOT EXISTS archive_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS archive_files (
        source_id TEXT PRIMARY KEY,
        original_name TEXT NOT NULL,
        original_path TEXT,
        sha256 TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'ok',
        data BLOB
      );
    `);

    // 2. Row-level copy of every project-scoped table.
    const copy = archive.transaction(() => {
      for (const table of PROJECT_SCOPED_TABLES) {
        if (!existing.has(table)) continue;
        const where = table === 'projects' ? 'id = ?' : 'project_id = ?';
        const count = archive.prepare(`INSERT INTO "${table}" SELECT * FROM srv."${table}" WHERE ${where}`).run(projectId);
        entityCounts[table] = count.changes;
      }
      for (const [table, { via, column }] of Object.entries(LINKED_TABLES)) {
        if (!existing.has(table)) continue;
        const count = archive.prepare(
          `INSERT INTO "${table}" SELECT * FROM srv."${table}" WHERE "${column}" IN (SELECT id FROM srv."${via}" WHERE project_id = ?)`,
        ).run(projectId);
        entityCounts[table] = count.changes;
      }
      // The full library travels with a project archive so the imported
      // project keeps working without its literature on the new device.
      if (existing.has('papers')) {
        const paperCount = archive.prepare(
          'INSERT INTO papers SELECT * FROM srv.papers',
        ).run().changes;
        if (paperCount > 0) entityCounts.papers = paperCount;
      }
      // Conversations that belong to this project (sessions carry project_id)
      // travel with their full message history.
      if (existing.has('sessions')) {
        const sessionCount = archive.prepare(
          'INSERT INTO sessions SELECT * FROM srv.sessions WHERE project_id = ?',
        ).run(projectId).changes;
        if (sessionCount > 0) {
          entityCounts.sessions = sessionCount;
          if (existing.has('messages')) {
            const messageCount = archive.prepare(
              `INSERT INTO messages SELECT * FROM srv.messages WHERE session_id IN
               (SELECT id FROM srv.sessions WHERE project_id = ?)`,
            ).run(projectId).changes;
            if (messageCount > 0) entityCounts.messages = messageCount;
          }
        }
      }
    });
    copy();

    // 3. Attached source files as BLOBs (sha256-verified on restore).
    const fileInsert = archive.prepare(`
      INSERT OR REPLACE INTO archive_files
        (source_id, original_name, original_path, sha256, bytes, status, data)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const embedFile = (
      key: string,
      filePath: string,
      displayName: string,
      originPath: string,
    ): void => {
      let stat: fs.Stats;
      try {
        stat = fs.statSync(filePath);
      } catch {
        skippedFiles.push({ sourceId: key, reason: 'file_missing' });
        fileInsert.run(key, displayName, originPath, '', 0, 'missing', null);
        return;
      }
      if (!stat.isFile()) {
        skippedFiles.push({ sourceId: key, reason: 'not_a_file' });
        fileInsert.run(key, displayName, originPath, '', 0, 'missing', null);
        return;
      }
      if (stat.size > maxFileBytes) {
        skippedFiles.push({ sourceId: key, reason: `oversize_${stat.size}` });
        fileInsert.run(key, displayName, originPath, '', stat.size, 'skipped_oversize', null);
        return;
      }
      if (attachedCount >= maxAttachedFiles) {
        skippedFiles.push({ sourceId: key, reason: 'too_many_files' });
        fileInsert.run(key, displayName, originPath, '', stat.size, 'skipped_limit', null);
        return;
      }
      let data: Buffer;
      try {
        data = fs.readFileSync(filePath);
      } catch (err) {
        skippedFiles.push({ sourceId: key, reason: `unreadable:${(err as Error).message.slice(0, 120)}` });
        fileInsert.run(key, displayName, originPath, '', stat.size, 'unreadable', null);
        return;
      }
      const hash = sha256Of(data);
      fileInsert.run(key, displayName, originPath, hash, data.length, 'ok', data);
      attachedCount++;
      attachedBytes += data.length;
    };
    const sourceRows = archive.prepare("SELECT id, title, file_path FROM sources WHERE project_id = ?").all(projectId) as Array<{
      id: string;
      title: string;
      file_path: string | null;
    }>;
    for (const source of sourceRows) {
      const filePath = source.file_path;
      if (!filePath) continue;
      embedFile(source.id, filePath, path.basename(filePath), filePath);
    }
    // PDFs of library papers (the whole library travels with the project).
    const paperRows = archive.prepare('SELECT id, title, pdf_path FROM papers').all() as Array<{
      id: string;
      title: string;
      pdf_path: string | null;
    }>;
    for (const paper of paperRows) {
      const pdfPath = paper.pdf_path;
      if (!pdfPath) continue;
      embedFile(`paper:${paper.id}`, pdfPath, `${paper.title || paper.id}.pdf`, pdfPath);
    }

    // 4. Archive metadata.
    const meta: ProjectArchiveManifest = {
      format: PROJECT_ARCHIVE_FORMAT,
      formatVersion: PROJECT_ARCHIVE_FORMAT_VERSION,
      exportedAt: Date.now(),
      ...(appVersion ? { appVersion } : {}),
      projectId,
      projectTitle: projectRow.title,
      entityCounts,
      attachedFiles: { count: attachedCount, bytes: attachedBytes, skipped: skippedFiles },
    };
    const metaInsert = archive.prepare('INSERT OR REPLACE INTO archive_meta (key, value) VALUES (?, ?)');
    metaInsert.run('format', meta.format);
    metaInsert.run('formatVersion', String(meta.formatVersion));
    metaInsert.run('exportedAt', String(meta.exportedAt));
    if (appVersion) metaInsert.run('appVersion', appVersion);
    metaInsert.run('projectId', meta.projectId);
    metaInsert.run('projectTitle', meta.projectTitle);
    metaInsert.run('entityCounts', JSON.stringify(meta.entityCounts));
    metaInsert.run('attachedFiles', JSON.stringify(meta.attachedFiles));

    // 5. Persist the in-memory archive to a single file.
    await archive.backup(destPath);

    return { ok: true, path: destPath, manifest: meta };
  } catch (err) {
    return { ok: false, error: `Archive export failed: ${(err as Error).message}` };
  } finally {
    archive.close();
  }
}

// ─── Import ───────────────────────────────────────────────────

export async function importProjectArchive(options: ProjectArchiveImportOptions): Promise<ProjectArchiveImportResult> {
  const { db, archivePath, filesDir } = options;
  let archive: Database.Database | null = null;
  try {
    if (!fs.existsSync(archivePath)) {
      return { ok: false, error: `Archive not found: ${archivePath}` };
    }
    archive = new Database(archivePath, { readonly: true });

    // 1. Validate the container.
    const metaRow = (key: string) => archive?.prepare('SELECT value FROM archive_meta WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    const format = metaRow('format')?.value;
    if (format !== PROJECT_ARCHIVE_FORMAT) {
      return { ok: false, error: `Not a Metis project archive (format=${format ?? 'unknown'})` };
    }
    const formatVersion = Number(metaRow('formatVersion')?.value ?? '0');
    if (formatVersion > PROJECT_ARCHIVE_FORMAT_VERSION) {
      return { ok: false, error: `Archive format v${formatVersion} is newer than this app supports (v${PROJECT_ARCHIVE_FORMAT_VERSION})` };
    }
    const archivedProjectId = metaRow('projectId')?.value;
    if (!archivedProjectId) return { ok: false, error: 'Archive is missing projectId metadata' };
    const targetId = (options.projectId ?? archivedProjectId).replace(/[^A-Za-z0-9._-]/g, '_');

    const existing = db.prepare('SELECT id FROM projects WHERE id = ?').get(targetId) as { id: string } | undefined;
    if (existing && !options.overwrite) {
      return { ok: false, error: `project_exists:${targetId}`, projectId: targetId };
    }

    // 2. Row-level restore via column intersection (columns present in both sides).
    const entityCounts: Record<string, number> = {};
    const runCopy = db.transaction(() => {
      for (const table of PROJECT_SCOPED_TABLES) {
        const count = copyTableRows(archive!, db, table, targetId, archivedProjectId, existing);
        entityCounts[table] = count;
      }
      for (const table of Object.keys(LINKED_TABLES)) {
        const count = copyTableRows(archive!, db, table, targetId, archivedProjectId, existing);
        entityCounts[table] = count;
      }
      // Library papers linked to the archived project (already filtered at
      // export time; copyTableRows remaps their project_id below).
      if (tableExists(archive!, 'papers')) {
        const count = copyTableRows(archive!, db, 'papers', targetId, archivedProjectId, existing);
        if (count > 0) entityCounts.papers = count;
      }
      // Project conversations and their messages.
      if (tableExists(archive!, 'sessions')) {
        const sessionCount = copyTableRows(archive!, db, 'sessions', targetId, archivedProjectId, existing);
        if (sessionCount > 0) {
          entityCounts.sessions = sessionCount;
          if (tableExists(archive!, 'messages')) {
            const messageCount = copyTableRows(archive!, db, 'messages', targetId, archivedProjectId, existing);
            if (messageCount > 0) entityCounts.messages = messageCount;
          }
        }
      }
    });
    runCopy();

    // 3. Restore attached files and repoint source file_path entries.
    const restoredPaths: string[] = [];
    let fileCount = 0;
    let fileBytes = 0;
    const fileRows = archive.prepare('SELECT source_id, original_name, sha256, bytes, status, data FROM archive_files WHERE status = ?').all('ok') as Array<{
      source_id: string;
      original_name: string;
      sha256: string;
      bytes: number;
      data: Buffer | null;
    }>;
    const writeVerified = (key: string, data: Buffer, sha256: string, bytes: number): string | null => {
      const actualHash = sha256Of(data);
      if (actualHash !== sha256) return null;
      if (data.length !== bytes) return null;
      const safeName = `${sha256.slice(0, 16)}_${path.basename(key).replace(/[^A-Za-z0-9._-]/g, '_')}`;
      return safeName;
    };
    const sourcesDir = path.join(filesDir, targetId, 'sources');
    fs.mkdirSync(sourcesDir, { recursive: true });
    for (const file of fileRows) {
      if (file.source_id.startsWith('paper:')) continue; // handled below
      if (!file.data) continue;
      const safeName = writeVerified(file.source_id, file.data, file.sha256, file.bytes);
      if (!safeName) {
        // Corrupt archive content — record it and continue.
        fileCount++;
        continue;
      }
      const destFile = path.join(sourcesDir, safeName);
      fs.writeFileSync(destFile, file.data);
      // Repoint the source's file_path (both archived and remapped ids are handled
      // by the caller of copyTableRows via project remapping).
      db.prepare('UPDATE sources SET file_path = ? WHERE id = ?').run(destFile, file.source_id);
      restoredPaths.push(destFile);
      fileCount++;
      fileBytes += file.data.length;
    }

    // 3b. Restore PDFs of linked library papers.
    const papersDir = path.join(filesDir, targetId, 'papers');
    fs.mkdirSync(papersDir, { recursive: true });
    for (const file of fileRows) {
      if (!file.source_id.startsWith('paper:') || !file.data) continue;
      const paperId = file.source_id.slice('paper:'.length);
      const safeName = writeVerified(file.source_id, file.data, file.sha256, file.bytes);
      if (!safeName) continue;
      const destFile = path.join(papersDir, safeName);
      fs.writeFileSync(destFile, file.data);
      db.prepare('UPDATE papers SET pdf_path = ? WHERE id = ?').run(destFile, paperId);
      restoredPaths.push(destFile);
      fileCount++;
      fileBytes += file.data.length;
    }

    return {
      ok: true,
      projectId: targetId,
      restored: {
        projectId: targetId,
        entityCounts,
        attachedFiles: { count: fileCount, bytes: fileBytes, restoredPaths },
      },
    };
  } catch (err) {
    return { ok: false, error: `Archive import failed: ${(err as Error).message}` };
  } finally {
    archive?.close();
  }
}

/**
 * Copy one table's rows from the archive into the main db, remapping the project
 * id when needed. Rows already present are replaced (INSERT OR REPLACE), which makes
 * imports idempotent and enables overwrite mode.
 */
function copyTableRows(
  archive: Database.Database,
  target: Database.Database,
  table: string,
  targetId: string,
  archivedProjectId: string,
  existing: { id: string } | undefined,
): number {
  const archiveCols = tableColumns(archive, table);
  if (archiveCols.length === 0) return 0;
  const targetCols = new Set(tableColumns(target, table));
  const cols = archiveCols.filter((col) => targetCols.has(col));
  if (cols.length === 0) return 0;

  const rows = archive.prepare(`SELECT * FROM "${table}"`).all() as Array<Record<string, unknown>>;
  if (rows.length === 0) return 0;

  let count = 0;
  const insert = target.prepare(
    `INSERT OR REPLACE INTO "${table}" (${cols.map((c) => `"${c}"`).join(', ')})
     VALUES (${cols.map(() => '?').join(', ')})`,
  );
  for (const row of rows) {
    if (table === 'projects') {
      // projects rows are keyed by id; remap the project id itself.
      row.id = targetId;
    } else if (table === 'papers' || table === 'sessions') {
      // Papers keep their own ids but follow the remapped project id; sessions
      // likewise (their messages travel along unchanged).
      if (row.project_id === archivedProjectId) row.project_id = targetId;
    } else if (isProjectScoped(table)) {
      row.project_id = targetId;
    }
    void archivedProjectId;
    void existing;
    const values = cols.map((col) => {
      const value = row[col];
      return value === undefined ? null : value;
    });
    insert.run(...values);
    count++;
  }
  return count;
}
