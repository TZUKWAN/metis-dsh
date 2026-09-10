// IPC inventory scanner — extracts every ipcMain.handle registration from
// electron/main.ts plus event-forwarding senders, grouped by channel domain.
// Output: logs/ipc-inventory-raw.json (channel-level) and a domain summary to stdout.
import fs from 'node:fs';

const src = fs.readFileSync('electron/main.ts', 'utf8');
const lines = src.split(/\r?\n/);

const items = [];
const QUOTE = "['\"`]";
lines.forEach((l, i) => {
  const re = new RegExp(`ipcMain\\.handle\\(\\s*(${QUOTE})([^'"\`]+)\\1`, 'g');
  let m;
  while ((m = re.exec(l))) items.push({ line: i + 1, ch: m[2] });
});
// multi-line registrations: channel on the following line
lines.forEach((l, i) => {
  if (/ipcMain\.handle\(\s*$/.test(l.trim())) {
    const next = lines[i + 1] || '';
    const m = next.match(new RegExp(`^\\s*(${QUOTE})([^'"\`]+)\\1`));
    if (m) items.push({ line: i + 1, ch: m[2], multiline: true });
  }
});
items.sort((a, b) => a.line - b.line);

// event forwarding: find helper-style senders
const senders = [];
lines.forEach((l, i) => {
  if (/webContents\.send\(/.test(l) || /\.send\((['"`])[a-zA-Z][^'"`]*\1/.test(l)) {
    senders.push({ line: i + 1, text: l.trim().slice(0, 160) });
  }
});

const domains = {};
for (const it of items) {
  const d = it.ch.split(':')[0];
  (domains[d] = domains[d] || []).push(it.ch);
}
const domArr = Object.entries(domains)
  .map(([d, arr]) => ({ domain: d, count: arr.length, channels: [...new Set(arr)] }))
  .sort((a, b) => b.count - a.count);

const unique = new Set(items.map((i) => i.ch));
console.log('TOTAL registrations:', items.length, ' unique channels:', unique.size);
for (const d of domArr) console.log(String(d.count).padStart(4), d.domain);

fs.mkdirSync('logs', { recursive: true });
fs.writeFileSync(
  'logs/ipc-inventory-raw.json',
  JSON.stringify({ registrations: items, domains: domArr, senderSample: senders.slice(0, 40) }, null, 1),
);
console.log('sender-style lines captured:', senders.length);
console.log('wrote logs/ipc-inventory-raw.json');
