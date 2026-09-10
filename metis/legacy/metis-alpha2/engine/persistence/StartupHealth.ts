/**
 * Database startup health checks (schema invariants + SQLite integrity).
 *
 * Runs on every startup AFTER the baseline + migration pipeline and BEFORE any
 * feature code touches the store. A failing check stops the app fail-closed with
 * a structured, user-readable recovery state — never a deferred `no such column`.
 *
 * `quick_check` + `foreign_key_check` run on every startup; the expensive
 * `integrity_check` runs only in diagnostic mode (METIS_DB_DIAGNOSTIC=1).
 */

import type Database from 'better-sqlite3';

export interface StartupHealthCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface StartupHealthReport {
  ok: boolean;
  checkedAt: number;
  checks: StartupHealthCheck[];
  /** MAX(schema_version), when the legacy mirror table exists. */
  schemaVersion: number | null;
  /** MAX(schema_migrations) — the authoritative pipeline version. */
  migrationVersion: number;
  diagnosticMode: boolean;
}

/** Tables every Metis database must contain after the migration pipeline. */
export const CRITICAL_TABLES: readonly string[] = [
  // baseline shape
  'sessions', 'messages', 'tool_results', 'checkpoints', 'workflow_runs', 'eval_runs',
  'schema_version', 'schema_migrations', 'migration_log',
  'papers', 'collections', 'notes', 'experiments', 'memory', 'mcp_servers', 'artifacts',
  // unified research model
  'projects', 'paper_project_links', 'sources', 'evidence', 'note_codes', 'claims',
  'claim_evidence_links', 'research_artifacts', 'artifact_versions', 'artifact_inputs',
  'artifact_citations', 'research_runs', 'research_checkpoints', 'research_decisions',
  'side_effect_ledger',
  // outcomes workbench
  'outcome_categories', 'outcomes', 'outcome_versions', 'outcome_changes',
  'outcome_templates', 'outcome_default_templates', 'scoped_conversations',
  'scoped_conversation_messages', 'outcome_media', 'outcome_prompt_overrides',
  'outcome_prompt_revisions',
  // topic workspace
  'topic_sessions', 'topic_candidates', 'topic_messages',
  // capability vault / office / external references
  'capability_vault', 'external_references', 'office_prompt_profiles',
  'office_prompt_profile_revisions', 'office_prompt_profile_defaults',
  'office_prompt_outcome_bindings',
  // submission domain
  'submission_series', 'submission_cases', 'submission_events', 'submission_shortlists',
  'submission_preflight_runs', 'submission_preflight_checks', 'submission_packages',
  'submission_package_files', 'submission_review_rounds', 'submission_review_comments',
  'submission_correspondence',
  // journal profiling
  'journal_profiles', 'journal_profile_snapshots', 'journal_requirements',
  'journal_corpus_items', 'journal_pattern_observations', 'submission_gap_items',
  'submission_optimization_plans', 'submission_optimization_items',
];

/** Columns that were introduced by migrations and that running code writes unconditionally. */
export const CRITICAL_COLUMNS: ReadonlyArray<{ table: string; column: string }> = [
  { table: 'papers', column: 'pdf_text' },
  { table: 'papers', column: 'citation_count' },
  { table: 'papers', column: 'pdf_url' },
  { table: 'papers', column: 'reference_ids' },
  { table: 'papers', column: 'project_id' },
  { table: 'notes', column: 'project_id' },
  { table: 'notes', column: 'scope' },
  { table: 'sources', column: 'library_paper_id' },
  { table: 'sessions', column: 'project_id' },
  { table: 'sessions', column: 'scenario_id' },
  { table: 'sessions', column: 'active_artifact_ids' },
  { table: 'submission_cases', column: 'targeting_json' },
  { table: 'submission_correspondence', column: 'attachment_names' },
  { table: 'submission_correspondence', column: 'attachment_texts' },
  { table: 'experiments', column: 'linked_paper_ids' },
  { table: 'experiments', column: 'script_path' },
  { table: 'experiments', column: 'script_type' },
  { table: 'experiments', column: 'starred' },
  { table: 'artifacts', column: 'content' },
  { table: 'memory', column: 'project_id' },
  { table: 'office_prompt_profiles', column: 'global_prompt' },
  { table: 'personalization_definitions', column: 'archived_at' },
  { table: 'personalization_run_manifests', column: 'integrity_tag' },
  { table: 'personalization_scenario_runs', column: 'integrity_tag' },
];

