'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const port = 31000 + Math.floor(Math.random() * 1000);
const base = `http://127.0.0.1:${port}`;
async function post(route, payload) {
  const response = await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const body = await response.json();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(body)}`);
  return body;
}
function input(p, x, y, actions = [], since = 0) {
  return { id: p.id, token: p.token, x, y, weapon: 'phantom', actions, since };
}

test('two players join, sync positions, fight, and respawn using HTTP only', { timeout: 14000 }, async t => {
  const child = spawn(process.execPath, [path.resolve(__dirname, '../server.js')], {
    env: { ...process.env, PORT: String(port) }, stdio: 'ignore'
  });
  t.after(() => child.kill());
  let ready = false;
  for (let i = 0; i < 45; i++) {
    try {
      const res = await fetch(base + '/api/health');
      if (res.ok) { ready = true; break; }
    } catch {}
    await sleep(75);
  }
  assert.ok(ready, 'server started');
  const prefixedHealth = await fetch(base + '/cursorclash/api/health');
  assert.equal(prefixedHealth.status, 200);
  const prefixRedirect = await fetch(base + '/cursorclash', { redirect: 'manual' });
  assert.equal(prefixRedirect.status, 308);
  assert.equal(prefixRedirect.headers.get('location'), '/cursorclash/');
  const prefixedPage = await fetch(base + '/cursorclash/');
  assert.equal(prefixedPage.status, 200);
  assert.match(await prefixedPage.text(), /href="\.\/style\.css"/);
  assert.equal((await fetch(base + '/cursorclash/app.js')).status, 200);
  const a = await post('/api/join', { name: 'Alpha', color: '#74f7dc' });
  const b = await post('/api/join', { name: 'Bravo', color: '#a995ff' });
  assert.ok(a.id && a.token && b.id && b.token);
  await post('/api/sync', input(a, 700, 400));
  await post('/api/sync', input(b, 720, 420));
  let state = await post('/api/sync', input(a, 700, 400, [{ seq: 1, weapon: 'phantom' }]));
  assert.equal(state.online, 2);
  assert.equal(state.players.find(p => p.id === b.id).hp, 30);
  assert.ok(state.me.mana <= 50);
  assert.ok(state.events.some(e => e.type === 'shot'));
  // Healing is a paid server-authoritative ability, with its own cooldown.
  const healed = await post('/api/sync', input(b, 720, 420, [{seq:1,kind:'heal'}]));
  assert.equal(healed.me.hp, 65);
  assert.ok(healed.me.mana <= 75);
  assert.ok(healed.events.some(e => e.type === 'heal'));
  const healingAgain = await post('/api/sync', input(b, 720, 420, [{seq:2,kind:'heal'}]));
  assert.equal(healingAgain.notice, 'Healing recharging');
  assert.equal(healingAgain.me.hp, 65);
  // Shapes are shared in normal polling responses and expire automatically.
  const drawn = await post('/api/sync', input(b, 720, 420, [{seq:3,kind:'draw',shape:'line',points:[[500,250],[700,400]]}]));
  assert.equal(drawn.drawings.length, 1);
  assert.equal(drawn.drawings[0].shape, 'line');
  assert.equal(drawn.drawings[0].color, '#a995ff');
  const visibleToA = await post('/cursorclash/api/sync', input(a, 700, 400));
  assert.equal(visibleToA.drawings.length, 1);
  await sleep(160);
  const invalid = await post('/api/sync', input(b, 720, 420, [{seq:4,kind:'draw',shape:'line',points:[[0,0],[99999,0]]}]));
  assert.equal(invalid.notice, 'Invalid drawing');
  assert.equal(invalid.drawings.length, 1);
  const immediate = await post('/api/sync', input(a, 700, 400, [{ seq: 2, weapon: 'phantom' }]));
  assert.equal(immediate.notice, 'Weapon recharging');
  assert.equal(immediate.players.find(p => p.id === b.id).hp, 65);
  await sleep(1600);
  state = await post('/api/sync', input(a, 700, 400, [{ seq: 3, weapon: 'phantom' }], state.latestEventId));
  assert.equal(state.players.find(p => p.id === b.id).alive, false);
  assert.equal(state.me.kills, 1);
  assert.ok(state.events.some(e => e.type === 'kill'));
  await sleep(3200);
  state = await post('/api/sync', input(b, 720, 420));
  assert.equal(state.me.alive, true);
  assert.equal(state.me.hp, 100);
  assert.equal(state.me.deaths, 1);
  assert.equal(state.drawings.length, 0, 'temporary marks have expired');
  await post('/api/leave', a);
  await post('/api/leave', b);
  const status = await (await fetch(base + '/api/health')).json();
  assert.equal(status.players, 0);
  assert.equal(status.protocol, 'http-polling');
});
