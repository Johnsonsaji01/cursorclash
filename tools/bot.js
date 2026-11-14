'use strict';
// Fills a running CursorClash server with wandering test players (for local load testing only).
// Start the server with HUMAN_CHECK=off MAX_PLAYERS_PER_IP=50 so bots only need the proof-of-work:
//   HUMAN_CHECK=off MAX_PLAYERS_PER_IP=50 npm start
//   node tools/bot.js http://localhost:3000 5 [world]
const crypto = require('node:crypto');
const base = (process.argv[2] || 'http://localhost:3000').replace(/\/$/, '');
const count = parseInt(process.argv[3], 10) || 3;
const worldId = process.argv[4] || 'w1';
const NAMES = ['Zap', 'Nova', 'Pixel', 'Glitch', 'Byte', 'Echo', 'Flux', 'Orbit'];

async function post(route, body) {
  const res = await fetch(base + '/api/' + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, data: await res.json().catch(() => null) };
}
function pow(salt, bits) {
  for (let n = 0; ; n++) {
    const d = crypto.createHash('sha256').update(salt + ':' + n).digest();
    let ok = true, b = bits;
    for (let i = 0; b > 0; i++) { if (b >= 8) { if (d[i]) { ok = false; break; } b -= 8; } else { if (d[i] >> (8 - b)) ok = false; b = 0; } }
    if (ok) return n;
  }
}
async function ticket() {
  const ch = (await post('challenge', {})).data;
  const r = await post('verify', { ch: ch.ch, nonce: pow(ch.salt, ch.bits) });
  if (!r.data || !r.data.ticket) throw new Error('verify failed (' + r.status + ') — start the server with HUMAN_CHECK=off');
  return r.data.ticket;
}

async function runBot(n, tk) {
  let me, seq = 0, rv = 0, pv = 0, aid = 0, strokeId = 0;
  const join = async () => {
    const r = await post('join', { ticket: tk, name: NAMES[n % NAMES.length], world: worldId });
    if (r.status !== 200) throw new Error('join failed: ' + JSON.stringify(r.data));
    me = r.data; seq = me.seq; rv = me.rv;
  };
  await join();
  const phase = Math.random() * 6.28, cx = 300 + Math.random() * 1000, cy = 200 + Math.random() * 500;
  const t0 = Date.now();
  for (;;) {
    const t = (Date.now() - t0) / 1000;
    const x = cx + Math.cos(t * 0.7 + phase) * 260, y = cy + Math.sin(t * 0.9 + phase) * 160;
    const a = [];
    if (Math.random() < 0.08) a.push({ i: ++aid, t: 'atk' });
    if (Math.random() < 0.03) a.push({ i: ++aid, t: 'heal' });
    if (Math.random() < 0.02) a.push({ i: ++aid, t: 'draw', k: ++strokeId, s: 'circle', p: [[x, y], [x + 40, y]], d: 1 });
    const r = await post('sync', { id: me.id, token: me.token, x, y, a, since: seq, rv, pv });
    if (r.status === 410) { await join(); continue; }
    if (r.data) { seq = r.data.seq; if (r.data.rv) rv = r.data.rv; }
    await new Promise(res => setTimeout(res, 60));
  }
}
(async () => {
  const tk = await ticket();
  for (let i = 0; i < count; i++) runBot(i, tk).catch(e => console.error('bot', i, e.message));
  console.log('Started ' + count + ' bots in ' + worldId + ' against ' + base);
})().catch(e => { console.error(e.message); process.exit(1); });
