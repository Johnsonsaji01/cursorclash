'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { start, DEFAULTS } = require('../server.js');

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function withServer(config, fn) {
  const g = await start({ port: 0, host: '127.0.0.1', config });
  try { await fn(g, 'http://127.0.0.1:' + g.port); }
  finally { await g.close(); }
}

async function raw(base, path, method, body) {
  const res = await fetch(base + path, {
    method, redirect: 'manual',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body))
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* not json */ }
  return { status: res.status, text, json, headers: res.headers };
}

// A tiny client that speaks the same protocol as public/index.html.
class Client {
  constructor(base, prefix = '') { this.base = base + prefix; this.aid = 0; this.seq = 0; this.rv = 0; this.events = []; this.players = new Map(); this.roster = new Map(); this.strokes = []; }
  async join(name) {
    const r = await raw(this.base, '/api/join', 'POST', { name });
    if (r.status !== 200) return r;
    this.id = r.json.id; this.token = r.json.token; this.color = r.json.color; this.name = r.json.name;
    this.apply(r.json);
    return r;
  }
  apply(d) {
    this.seq = d.seq;
    if (d.roster) { this.roster = new Map(d.roster.map(r => [r[0], { id: r[0], name: r[1], color: r[2], kills: r[3], deaths: r[4] }])); this.rv = d.rv; }
    this.players = new Map(d.players.map(p => [p[0], { id: p[0], x: p[1], y: p[2], hp: p[3], mana: p[4], dead: p[5], shield: p[6] }]));
    this.you = d.you; this.full = !!d.full;
    if (d.strokes) this.strokes = d.strokes;
    for (const ev of d.events) this.events.push(ev);
    this.last = d;
  }
  action(a) { return Object.assign({ i: ++this.aid }, a); }
  async sync(x, y, actions = [], extra = {}) {
    const r = await raw(this.base, '/api/sync', 'POST', Object.assign({ id: this.id, token: this.token, x, y, a: actions, since: this.seq, rv: this.rv }, extra));
    if (r.status === 200) this.apply(r.json);
    return r;
  }
  me() { return this.players.get(this.id); }
}

// ---------------------------------------------------------------- basics

test('defaults match the v1.1 design (healing, drawing fade)', () => {
  assert.equal(DEFAULTS.HEAL_AMOUNT, 35);
  assert.equal(DEFAULTS.HEAL_COST, 25);
  assert.equal(DEFAULTS.HEAL_CD, 4.5);
  assert.equal(DEFAULTS.DRAW_FADE, 3.5);
});

test('two players join, get unique ids/colors and see each other move', async () => {
  await withServer({ SHIELD: 0 }, async (g, base) => {
    const a = new Client(base), b = new Client(base);
    const ja = await a.join('<b>Alice</b>   ');
    const jb = await b.join('Bob');
    assert.equal(ja.status, 200); assert.equal(jb.status, 200);
    assert.notEqual(a.id, b.id);
    assert.notEqual(a.color, b.color);
    assert.equal(a.name, 'bAlice/b');                    // "<" and ">" stripped, whitespace trimmed
    assert.equal(b.players.size, 2);

    await a.sync(100.4, 200.6);
    await b.sync(900, 500);
    assert.equal(b.players.get(a.id).x, 100.4);
    assert.equal(b.players.get(a.id).y, 200.6);
    assert.equal(b.roster.get(a.id).name, a.name);

    await a.sync(150, 250);                      // a sees b's last position as well
    assert.equal(a.players.get(b.id).x, 900);
    // position is clamped to the arena
    await a.sync(-50, 99999);
    assert.equal(a.me().x, 0); assert.equal(a.me().y, DEFAULTS.H);
  });
});

test('empty name falls back to a generated one; server rejects bad requests', async () => {
  await withServer({}, async (g, base) => {
    const a = new Client(base);
    await a.join('   ');
    assert.match(a.name, /^Player\d{4}$/);
    assert.equal((await raw(base, '/api/sync', 'POST', '{not json')).status, 400);
    assert.equal((await raw(base, '/api/sync', 'POST', { id: a.id, token: 'wrong' })).status, 410);
    assert.equal((await raw(base, '/api/sync', 'GET')).status, 405);
  });
});

// ---------------------------------------------------------------- combat

