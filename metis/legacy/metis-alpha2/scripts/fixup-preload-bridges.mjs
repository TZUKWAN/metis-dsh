// Fixup pass for generated electron/preload/*Bridge.ts files (Task 3 §5):
//  - dedupe the hardcoded `import { ipcRenderer } from 'electron'`;
//  - recompute schema/decode imports from the full (multi-line aware)
//    preload.ts import block;
//  - rewrite dynamic `import('../engine/...')` type references for the
//    deeper directory;
//  - indent method bodies one level so they read as object properties.
import fs from 'node:fs';

const preloadSrc = fs.readFileSync('electron/preload.ts', 'utf8');
const importSection = preloadSrc.slice(0, preloadSrc.indexOf('const api'));

// full import inventory (multi-line aware)
const inventory = [];
{
  const re = /import\s*\{([^}]+)\}\s*from\s*'([^']+)';?/g;
  let m;
  while ((m = re.exec(importSection))) {
    const names = m[1].split(',').map((s) => s.trim()).filter(Boolean);
    for (const n of names) inventory.push({ name: n, module: m[2] });
  }
}
console.log(`[fixup] inventory: ${inventory.length} imported names`);

for (const file of fs.readdirSync('electron/preload')) {
  if (!file.endsWith('.ts')) continue;
  const path = `electron/preload/${file}`;
  let src = fs.readFileSync(path, 'utf8');

  // 1) dedupe electron ipcRenderer import
  const lines = src.split('\n');
  const electronIdx = lines.map((l, i) => [l, i]).filter(([l]) => l.trim() === "import { ipcRenderer } from 'electron';").map(([, i]) => i);
  for (const i of electronIdx.slice(1)) lines[i] = null;
  src = lines.map((l) => (l === null ? '' : l)).join('\n');

  // 2) collect identifiers referenced by the current method bodies
  const bodyStart = src.indexOf('export const');
  const body = src.slice(bodyStart);
  const needed = new Set();
  for (const item of inventory) {
    if (item.module === 'electron') continue;
    if (item.module.startsWith('./preload/') || item.module.startsWith('./ipc/')) continue;
    const local = item.name.includes(' as ') ? item.name.split(' as ')[1].trim() : item.name.replace(/^type\s+/, '');
    if (!local) continue;
    if (new RegExp(`\\b${local.replace(/[$]/g, '\\$')}\\b`).test(body)) needed.add(item);
  }
  // emit grouped imports
  const byModule = new Map();
  for (const item of needed) {
    if (!byModule.has(item.module)) byModule.set(item.module, []);
    byModule.get(item.module).push(item.name);
  }
  const importLines = [];
  for (const [module, names] of byModule) {
    const rewritten = module.startsWith('../')
      ? `'../${module}'`
      : module.startsWith('./')
        ? `'../${module.slice(2)}'`
        : `'${module}'`;
    importLines.push(`import { ${names.join(', ')} } from ${rewritten};`);
  }
  // replace everything before `export const` with a fresh header
  const header = [
    '/**',
    ` * ${file} — Task 3 §5 preload domain split.`,
    ' * Mechanical extraction from electron/preload.ts; method bodies unchanged.',
    ' */',
    '',
    "import { ipcRenderer } from 'electron';",
    ...importLines,
    '',
    '',
  ].join('\n');
  src = header + body;

  // 3) rewrite dynamic import() type refs inside bodies for the deeper dir
  src = src.replace(/import\('\.\.\/(engine|vendor)\//g, "import('../../$1/");
  src = src.replace(/import\('\.\//g, "import('../");

  // 4) indent body lines by 2 (skip the `export const ... = {` line and final `};`)
  const srcLines = src.split('\n');
  const exportIdx = srcLines.findIndex((l) => l.startsWith('export const'));
  for (let i = exportIdx + 1; i < srcLines.length; i++) {
    if (srcLines[i].trim() === '};') break;
    if (srcLines[i].trim() !== '') srcLines[i] = `  ${srcLines[i]}`;
  }
  fs.writeFileSync(path, srcLines.join('\n'));
  console.log(`[fixup] ${file}: ${importLines.length} import statements, body indented`);
}
console.log('[fixup] done');
