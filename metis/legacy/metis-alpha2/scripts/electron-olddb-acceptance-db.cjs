/**
 * 任务1（§十三）E2E 的 DB 子步骤：在 Electron 内嵌 Node（ABI 与打包运行时一致）
 * 下执行 old-baseline fixture 构建或验收断言。编排进程（普通 Node）不加载
 * better-sqlite3。
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe \
 *   scripts/electron-olddb-acceptance-db.cjs <build|assert> <dbPath>
 */

const fs = require('node:fs');
const path = require('node:path');

const [step, dbPath] = process.argv.slice(2);
if (!step || !dbPath) {
  console.error('usage: electron-olddb-acceptance-db.cjs <build|assert> <dbPath>');
  process.exit(64);
}

const Database = require('better-sqlite3');

function build() {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, last_activity INTEGER NOT NULL, message_count INTEGER NOT NULL DEFAULT 0, metadata TEXT NOT NULL DEFAULT '{}');
    CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL DEFAULT '', tool_calls TEXT, tool_call_id TEXT, name TEXT, metadata TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, FOREIGN KEY (session_id) REFERENCES sessions(id));
    CREATE INDEX idx_messages_session ON messages(session_id, created_at);
    CREATE TABLE tool_results (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, tool_name TEXT NOT NULL, tool_call_id TEXT NOT NULL, content TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'ok', error TEXT, metadata TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, FOREIGN KEY (session_id) REFERENCES sessions(id));
    CREATE TABLE checkpoints (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, phase TEXT NOT NULL, status TEXT NOT NULL, turn_index INTEGER NOT NULL DEFAULT 0, metadata TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, FOREIGN KEY (session_id) REFERENCES sessions(id));
    CREATE TABLE workflow_runs (id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, status TEXT NOT NULL, current_step_id TEXT, step_results TEXT NOT NULL DEFAULT '{}', input TEXT NOT NULL DEFAULT '{}', errors TEXT NOT NULL DEFAULT '[]', started_at INTEGER NOT NULL, completed_at INTEGER, metadata TEXT NOT NULL DEFAULT '{}');
    CREATE TABLE eval_runs (id TEXT PRIMARY KEY, suite_name TEXT NOT NULL, status TEXT NOT NULL, success_rate REAL NOT NULL DEFAULT 0, task_count INTEGER NOT NULL DEFAULT 0, passed_count INTEGER NOT NULL DEFAULT 0, results_json TEXT NOT NULL DEFAULT '[]', metadata TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, completed_at INTEGER);
    CREATE TABLE schema_version (version INTEGER PRIMARY KEY);
    INSERT INTO schema_version (version) VALUES (5);
    CREATE TABLE papers (id TEXT PRIMARY KEY, title TEXT NOT NULL, authors TEXT NOT NULL DEFAULT '[]', year INTEGER NOT NULL DEFAULT 0, venue TEXT NOT NULL DEFAULT '', abstract TEXT NOT NULL DEFAULT '', doi TEXT, arxiv_id TEXT, pdf_path TEXT, tags TEXT NOT NULL DEFAULT '[]', notes TEXT NOT NULL DEFAULT '', read_status TEXT NOT NULL DEFAULT 'unread', rating INTEGER NOT NULL DEFAULT 0, added_at INTEGER NOT NULL);
    CREATE TABLE notes (id TEXT PRIMARY KEY, title TEXT NOT NULL, content TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '[]', linked_paper_ids TEXT NOT NULL DEFAULT '[]', linked_note_ids TEXT NOT NULL DEFAULT '[]', updated_at INTEGER NOT NULL);
    CREATE TABLE experiments (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'planned', parameters TEXT NOT NULL DEFAULT '{}', metrics TEXT NOT NULL DEFAULT '{}', tags TEXT NOT NULL DEFAULT '[]', notes TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL);
    CREATE TABLE memory (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '', category TEXT NOT NULL DEFAULT 'general', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE mcp_servers (id TEXT PRIMARY KEY, name TEXT NOT NULL, command TEXT NOT NULL, args TEXT NOT NULL DEFAULT '[]', env TEXT NOT NULL DEFAULT '{}', enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL);
    CREATE TABLE artifacts (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'other', path TEXT, size TEXT, metadata TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE);
    CREATE INDEX idx_artifacts_session ON artifacts(session_id, created_at);

    INSERT INTO papers (id, title, authors, year, added_at) VALUES ('paper-e2e', '旧库验收论文', '["验收员"]', 2020, 100);
    INSERT INTO memory (key, value, category, created_at, updated_at) VALUES ('mem-e2e', '旧库验收记忆', 'general', 100, 100);
    INSERT INTO sessions (id, created_at, last_activity, message_count) VALUES ('sess-e2e', 100, 100, 1);
    INSERT INTO messages (session_id, role, content, created_at) VALUES ('sess-e2e', 'user', '旧库验收消息', 100);
    INSERT INTO artifacts (id, session_id, name, type, created_at) VALUES ('art-e2e', 'sess-e2e', '旧库验收成果', 'other', 100);
  `);
  db.close();
  console.log(JSON.stringify({ ok: true, step: 'build' }));
}

function assertState() {
  const raw = new Database(dbPath, { readonly: true });
  try {
    const tableNames = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
    const paper = raw.prepare("SELECT title FROM papers WHERE id = 'paper-e2e'").get();
    const mem = raw.prepare("SELECT value FROM memory WHERE key = 'mem-e2e'").get();
    const maxVersion = raw.prepare('SELECT MAX(version) v FROM schema_migrations').get()?.v;
    const profileCols = raw.prepare('PRAGMA table_info(office_prompt_profiles)').all().map((r) => r.name);
    const sessCols = raw.prepare('PRAGMA table_info(sessions)').all().map((r) => r.name);
    const appliedRuns = raw.prepare("SELECT COUNT(*) c FROM migration_log WHERE status = 'applied'").get()?.c;
    const messages = raw.prepare("SELECT content FROM messages WHERE session_id = 'sess-e2e'").all().map((r) => r.content);
    console.log(JSON.stringify({
      ok: true,
      step: 'assert',
      paperTitle: paper?.title ?? null,
      memoryValue: mem?.value ?? null,
      maxVersion,
      globalPromptPresent: profileCols.includes('global_prompt'),
      sessionsProjectIdPresent: sessCols.includes('project_id'),
      appliedRuns,
      messages,
      tables: tableNames.length,
    }));
  } finally {
    raw.close();
  }
}

try {
  if (step === 'build') build();
  else if (step === 'assert') assertState();
  else { console.error('unknown step: ' + step); process.exit(64); }
} catch (err) {
  console.error(JSON.stringify({ ok: false, step, error: String(err?.message ?? err) }));
  process.exit(1);
}