test('attack damages players in range, not out of range, and costs mana', async () => {
  await withServer({ SHIELD: 0 }, async (g, base) => {
    const a = new Client(base), b = new Client(base), c = new Client(base);
    await a.join('A'); await b.join('B'); await c.join('C');
    await b.sync(120, 100); await c.sync(800, 700);
    await a.sync(100, 100, [a.action({ t: 'atk' })]);
    await b.sync(120, 100); await c.sync(800, 700);
    assert.equal(b.me().hp, 100 - DEFAULTS.ATTACK_DMG);
    assert.equal(c.me().hp, 100);                             // too far away
    assert.ok(a.me().mana <= 100 - DEFAULTS.ATTACK_COST + 1);  // paid 5 mana (plus a sliver of regen)
    assert.ok(b.events.some(e => e.e === 'hit' && e.id === b.id && e.by === a.id && e.dmg === DEFAULTS.ATTACK_DMG));
    assert.ok(c.events.some(e => e.e === 'atk' && e.id === a.id));   // everybody sees the swing
  });
});

test('attack cooldown stops spam; retried action ids are not applied twice', async () => {
  await withServer({ SHIELD: 0 }, async (g, base) => {
    const a = new Client(base), b = new Client(base);
    await a.join('A'); await b.join('B');
    await b.sync(110, 100);
    const first = a.action({ t: 'atk' });
    await a.sync(100, 100, [first]);
    await a.sync(100, 100, [first]);                          // duplicate (same id) — ignored
    await a.sync(100, 100, [a.action({ t: 'atk' })]);         // new id but still on cooldown — ignored
    await b.sync(110, 100);
    assert.equal(b.me().hp, 100 - DEFAULTS.ATTACK_DMG);
    await sleep(DEFAULTS.ATTACK_CD * 1000 + 80);
    await a.sync(100, 100, [a.action({ t: 'atk' })]);         // cooldown over
    await b.sync(110, 100);
    assert.equal(b.me().hp, 100 - 2 * DEFAULTS.ATTACK_DMG);
  });
});

test('spawn protection blocks damage until it runs out', async () => {
  await withServer({ SHIELD: 0.4 }, async (g, base) => {
    const a = new Client(base), b = new Client(base);
    await a.join('A'); await b.join('B');
    await b.sync(110, 100);
    await a.sync(100, 100, [a.action({ t: 'atk' })]);
    await b.sync(110, 100);
    assert.equal(b.me().hp, 100);
    assert.equal(b.me().shield, 1);
    await sleep(450);
    await sleep(DEFAULTS.ATTACK_CD * 1000);
    await a.sync(100, 100, [a.action({ t: 'atk' })]);
    await b.sync(110, 100);
    assert.equal(b.me().hp, 100 - DEFAULTS.ATTACK_DMG);
  });
});

test('healing restores 35 HP for 25 mana, then has a cooldown; no cost at full HP', async () => {
  await withServer({ SHIELD: 0, ATTACK_DMG: 40, ATTACK_CD: 0.02 }, async (g, base) => {
    const a = new Client(base), b = new Client(base);
    await a.join('A'); await b.join('B');
    await b.sync(110, 100);

    await b.sync(110, 100, [b.action({ t: 'heal' })]);        // already at full HP: nothing happens
    assert.ok(b.me().mana >= 99);
    assert.equal(b.you.hc, 0);

    await a.sync(100, 100, [a.action({ t: 'atk' })]);
    await b.sync(110, 100);
    assert.equal(b.me().hp, 60);
    const manaBefore = b.me().mana;

    await b.sync(110, 100, [b.action({ t: 'heal' })]);
    assert.equal(b.me().hp, 95);                              // +35
    assert.ok(manaBefore - b.me().mana >= 24 && manaBefore - b.me().mana <= 25.5);
    assert.ok(b.you.hc > 4 && b.you.hc <= 4.5);
    assert.ok(b.events.some(e => e.e === 'heal' && e.id === b.id && e.amt === 35));

    await sleep(60);
    await a.sync(100, 100, [a.action({ t: 'atk' })]);         // hurt again, then try to heal during cooldown
    await b.sync(110, 100, [b.action({ t: 'heal' })]);
    assert.equal(b.me().hp, 55);                              // 95 - 40, heal refused
  });
});

