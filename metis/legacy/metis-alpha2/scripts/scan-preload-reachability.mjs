// Renderer-side reachability scan for every window.metis method (Task 3 §12).
import fs from 'node:fs';

const keys = JSON.parse(fs.readFileSync('tests/electron/fixtures/metis-api-snapshot.json', 'utf8'));
const files = [];
function walk(dir) {
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = `${dir}/${f.name}`;
    if (f.isDirectory()) walk(p);
    else if (/\.(ts|tsx)$/.test(f.name)) files.push(p);
  }
}
walk('src');
const contents = files.map((f) => fs.readFileSync(f, 'utf8'));
const deadList = [];
for (const k of keys) {
  const re = new RegExp(`\\b${k}\\b`);
  const hits = contents.filter((c) => re.test(c)).length;
  if (hits === 0) deadList.push(k);
}
console.log('total methods:', keys.length, ' zero-reference in src/:', deadList.length);
fs.writeFileSync('logs/preload-zero-ref.json', `${JSON.stringify(deadList, null, 1)}\n`);
