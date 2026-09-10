// Preload domain split (Task 3 §5): carve cold-domain method groups out of the
// monolithic `api` object into electron/preload/*Bridge.ts modules, and rewrite
// preload.ts to assemble them via object spread. window.metis stays identical
// (MetisAPI = typeof api). Hot-zone methods (conversation streaming, chatbot,
// scenario, office prompt, skill market, autonomous, externalRef, update) stay
// in preload.ts — they are active parallel workstreams.
//
// Usage: node scripts/split-preload.mjs --plan logs/preload-split-plan.json --apply
import fs from 'node:fs';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const planPath = args[args.indexOf('--plan') + 1];
const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
// plan: { groups: [{ file, factory, methods: [names] }...] }

const src = fs.readFileSync('electron/preload.ts', 'utf8');
const lines = src.split(/\r?\n/);

// locate api object: from `const api = {` to the last 0-indent `};` before
// contextBridge.exposeInMainWorld — robust against concurrent edits above.
const apiStartIdx = lines.findIndex((l) => l.trim() === 'const api = {');
if (apiStartIdx < 0) throw new Error('api object not found');
const exposeIdx = lines.findIndex((l) => l.includes("contextBridge.exposeInMainWorld('metis'"));
if (exposeIdx < 0) throw new Error('exposeInMainWorld not found');
let apiEnd = -1;
for (let i = exposeIdx - 1; i > apiStartIdx; i--) {
  if (lines[i].trim() === '};') { apiEnd = i; break; }
}
if (apiEnd < 0) throw new Error('api object end not found');
console.log(`[split] api object: L${apiStartIdx + 1}-L${apiEnd + 1}`);

// parse method units
const units = []; // { name, start, end (line idx, inclusive), commentStart }
for (let i = apiStartIdx + 1; i < apiEnd; i++) {
  const m = lines[i].match(/^  ([A-Za-z_$][\w$]*):/);
  if (!m) continue;
  units.push({ name: m[1], start: i });
}
for (let k = 0; k < units.length; k++) {
  units[k].end = (k + 1 < units.length ? units[k + 1].start : apiEnd) - 1;
  // trailing comma line or empty lines belong to previous unit; trim blank tail
  let e = units[k].end;
  while (e > units[k].start && lines[e].trim() === '') e--;
  units[k].end = e;
  // absorb leading comments
  let s = units[k].start;
  while (s - 1 > apiStartIdx && lines[s - 1].trim().startsWith('//')) s--;
  units[k].commentStart = s;
}
console.log(`[split] ${units.length} method units found`);

const nameToUnit = new Map(units.map((u) => [u.name, u]));
const methodToGroup = new Map();
for (const g of plan.groups) {
  for (const name of g.methods) {
    if (!nameToUnit.has(name)) { console.error(`[warn] method not found in api: ${name}`); continue; }
    methodToGroup.set(name, g.file);
  }
}
console.log(`[split] ${methodToGroup.size} methods assigned to groups`);

// import inventory of preload.ts (top-level import statements)
const importBlockEnd = lines.findIndex((l) => l.startsWith('const api'));
const importLines = lines.slice(0, importBlockEnd);
function importsFor(text) {
  // identifiers referenced in the method bodies that are imported at top
  const needed = new Set();
  for (const l of importLines) {
    const m = l.match(/^import\s+\{([^}]+)\}\s+from\s+'([^']+)';/);
    if (!m) continue;
    const names = m[1].split(',').map((s) => s.trim()).filter(Boolean);
    for (const n of names) {
      const bare = n.replace(/^type\s+/, '').replace(/\s+as\s+\w+$/, '');
      const local = n.includes(' as ') ? n.split(' as ')[1].trim() : bare;
      if (!local) continue;
      const re = new RegExp(`\\b${local.replace(/[$]/g, '\\$')}\\b`);
      if (re.test(text)) needed.add(`${n}|${m[2]}`);
    }
  }
  return [...needed];
}
function emitImportBlock(needed) {
  const byModule = new Map();
  for (const entry of needed) {
    const [names, module] = entry.split('|');
    if (!byModule.has(module)) byModule.set(module, []);
    byModule.get(module).push(names);
  }
  const out = [];
  for (const [module, names] of byModule) {
    out.push(`import { ${names.join(', ')} } from '${module}';`);
  }
  return out;
}

