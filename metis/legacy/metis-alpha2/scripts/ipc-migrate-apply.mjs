// Apply a domain migration v2: re-locates EVERY block independently by channel
// scan, replaces each with its own registrar call (back-to-front so earlier
// splices never shift later anchors), extends the domain context and adds the
// import.
//
// Usage: node scripts/ipc-migrate-apply.mjs --ranges logs/migrate-<owner>-ranges.json \
//          --registrar registerXxxIpc --import './ipc/registerXxxIpc.js' \
//          [--context-entry 'service: () => service,']
import fs from 'node:fs';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const rangesPath = flag('--ranges');
const registrar = flag('--registrar');
const importPath = flag('--import');
const contextEntry = flag('--context-entry');
const migrationComment = flag('--comment') ?? '任务3：域 registrar 迁移——channel/contract/恢复形状不变，注册走 IpcRegistry。';

const ranges = JSON.parse(fs.readFileSync(rangesPath, 'utf8'));
const mainPath = 'electron/main.ts';
const lines = fs.readFileSync(mainPath, 'utf8').split(/\r?\n/);

function locateBlock(block) {
  const channelLines = block.channels
    .map((channel) => lines.findIndex((l) => l.includes(`ipcMain.handle('${channel}'`)))
    .filter((i) => i >= 0);
  if (channelLines.length === 0) throw new Error('no channel of block found: ' + block.channels.join(','));
  let start = Math.min(...channelLines);
  while (
    start - 1 >= 0
    && lines[start - 1].trim().startsWith('//')
    && !lines[start - 1].includes('任务3')
    && !lines[start - 1].includes('registrar 迁移')
  ) start--;
  let end = start;
  for (const chLine of [...new Set(channelLines)].sort((a, b) => a - b)) {
    let depth = 0;
    let sawOpen = false;
    for (let j = chLine; j < lines.length; j++) {
      for (const ch of lines[j]) {
        if (ch === '(' || ch === '{' || ch === '[') { depth++; sawOpen = true; }
        else if (ch === ')' || ch === '}' || ch === ']') depth--;
      }
      if (sawOpen && depth <= 0) { if (j > end) end = j; break; }
    }
  }
  if (!lines[end].trim().endsWith('});')) throw new Error('block end sanity failed: ' + lines[end]);
  return { start, end };
}

const located = ranges.blocks.map(locateBlock).sort((a, b) => b.start - a.start);
const replacement = [
  `  // ${migrationComment}`,
  `  ipcDomainDisposers.push(${registrar}(domainIpcContext));`,
];
for (const { start, end } of located) {
  console.log(`[apply] replacing L${start + 1}-L${end + 1}`);
  lines.splice(start, end - start + 1, ...replacement);
}

if (contextEntry) {
  const ctxIdx = lines.findIndex((l) => l.trim() === 'dataDir: () => DATA_DIR,');
  const anchor = ctxIdx >= 0 ? ctxIdx : lines.findIndex((l) => l.trim() === 'ensureTopicService,');
  if (anchor < 0) throw new Error('domainIpcContext object not found');
  lines.splice(anchor + 1, 0, `  ${contextEntry}`);
}

const impIdx = lines.findIndex((l) => l.includes("import type { DomainIpcContext }"));
if (impIdx < 0) throw new Error('DomainIpcContext import not found');
lines.splice(impIdx + 1, 0, `import { ${registrar} } from '${importPath}';`);

fs.writeFileSync(mainPath, lines.join('\n'));
console.log(`[apply] ${registrar} wired; main.ts lines: ${lines.length}`);