/** Indexes created by migrations (the baseline only holds indexes on never-migrated columns). */
export const CRITICAL_INDEXES: readonly string[] = [
  'idx_papers_project_id',
  'idx_notes_project_scope',
  'idx_paper_project_links_project',
  'idx_sources_project_library_paper',
  'idx_sessions_project_id',
  'idx_memory_project',
  'idx_personalization_archived_retention',
];

function tableColumns(db: Database.Database, table: string): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name),
  );
}

/**
 * Full startup health report. Throws nothing — callers decide what a failed check
 * means (PersistenceStore turns failures into PersistenceStartupError).
 */
export function runStartupHealthChecks(db: Database.Database, options?: { diagnostic?: boolean }): StartupHealthReport {
  const checks: StartupHealthCheck[] = [];
  const diagnosticMode = options?.diagnostic === true
    || process.env.METIS_DB_DIAGNOSTIC === '1';

  // 1. quick_check — fast structural scan; mandatory on every startup.
  try {
    const rows = db.pragma('quick_check', { simple: true }) as unknown;
    const ok = rows === 'ok';
    checks.push({ name: 'quick_check', ok, detail: ok ? 'ok' : String(rows) });
  } catch (err) {
    checks.push({ name: 'quick_check', ok: false, detail: (err as Error).message });
  }

  // 2. foreign_key_check — referential integrity of user data.
  try {
    const violations = db.pragma('foreign_key_check') as Array<Record<string, unknown>>;
    const ok = violations.length === 0;
    const detail = ok
      ? 'ok'
      : violations.slice(0, 10).map((v) => `${String(v.table)}#${String(v.rowid)}→${String(v.parent)}`).join('; ')
        + (violations.length > 10 ? ` (+${violations.length - 10} more)` : '');
    checks.push({ name: 'foreign_key_check', ok, detail });
  } catch (err) {
    checks.push({ name: 'foreign_key_check', ok: false, detail: (err as Error).message });
  }

  // 3. integrity_check — full scan, diagnostic mode only.
  if (diagnosticMode) {
    try {
      const result = db.pragma('integrity_check', { simple: true }) as unknown;
      const ok = result === 'ok';
      checks.push({ name: 'integrity_check', ok, detail: ok ? 'ok' : String(result) });
    } catch (err) {
      checks.push({ name: 'integrity_check', ok: false, detail: (err as Error).message });
    }
  }

  // 4. Schema invariants — critical tables / columns / indexes.
  const invariantProblems: string[] = [];
  const existingTables = new Set(
    (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
      .map((row) => row.name),
  );
  for (const table of CRITICAL_TABLES) {
    if (!existingTables.has(table)) invariantProblems.push(`missing table '${table}'`);
  }
  const columnCache = new Map<string, Set<string>>();
  for (const { table, column } of CRITICAL_COLUMNS) {
    let columns = columnCache.get(table);
    if (!columns) {
      if (!existingTables.has(table)) continue; // already reported as missing table
      columns = tableColumns(db, table);
      columnCache.set(table, columns);
    }
    if (!columns.has(column)) invariantProblems.push(`missing column '${table}.${column}'`);
  }
  const existingIndexes = new Set(
    (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string }>)
      .map((row) => row.name),
  );
  for (const index of CRITICAL_INDEXES) {
    if (!existingIndexes.has(index)) invariantProblems.push(`missing index '${index}'`);
  }
  checks.push({
    name: 'schema_invariants',
    ok: invariantProblems.length === 0,
    detail: invariantProblems.length === 0 ? `ok (${CRITICAL_TABLES.length} tables, ${CRITICAL_COLUMNS.length} columns, ${CRITICAL_INDEXES.length} indexes)` : invariantProblems.join('; '),
  });

  // 5. Versions, for the report/diagnostics (a low value alone is not a failure).
  let schemaVersion: number | null = null;
  try {
    if (existingTables.has('schema_version')) {
      const row = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number | null };
      schemaVersion = row.v ?? null;
    }
  } catch { /* reported via schema_invariants when it matters */ }
  let migrationVersion = 0;
  try {
    const row = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number | null };
    migrationVersion = row.v ?? 0;
  } catch { /* infra table ensured by the pipeline; failure surfaces in quick_check */ }

  return {
    ok: checks.every((check) => check.ok),
    checkedAt: Date.now(),
    checks,
    schemaVersion,
    migrationVersion,
    diagnosticMode,
  };
}