test('kills are scored, the dead are untouchable, then respawn at full HP', async () => {
  await withServer({ SHIELD: 0, ATTACK_DMG: 40, ATTACK_CD: 0.02, RESPAWN: 0.4 }, async (g, base) => {
    const a = new Client(base), b = new Client(base);
    await a.join('A'); await b.join('B');
    await b.sync(110, 100);
    for (let i = 0; i < 3; i++) {
      await a.sync(100, 100, [a.action({ t: 'atk' })]);
      await sleep(40);
    }
    await b.sync(110, 100);
    assert.equal(b.me().dead, 1);
    assert.equal(b.me().hp, 0);
    assert.ok(b.you.rs > 0);
    assert.equal(b.roster.get(a.id).kills, 1);
    assert.equal(b.roster.get(b.id).deaths, 1);
    assert.ok(b.events.some(e => e.e === 'kill' && e.killer === a.id && e.victim === b.id));

    await a.sync(100, 100, [a.action({ t: 'atk' })]);         // hitting a dead player does nothing
    await b.sync(500, 500);
    assert.equal(b.roster.get(a.id).kills, 1);
    assert.equal(b.me().x, 110);                              // dead cursors don't move

    await sleep(500);
    await b.sync(500, 500);
    assert.equal(b.me().dead, 0);
    assert.equal(b.me().hp, 100);
    assert.equal(b.me().x, 500);                              // respawns where the player's cursor is
  });
});

// ---------------------------------------------------------------- drawing

test('drawings are shared, stream in pieces, and expire for everyone', async () => {
  await withServer({ DRAW_FADE: 0.3 }, async (g, base) => {
    const a = new Client(base), b = new Client(base);
    await a.join('A'); await b.join('B');
    await b.sync(0, 0);

    // freehand stroke in two chunks, then finished
    await a.sync(10, 10, [a.action({ t: 'draw', k: 1, s: 'free', p: [[10, 10], [20, 15]], d: 0 })]);
    await b.sync(0, 0);
    let ev = b.events.filter(e => e.e === 'stroke' && e.owner === a.id);
    assert.equal(ev.length, 1);
    assert.deepEqual(ev[0].pts, [[10, 10], [20, 15]]);
    assert.equal(ev[0].c, a.color);

    await a.sync(30, 20, [a.action({ t: 'draw', k: 1, s: 'free', p: [[30, 20]], d: 1 })]);
    // plus a rectangle and a circle
    await a.sync(0, 0, [
      a.action({ t: 'draw', k: 2, s: 'rect', p: [[100, 100], [300, 200]], d: 1 }),
      a.action({ t: 'draw', k: 3, s: 'circle', p: [[500, 400], [560, 400]], d: 1 })
    ]);
    await b.sync(0, 0);
    ev = b.events.filter(e => e.e === 'stroke' && e.owner === a.id);
    assert.ok(ev.some(e => e.sh === 'rect' && e.rep && e.pts[1][0] === 300));
    assert.ok(ev.some(e => e.sh === 'circle'));
    assert.ok(ev.filter(e => e.d === 1).length >= 3);

    // a late joiner sees the live drawings in the initial snapshot
    const c = new Client(base);
    await c.join('C');
    assert.equal(c.strokes.length, 3);
    assert.ok(c.strokes.every(s => s.age >= 0));

    // finished drawings are immutable
    await a.sync(0, 0, [a.action({ t: 'draw', k: 2, s: 'rect', p: [[1, 1], [2, 2]], d: 1 })]);
    assert.deepEqual(g.state.strokes.get(a.id + ':2').pts, [[100, 100], [300, 200]]);

    // ...and they disappear after DRAW_FADE (+ grace)
    await sleep(1000);
    assert.equal(g.state.strokes.size, 0);
    const d = new Client(base);
    await d.join('D');
    assert.equal(d.strokes.length, 0);
  });
});

