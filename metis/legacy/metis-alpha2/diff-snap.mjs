import Database from 'better-sqlite3';
const db = new Database(process.env.DB_PATH, { readonly: true });
const a = JSON.parse(db.prepare("SELECT record_json j FROM personalization_scenario_runs WHERE run_id='scenario-chat-388420a3-c318-4794-a358-9b5ce6273593'").get().j).manifestSnapshot;
const b = JSON.parse(db.prepare("SELECT record_json j FROM personalization_scenario_runs WHERE run_id='scenario-chat-d701f24d-37a9-49ad-8408-c7d7be98502c'").get().j).manifestSnapshot;
function flat(o, p = '') { const out = {}; for (const [k, v] of Object.entries(o ?? {})) { const key = p ? `${p}.${k}` : k; if (v && typeof v === 'object' && !Array.isArray(v)) Object.assign(out, flat(v, key)); else out[key] = JSON.stringify(v); } return out; }
const fa = flat(a), fb = flat(b);
const keys = new Set([...Object.keys(fa), ...Object.keys(fb)]);
let diffCount = 0;
for (const k of [...keys].sort()) {
  if (fa[k] !== fb[k]) { console.log('DIFF', k, '\n  A:', String(fa[k]).slice(0, 120), '\n  B:', String(fb[k]).slice(0, 120)); diffCount++; if (diffCount > 8) break; }
}
console.log('total diffs shown:', diffCount, '| keys A/B:', Object.keys(fa).length, Object.keys(fb).length);
db.close();
