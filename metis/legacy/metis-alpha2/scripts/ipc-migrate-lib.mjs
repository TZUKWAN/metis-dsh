// IPC migration helper (Task 3): extract handler blocks by channel prefix,
// analyze their references against main.ts module-level declarations, and
// emit a registrar skeleton. Read-only until --apply is passed.
//
// Usage:
//   node scripts/ipc-migrate-lib.mjs --prefix 'freeModel:','mailbox:' --owner freeModel
//   node scripts/ipc-migrate-lib.mjs --analyze-only   (no writes)
import fs from 'node:fs';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const prefixes = (flag('--prefix') ?? '').split(',').filter(Boolean);
const owner = flag('--owner') ?? 'unknown';

const src = fs.readFileSync('electron/main.ts', 'utf8');
const lines = src.split(/\r?\n/);

// ── module-level declaration inventory ───────────────────────
const moduleDecls = new Map(); // name -> kind
const declPatterns = [
  [/^let\s+([A-Za-z_$][\w$]*)/, 'let'],
  [/^const\s+([A-Za-z_$][\w$]*)/, 'const'],
  [/^function\s+([A-Za-z_$][\w$]*)/, 'function'],
  [/^async\s+function\s+([A-Za-z_$][\w$]*)/, 'function'],
  [/^export\s+function\s+([A-Za-z_$][\w$]*)/, 'export-function'],
  [/^export\s+const\s+([A-Za-z_$][\w$]*)/, 'export-const'],
];
for (const l of lines) {
  for (const [re, kind] of declPatterns) {
    const m = l.match(re);
    if (m) moduleDecls.set(m[1], kind);
  }
}

// ── locate handler blocks ────────────────────────────────────
function findBlocks() {
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/ipcMain\.handle\(\s*(['"`])([^'"`]+)\1/);
    if (!m) continue;
    if (!prefixes.some((p) => m[2].startsWith(p))) continue;
    const start = i;
    // brace-depth scan to the closing `);` of this handle call
    let depth = 0;
    let end = i;
    for (let j = i; j < lines.length; j++) {
      for (const ch of lines[j]) {
        if (ch === '(' || ch === '{' || ch === '[') depth++;
        else if (ch === ')' || ch === '}' || ch === ']') depth--;
      }
      if (depth <= 0 && j >= i) { end = j; break; }
    }
    blocks.push({ start, end, channel: m[2] });
  }
  return blocks;
}

function mergeBlocks(blocks) {
  // merge blocks separated only by blank lines / comments
  const merged = [];
  for (const b of blocks) {
    const last = merged[merged.length - 1];
    if (last && b.start - last.end <= 3) {
      let gapOK = true;
      for (let k = last.end + 1; k < b.start; k++) {
        const t = lines[k].trim();
        if (t !== '' && !t.startsWith('//')) gapOK = false;
      }
      if (gapOK) { last.end = b.end; last.channels.push(b.channel); continue; }
    }
    merged.push({ start: b.start, end: b.end, channels: [b.channel] });
  }
  return merged;
}

// leading comment lines above each merged block
function withLeadingComments(block) {
  let s = block.start;
  while (s - 1 >= 0 && lines[s - 1].trim().startsWith('//')) s--;
  return { ...block, start: s };
}

const blocks = mergeBlocks(findBlocks()).map(withLeadingComments);
const allChannels = blocks.flatMap((b) => b.channels);
console.error(`[extract] ${allChannels.length} channels for ${owner}: ${blocks.length} block(s)`);
console.error('[extract] blocks:', blocks.map((b) => `L${b.start + 1}-L${b.end + 1}(${b.channels.length})`).join(' '));

// ── identifier reference analysis ────────────────────────────
const blockText = blocks.map((b) => lines.slice(b.start, b.end + 1).join('\n')).join('\n');
const IDENT = /[A-Za-z_$][\w$]*/g;
const referenced = new Set();
for (const m of blockText.matchAll(IDENT)) referenced.add(m[0]);
const keyword = new Set(['ipcMain', 'event', 'raw', 'error', 'const', 'let', 'await', 'async', 'try', 'catch', 'return', 'if', 'else', 'true', 'false', 'null', 'undefined', 'typeof', 'new', 'throw', 'for', 'of', 'in', 'function', 'require', 'String', 'Number', 'Boolean', 'Math', 'JSON', 'Date', 'Object', 'Array', 'Promise', 'process', 'console', 'window', 'path', 'fs', 'z', 'record']);
const deps = [...referenced].filter((n) => moduleDecls.has(n) && !keyword.has(n)).sort();
console.error('[deps] module-level references inside blocks:');
const depKinds = {};
for (const d of deps) {
  const k = moduleDecls.get(d);
  (depKinds[k] = depKinds[k] || []).push(d);
}
for (const [k, names] of Object.entries(depKinds)) console.error(`  ${k}: ${names.join(', ')}`);

// ── emit skeleton ────────────────────────────────────────────
const transformedBlocks = blocks.map((b) => {
  const text = lines.slice(b.start, b.end + 1).join('\n');
  // dedent one level (blocks inside setupIPC are indented 2)
  return text.split('\n').map((l) => (l.startsWith('  ') ? l.slice(2) : l)).join('\n');
});
const skeleton = transformedBlocks.join('\n\n');
fs.writeFileSync(`logs/migrate-${owner}-block.txt`, skeleton);
console.error(`[emit] logs/migrate-${owner}-block.txt written (${skeleton.split('\n').length} lines)`);

// ── replacement line ranges (for the apply step) ─────────────
fs.writeFileSync(`logs/migrate-${owner}-ranges.json`, JSON.stringify({
  owner,
  prefixes,
  blocks: blocks.map((b) => ({ start: b.start, end: b.end, channels: b.channels })),
}, null, 1));
console.error(`[emit] logs/migrate-${owner}-ranges.json`);