test('drawing input is validated and capped', async () => {
  await withServer({ MAX_STROKES_PER_PLAYER: 2, MAX_STROKE_POINTS: 5 }, async (g, base) => {
    const a = new Client(base);
    await a.join('A');
    await a.sync(0, 0, [
      a.action({ t: 'draw', k: 1, s: 'free', p: [[1, 1], [2, 2], [3, 3], [4, 4], [5, 5], [6, 6], [7, 7]], d: 0 }),  // only 5 points kept
      a.action({ t: 'draw', k: 2, s: 'banana', p: [[1, 1]], d: 0 }),                                               // bad shape
      a.action({ t: 'draw', k: 3, s: 'line', p: [['x', 1], [2, 2]], d: 0 }),                                       // bad points
      a.action({ t: 'draw', k: 4, s: 'line', p: [[-100, 99999], [2, 2]], d: 0 }),                                  // clamped
      a.action({ t: 'draw', k: 5, s: 'line', p: [[1, 1], [2, 2]], d: 0 })                                          // over the per-player cap
    ]);
    assert.equal(g.state.strokes.get(a.id + ':1').pts.length, 5);
    assert.equal(g.state.strokes.has(a.id + ':2'), false);
    assert.deepEqual(g.state.strokes.get(a.id + ':4').pts[0], [0, DEFAULTS.H]);
    assert.equal(g.state.strokes.has(a.id + ':5'), false);
  });
});

// ---------------------------------------------------------------- lifecycle

test('idle players are dropped, leaving works, and the server can fill up', async () => {
  await withServer({ IDLE_MS: 300, MAX_PLAYERS: 2 }, async (g, base) => {
    const a = new Client(base), b = new Client(base), c = new Client(base);
    await a.join('A'); await b.join('B');
    assert.equal((await c.join('C')).status, 503);

    for (let i = 0; i < 6; i++) { await b.sync(5, 5); await sleep(100); }   // b keeps polling, a doesn't
    assert.equal(b.players.has(a.id), false);
    assert.ok(b.events.some(e => e.e === 'leave' && e.n === 'A'));
    assert.equal((await a.sync(1, 1)).status, 410);                         // a must rejoin

    assert.equal((await raw(base, '/api/leave', 'POST', { id: b.id, token: b.token })).status, 200);
    assert.equal(g.state.players.size, 0);
    assert.equal((await c.join('C')).status, 200);
  });
});

test('a client that fell behind the event log gets a full resync', async () => {
  await withServer({ EVENT_KEEP: 0.2 }, async (g, base) => {
    const a = new Client(base), b = new Client(base);
    await a.join('A'); await b.join('B');
    await a.sync(0, 0, [a.action({ t: 'draw', k: 1, s: 'line', p: [[1, 1], [9, 9]], d: 0 })]);
    await sleep(500);                                          // events are trimmed, b never synced
    await b.sync(0, 0);
    assert.equal(b.full, true);
    assert.equal(b.strokes.length, 1);
    await b.sync(0, 0);                                        // caught up again: normal delta
    assert.equal(b.full, false);
  });
});

// ---------------------------------------------------------------- http

test('serves the game at / and /cursorclash/, redirects /cursorclash, exposes /healthz', async () => {
  await withServer({}, async (g, base) => {
    const root = await raw(base, '/', 'GET');
    assert.equal(root.status, 200);
    assert.match(root.headers.get('content-type'), /text\/html/);
    assert.match(root.text, /CursorClash/);
    assert.match(root.text, /requestAnimationFrame/);

    const pref = await raw(base, '/cursorclash/', 'GET');
    assert.equal(pref.status, 200);
    assert.equal(pref.text, root.text);

    const bare = await raw(base, '/cursorclash?name=Zed', 'GET');
    assert.equal(bare.status, 301);
    assert.equal(bare.headers.get('location'), '/cursorclash/?name=Zed');

    assert.equal((await raw(base, '/healthz', 'GET')).text, 'ok');
    assert.equal((await raw(base, '/nope', 'GET')).status, 404);
  });
});

test('whole game works under the /cursorclash prefix', async () => {
  await withServer({ SHIELD: 0 }, async (g, base) => {
    const a = new Client(base, '/cursorclash'), b = new Client(base, '/cursorclash');
    assert.equal((await a.join('A')).status, 200);
    await b.join('B');
    await b.sync(110, 100);
    await a.sync(100, 100, [a.action({ t: 'atk' })]);
    await b.sync(110, 100);
    assert.equal(b.me().hp, 100 - DEFAULTS.ATTACK_DMG);
  });
});