if (!apply) {
  const grouped = new Set(methodToGroup.keys());
  console.log('[dry-run] would move:', grouped.size, 'of', units.length, 'methods');
  for (const g of plan.groups) {
    const present = g.methods.filter((n) => nameToUnit.has(n));
    console.log(`  ${g.file}: ${present.length}/${g.methods.length} present`);
  }
  process.exit(0);
}

// ── build bridges ─────────────────────────────────────────────
fs.mkdirSync('electron/preload', { recursive: true });
const movedNames = new Set();
const bridgeFiles = [];
for (const g of plan.groups) {
  const present = g.methods.map((n) => nameToUnit.get(n)).filter(Boolean);
  if (present.length === 0) continue;
  const bodyText = present
    .map((u) => lines.slice(u.commentStart, u.end + 1).map((l) => (l.length >= 2 ? l.slice(2) : l)).join('\n'))
    .join('\n\n');
  const needed = importsFor(present.map((u) => lines.slice(u.commentStart, u.end + 1).join('\n')).join('\n'));
  // bridge files live in electron/preload/ — rewrite ../engine -> ../../engine, ./x -> ../x
  const importBlock = emitImportBlock(needed).map((l) =>
    l.replace(/from '\.\.\//, "from '../../").replace(/from '\.\//, "from '../"),
  );
  const file = `electron/preload/${g.file}`;
  // dedupe: same import line may repeat; also merge not implemented (fine for tsc? duplicate identifiers) — dedupe exact lines
  const seen = new Set();
  const deduped = importBlock.filter((l) => (seen.has(l) ? false : (seen.add(l), true)));
  const content = `/**\n * ${g.file} — Task 3 §5 preload domain split.\n * Mechanical extraction from electron/preload.ts; method bodies unchanged.\n */\n\nimport { ipcRenderer } from 'electron';\n${deduped.join('\n')}\n\nexport const ${g.factory} = {\n${bodyText}\n};\n`;
  fs.writeFileSync(file, content.endsWith('\n') ? content : `${content}\n`);
  for (const u of present) movedNames.add(u.name);
  bridgeFiles.push({ file, factory: g.factory, count: present.length });
  console.log(`[split] wrote ${file} (${present.length} methods)`);
}

// ── rewrite preload.ts api object ─────────────────────────────
// replace each moved unit with '' and inject spreads after `const api = {`
const movedUnits = units.filter((u) => movedNames.has(u.name)).sort((a, b) => b.start - a.start);
for (const u of movedUnits) {
  // also clear absorbed comment lines
  for (let i = u.commentStart; i <= u.end; i++) lines[i] = null;
}
// inject spread imports after the import block
const spreads = bridgeFiles.map((b) => `import { ${b.factory} } from './preload/${b.file.split('/').pop().replace(/\.ts$/, '')}.js';`);
lines.splice(importBlockEnd, 0, ...spreads);
// inject spreads into api object
const injectAt = lines.findIndex((l) => l.trim() === 'const api = {') + 1;
const spreadProps = bridgeFiles.map((b) => `  ...${b.factory},`);
lines.splice(injectAt, 0, ...spreadProps);
const out = lines.map((l) => (l === null ? '' : l)).join('\n').replace(/\n{3,}/g, '\n\n');
fs.writeFileSync('electron/preload.ts', out);
console.log(`[split] preload.ts rewritten; moved ${movedNames.size} methods into ${bridgeFiles.length} bridges`);
