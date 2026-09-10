/* Inline step runner: node __run-step.cjs <expression-file> */
const fs = require('node:fs');
async function main() {
  const expression = fs.readFileSync(process.argv[2], 'utf-8');
  const targets = await (await fetch('http://127.0.0.1:9477/json')).json();
  const page = targets.find((t) => t.type === 'page' && t.url.startsWith('metis-app://'));
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', () => rej(new Error('ws')), { once: true }); });
  let nextId = 1; const pending = new Map();
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(String(event.data));
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  });
  const result = await new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('eval_timeout')); } }, 55000);
  });
  if (result.exceptionDetails) console.log(JSON.stringify({ error: (result.exceptionDetails.exception?.description || 'exception').slice(0, 300) }));
  else console.log(JSON.stringify(result.result.value, null, 1));
  process.exit(0);
}
main().catch((e) => { console.error('STEP_ERROR: ' + String(e.message || e)); process.exit(1); });
