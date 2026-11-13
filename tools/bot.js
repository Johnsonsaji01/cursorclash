'use strict';
// Optional helper: fills a running CursorClash server with wandering test players.
//   node tools/bot.js http://localhost:3000 5
const base = (process.argv[2] || 'http://localhost:3000').replace(/\/$/, '');
const count = parseInt(process.argv[3], 10) || 3;
const NAMES = ['Zap', 'Nova', 'Pixel', 'Glitch', 'Byte', 'Echo', 'Flux', 'Orbit'];

async function post(route, body) {
  const res = await fetch(base + '/api/' + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, data: await res.json().catch(() => null) };
}

async function runBot(n) {
  let me, seq = 0, rv = 0, aid = 0, strokeId = 0;
  const join = async () => { const r = await post('join', { name: NAMES[n % NAMES.length] }); me = r.data; seq = me.seq; rv = me.rv; return me; };
  await join();
  const phase = Math.random() * 6.28, cx = 300 + Math.random() * 1000, cy = 200 + Math.random() * 500;
  const t0 = Date.now();
  for (;;) {
    const t = (Date.now() - t0) / 1000;
    const x = cx + Math.cos(t * 0.7 + phase) * 260, y = cy + Math.sin(t * 0.9 + phase) * 160;
    const a = [];
    if (Math.random() < 0.08) a.push({ i: ++aid, t: 'atk' });
    if (Math.random() < 0.03) a.push({ i: ++aid, t: 'heal' });
    if (Math.random() < 0.02) {
      const k = ++strokeId;
      a.push({ i: ++aid, t: 'draw', k, s: 'circle', p: [[x, y], [x + 40, y]], d: 1 });
    }
    const r = await post('sync', { id: me.id, token: me.token, x, y, a, since: seq, rv });
    if (r.status === 410) { await join(); continue; }
    if (r.data) { seq = r.data.seq; if (r.data.rv) rv = r.data.rv; }
    await new Promise(res => setTimeout(res, 60));
  }
}

for (let i = 0; i < count; i++) runBot(i).catch(e => { console.error('bot', i, e.message); });
console.log('Started ' + count + ' bots against ' + base);
