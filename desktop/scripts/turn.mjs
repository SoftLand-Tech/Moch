// Drive one real chat turn against the local gateway (protocol v7 shape:
// session.create -> prompt.submit; watch notifications until completion).
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const WS = require(new URL('../../app/node_modules/ws/index.js', import.meta.url).pathname);

const info = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const url = `ws://127.0.0.1:${info.port}/api/ws?token=${encodeURIComponent(info.token)}`;
const ws = new WS(url, { maxPayload: 64 * 1024 * 1024 });
let sid = null;
let done = false;
const t0 = Date.now();
const bail = (msg) => { console.error('FAIL:', msg); process.exitCode = 1; try { ws.close(); } catch {} };

ws.on('open', () => {
  ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'session.create', params: {} }));
});
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.id === 1) {
    if (m.error) return bail(`session.create: ${JSON.stringify(m.error)}`);
    sid = (m.result && (m.result.session_id || m.result.id)) || null;
    if (!sid) return bail(`no session id in result: ${JSON.stringify(m.result).slice(0, 200)}`);
    console.log('session', sid);
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'prompt.submit', params: { session_id: sid, text: 'Reply with exactly READY-DESKTOP and nothing else' } }));
    return;
  }
  if (m.id === 2) {
    if (m.error) return bail(`prompt.submit: ${JSON.stringify(m.error)}`);
    console.log('submitted');
    return;
  }
  if (m.method === 'message.complete' || (m.method === 'event' && JSON.stringify(m.params || {}).includes('READY-DESKTOP'))) {
    done = true;
    console.log('TURN-COMPLETE at', Date.now() - t0, 'ms');
    try { ws.close(); } catch {}
    process.exit(0);
  }
});
ws.on('error', (e) => bail(e.message));
setTimeout(() => { if (!done) bail('no completion within 90s'); process.exit(2); }, 90000);
