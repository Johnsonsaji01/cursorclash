'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { start, DEFAULTS } = require('../server.js');
const { powOk } = require('../lib/security.js');
const COLORS = require('../lib/colors.js');

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Relaxed settings so game-logic tests aren't slowed or blocked by the anti-bot limits.
// The security tests below switch the relevant limits back on.
const TEST_CFG = {
  RATE_LIMITS: false, MAX_PLAYERS_PER_IP: 1000, POW_BITS: 4, MIN_VERIFY_MS: 0,
  MAX_SPEED: 1e9, MOVE_BURST: 1e9, AFK_ATTACKS: 1e9
};

async function withServer(config, fn, extra = {}) {
  const g = await start(Object.assign({ port: 0, host: '127.0.0.1', env: false, config: Object.assign({}, TEST_CFG, config) }, extra));
  try { await fn(g, 'http://127.0.0.1:' + g.port); }
  finally { await g.close(); }
}

async function raw(base, path, method, body, headers) {
  const res = await fetch(base + path, {
    method, redirect: 'manual',
    headers: Object.assign(body !== undefined ? { 'Content-Type': 'application/json' } : {}, headers),
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body))
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* not json */ }
  return { status: res.status, text, json, headers: res.headers };
}

// Passes the human check the way the real page does (with valid proof-of-work and a human-looking trace).
async function getTicket(base, extra = {}, headers) {
  const ch = (await raw(base, '/api/challenge', 'POST', {}, headers)).json;
  let nonce = 0;
  while (!powOk(ch.salt, nonce, ch.bits)) nonce++;
  return raw(base, '/api/verify', 'POST', Object.assign(
    { ch: ch.ch, nonce, hold: 1100, moves: 8, kind: 'pointer', pt: 'mouse', trusted: true, hp: '' }, extra), headers);
}
const ticketCache = new Map();
async function ticketFor(base) {
  if (!ticketCache.has(base)) {
    const r = await getTicket(base);
    assert.equal(r.status, 200, 'could not get a ticket: ' + r.text);
    ticketCache.set(base, r.json.ticket);
  }
  return ticketCache.get(base);
}

// A tiny client that speaks the same protocol as public/index.html.
class Client {
  constructor(base, prefix = '') { this.root = base; this.base = base + prefix; this.aid = 0; this.seq = 0; this.rv = 0; this.pv = 0; this.events = []; this.players = new Map(); this.roster = new Map(); this.strokes = []; this.portals = []; }
  async join(name, o = {}) {
    const ticket = o.ticket || await ticketFor(this.root);
    const r = await raw(this.base, '/api/join', 'POST', { ticket, name, world: o.world || 'w1', color: o.color });
    if (r.status !== 200) { this.lastError = r; return r; }
    this.id = r.json.id; this.token = r.json.token; this.color = r.json.color; this.cidx = r.json.cidx; this.name = r.json.name;
    this.world = r.json.world; this.cfg = r.json.cfg; this.ticket = ticket;
    this.seq = 0; this.rv = 0; this.pv = 0; this.events = [];
    this.apply(r.json);
    return r;
  }
  apply(d) {
    this.seq = d.seq;
    if (d.roster) { this.roster = new Map(d.roster.map(r => [r[0], { id: r[0], name: r[1], color: r[2], kills: r[3], deaths: r[4] }])); this.rv = d.rv; }
    this.players = new Map(d.players.map(p => [p[0], { id: p[0], x: p[1], y: p[2], hp: p[3], mana: p[4], dead: p[5], shield: p[6] }]));
    this.you = d.you; this.full = !!d.full; this.go = d.go || null; this.solo = d.solo; this.n = d.n;
    if (d.strokes) this.strokes = d.strokes;
    if (d.portals) { this.portals = d.portals.map(q => ({ id: q[0], kind: q[1], x: q[2], y: q[3], count: q[4], max: q[5], label: q[6], full: !!q[7] })); this.pv = d.pv; }
    for (const ev of d.events) this.events.push(ev);
    this.last = d;
  }
  action(a) { return Object.assign({ i: ++this.aid }, a); }
  async sync(x, y, actions = [], extra = {}) {
    const r = await raw(this.base, '/api/sync', 'POST', Object.assign({ id: this.id, token: this.token, x, y, a: actions, since: this.seq, rv: this.rv, pv: this.pv }, extra));
    if (r.status === 200) this.apply(r.json);
    return r;
  }
  me() { return this.players.get(this.id); }
  portal(id) { return this.portals.find(q => q.id === id); }
}

// ================================================================ basics

test('defaults match the design (healing, drawing fade, block walls, worlds)', () => {
  assert.equal(DEFAULTS.HEAL_AMOUNT, 35);
  assert.equal(DEFAULTS.HEAL_COST, 25);
  assert.equal(DEFAULTS.HEAL_CD, 4.5);
  assert.equal(DEFAULTS.DRAW_FADE, 3.5);
  assert.equal(DEFAULTS.BLOCK_LIFE, 5);
  assert.equal(DEFAULTS.MAX_PLAYERS, 30);
  assert.equal(DEFAULTS.PUBLIC_SPAWN_AT, 20);
  assert.equal(DEFAULTS.PORTAL_DWELL, 5);
  assert.equal(DEFAULTS.PRIVATE_SOLO_SEC, 300);
});

test('two players join, get unique ids/colours and see each other move', async () => {
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

    await a.sync(150, 250);
    assert.equal(a.players.get(b.id).x, 900);
    await a.sync(-50, 99999);                            // clamped to the arena
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

// ================================================================ combat

test('attack damages players in range, not out of range, and costs mana', async () => {
  await withServer({ SHIELD: 0 }, async (g, base) => {
    const a = new Client(base), b = new Client(base), c = new Client(base);
    await a.join('A'); await b.join('B'); await c.join('C');
    await b.sync(120, 100); await c.sync(800, 700);
    await a.sync(100, 100, [a.action({ t: 'atk' })]);
    await b.sync(120, 100); await c.sync(800, 700);
    assert.equal(b.me().hp, 100 - DEFAULTS.ATTACK_DMG);
    assert.equal(c.me().hp, 100);                             // too far away
    assert.ok(a.me().mana <= 100 - DEFAULTS.ATTACK_COST + 1);
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
    await a.sync(100, 100, [a.action({ t: 'atk' })]);
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
    await sleep(450 + DEFAULTS.ATTACK_CD * 1000);
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
    await a.sync(100, 100, [a.action({ t: 'atk' })]);
    await b.sync(110, 100, [b.action({ t: 'heal' })]);
    assert.equal(b.me().hp, 55);                              // 95 - 40, heal refused during cooldown
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

// ================================================================ drawing

test('drawings are shared, stream in pieces, and expire for everyone', async () => {
  await withServer({ DRAW_FADE: 0.3 }, async (g, base) => {
    const a = new Client(base), b = new Client(base);
    await a.join('A'); await b.join('B');
    await b.sync(0, 0);

    await a.sync(10, 10, [a.action({ t: 'draw', k: 1, s: 'free', p: [[10, 10], [20, 15]], d: 0 })]);
    await b.sync(0, 0);
    let ev = b.events.filter(e => e.e === 'stroke' && e.owner === a.id);
    assert.equal(ev.length, 1);
    assert.deepEqual(ev[0].pts, [[10, 10], [20, 15]]);
    assert.equal(ev[0].c, a.color);

    await a.sync(30, 20, [a.action({ t: 'draw', k: 1, s: 'free', p: [[30, 20]], d: 1 })]);
    await a.sync(0, 0, [
      a.action({ t: 'draw', k: 2, s: 'rect', p: [[100, 100], [300, 200]], d: 1 }),
      a.action({ t: 'draw', k: 3, s: 'circle', p: [[500, 400], [560, 400]], d: 1 })
    ]);
    await b.sync(0, 0);
    ev = b.events.filter(e => e.e === 'stroke' && e.owner === a.id);
    assert.ok(ev.some(e => e.sh === 'rect' && e.rep && e.pts[1][0] === 300));
    assert.ok(ev.some(e => e.sh === 'circle'));
    assert.ok(ev.filter(e => e.d === 1).length >= 3);

    const c = new Client(base);
    await c.join('C');                                        // a late joiner sees live drawings
    assert.equal(c.strokes.length, 3);
    assert.ok(c.strokes.every(s => s.age >= 0));

    await a.sync(0, 0, [a.action({ t: 'draw', k: 2, s: 'rect', p: [[1, 1], [2, 2]], d: 1 })]);   // immutable once finished
    assert.deepEqual(g.state.strokes.get(a.id + ':2').pts, [[100, 100], [300, 200]]);

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
      a.action({ t: 'draw', k: 2, s: 'banana', p: [[1, 1]], d: 0 }),
      a.action({ t: 'draw', k: 3, s: 'line', p: [['x', 1], [2, 2]], d: 0 }),
      a.action({ t: 'draw', k: 4, s: 'line', p: [[-100, 99999], [2, 2]], d: 0 }),                                  // clamped
      a.action({ t: 'draw', k: 5, s: 'line', p: [[1, 1], [2, 2]], d: 0 })                                          // over the cap
    ]);
    assert.equal(g.state.strokes.get(a.id + ':1').pts.length, 5);
    assert.equal(g.state.strokes.has(a.id + ':2'), false);
    assert.deepEqual(g.state.strokes.get(a.id + ':4').pts[0], [0, DEFAULTS.H]);
    assert.equal(g.state.strokes.has(a.id + ':5'), false);
  });
});

// ================================================================ block walls

const block = (c, k, s, p, d = 1) => c.action({ t: 'draw', k, s, p, d, b: 1 });

test('ink drawings are cosmetic: they cost nothing and never stop anyone', async () => {
  await withServer({}, async (g, base) => {
    const a = new Client(base), b = new Client(base);
    await a.join('A'); await b.join('B');
    await b.sync(100, 300);
    const manaBefore = a.me().mana;
    await a.sync(300, 300, [a.action({ t: 'draw', k: 1, s: 'line', p: [[200, 100], [200, 500]], d: 1 })]);
    assert.ok(a.me().mana >= manaBefore - 0.5);
    await b.sync(300, 300);                                      // walks straight across the ink line
    assert.equal(b.me().x, 300);
    assert.equal(g.state.strokes.get(a.id + ':1').kind, 'ink');
  });
});

test('block walls cost mana by length, are shared, and other players cannot cross them', async () => {
  await withServer({ SHIELD: 0 }, async (g, base) => {
    const a = new Client(base), b = new Client(base), c = new Client(base);
    await a.join('A'); await b.join('B'); await c.join('C');
    await a.sync(100, 100); await b.sync(100, 300); await c.sync(100, 800);
    const manaBefore = a.me().mana;

    await a.sync(100, 100, [block(a, 1, 'line', [[200, 100], [200, 500]])]);   // 400 units * 0.05 = 20 mana
    assert.ok(manaBefore - a.me().mana > 19 && manaBefore - a.me().mana < 21, 'mana drop ' + (manaBefore - a.me().mana));
    const ev = a.events.filter(e => e.e === 'stroke' && e.k === 'block');
    assert.equal(ev.length, 1);
    assert.equal(ev[0].life, 5);

    await b.sync(100, 300);
    assert.ok(b.events.some(e => e.e === 'stroke' && e.k === 'block' && e.owner === a.id));

    await b.sync(300, 300, [], { pp: [[150, 300], [199, 300]] });
    assert.ok(b.me().x < 200 && b.me().x > 190, 'b should be stopped at the wall, got x=' + b.me().x);
    await b.sync(100, 300);
    assert.equal(b.me().x, 100);
    await b.sync(400, 300);                                      // one long jump straight across is stopped too
    assert.ok(b.me().x < 200);
    await b.sync(150, 520); await b.sync(250, 520);              // going around the end works
    assert.equal(b.me().x, 250);

    await a.sync(300, 300, [], { pp: [[150, 300], [199, 300]] }); // the owner walks through their own wall
    assert.equal(a.me().x, 300);
  });
});

test('walls vanish after BLOCK_LIFE seconds and then stop blocking', async () => {
  await withServer({ SHIELD: 0, BLOCK_LIFE: 0.4 }, async (g, base) => {
    const a = new Client(base), b = new Client(base);
    await a.join('A'); await b.join('B');
    await b.sync(100, 300);
    await a.sync(0, 0, [block(a, 1, 'line', [[200, 100], [200, 500]])]);
    await b.sync(400, 300);
    assert.ok(b.me().x < 200);
    assert.equal(g.state.strokes.size, 1);

    const c = new Client(base); await c.join('C');
    const snap = c.strokes.find(s => s.k === 'block');
    assert.ok(snap && snap.rem > 0 && snap.rem <= 0.4);

    await sleep(550);
    assert.equal(g.state.strokes.size, 0);
    await b.sync(400, 300);
    assert.equal(b.me().x, 400);
    const d = new Client(base); await d.join('D');
    assert.equal(d.strokes.length, 0);
  });
});

test('walls are limited by mana: too long gets cut short, no mana means no wall', async () => {
  await withServer({ MANA_REGEN: 0 }, async (g, base) => {
    const a = new Client(base);
    await a.join('A');
    await a.sync(0, 0, [block(a, 1, 'line', [[0, 100], [1600, 100]]), block(a, 2, 'line', [[0, 300], [1400, 300]])]);
    const w1 = g.state.strokes.get(a.id + ':1');
    const len1 = Math.hypot(w1.pts[1][0] - w1.pts[0][0], w1.pts[1][1] - w1.pts[0][1]);
    assert.ok(len1 > 1590 && len1 <= 1600);                       // full wall, 80 mana
    const w2 = g.state.strokes.get(a.id + ':2');
    const len2 = Math.hypot(w2.pts[1][0] - w2.pts[0][0], w2.pts[1][1] - w2.pts[0][1]);
    assert.ok(len2 > 380 && len2 < 420, 'second wall cut to the remaining ~20 mana, got ' + len2);
    assert.ok(a.me().mana < 1);
    await a.sync(0, 0, [block(a, 3, 'line', [[0, 500], [500, 500]])]);
    assert.equal(g.state.strokes.has(a.id + ':3'), false);
  });
});

test('freehand block walls are truncated to what you can afford; tiny walls are ignored and free', async () => {
  await withServer({ MANA_REGEN: 0, BLOCK_COST_PER_UNIT: 0.5 }, async (g, base) => {
    const a = new Client(base);
    await a.join('A');
    const pts = []; for (let i = 0; i <= 6; i++) pts.push([100 + i * 100, 200]);
    await a.sync(0, 0, [block(a, 1, 'free', pts)]);
    const w = g.state.strokes.get(a.id + ':1');
    assert.equal(w.kind, 'block');
    const last = w.pts[w.pts.length - 1];
    assert.ok(Math.abs(last[0] - 300) < 0.2, 'cut at x=300, got ' + last[0]);
    assert.ok(a.me().mana < 1);

    const b = new Client(base); await b.join('B');
    const before = b.me().mana;
    await b.sync(0, 0, [block(b, 1, 'line', [[10, 10], [13, 10]])]);       // 3 units: ignored
    assert.equal(g.state.strokes.has(b.id + ':1'), false);
    assert.ok(b.me().mana >= before - 0.1);
  });
});

test('an unfinished wall is neither shown nor enforced; finishing it makes it real', async () => {
  await withServer({ SHIELD: 0, MANA_REGEN: 0 }, async (g, base) => {
    const a = new Client(base), b = new Client(base);
    await a.join('A'); await b.join('B');
    await b.sync(600, 450);
    await a.sync(0, 0, [block(a, 9, 'line', [[700, 300], [700, 600]], 0)]);
    await b.sync(650, 450);
    assert.equal(b.me().x, 650);                                  // nothing in the way yet
    assert.ok(!b.events.some(e => e.e === 'stroke' && e.key === a.id + ':9'));
    await a.sync(0, 0, [block(a, 9, 'line', [[700, 300], [700, 600]], 1)]);
    await b.sync(850, 450);
    assert.ok(b.me().x < 700 && b.me().x > 690, 'stopped at the finished wall, x=' + b.me().x);
  });
});

test('circle walls hold you in and keep you out', async () => {
  await withServer({ SHIELD: 0, MANA_REGEN: 0 }, async (g, base) => {
    const inside = new Client(base), outside = new Client(base), builder = new Client(base);
    await inside.join('In'); await outside.join('Out'); await builder.join('Build');
    await outside.sync(1300, 100);
    await builder.sync(1300, 100, [block(builder, 1, 'circle', [[800, 450], [900, 450]])]);   // radius 100 ring around the spawn point
    await inside.sync(1100, 450);                                 // trapped inside the ring
    assert.ok(inside.me().x > 800 && inside.me().x < 900, 'held in, x=' + inside.me().x);
    await outside.sync(800, 450);                                 // can't get in
    assert.ok(Math.hypot(outside.me().x - 800, outside.me().y - 450) > 99, 'kept out, at ' + outside.me().x + ',' + outside.me().y);
  });
});

test('box walls stop movement across every edge', async () => {
  await withServer({ SHIELD: 0, MANA_REGEN: 0 }, async (g, base) => {
    const d = new Client(base), a = new Client(base);
    await d.join('D'); await a.join('A');
    await d.sync(1150, 100);
    await a.sync(0, 0, [block(a, 2, 'rect', [[1000, 600], [1300, 800]])]);
    await d.sync(1150, 900);                                      // straight down through the top edge
    assert.ok(d.me().y < 600, 'stopped by the top edge, y=' + d.me().y);
    await d.sync(1500, 100); await d.sync(1500, 700);             // around the box, then in from the right
    assert.equal(d.me().x, 1500);
    await d.sync(1100, 700);
    assert.ok(d.me().x > 1300, 'stopped by the right edge, x=' + d.me().x);
  });
});

test('a dead player cannot build, and respawn does not teleport you through a wall', async () => {
  await withServer({ SHIELD: 0, ATTACK_DMG: 100, ATTACK_CD: 0.02, RESPAWN: 0.3 }, async (g, base) => {
    const a = new Client(base), b = new Client(base);
    await a.join('A'); await b.join('B');
    await b.sync(110, 100);
    await a.sync(100, 100, [a.action({ t: 'atk' })]);             // b is dead
    await b.sync(110, 100, [block(b, 1, 'line', [[500, 100], [500, 400]])]);
    assert.equal(g.state.strokes.has(b.id + ':1'), false);

    await a.sync(100, 100, [block(a, 1, 'line', [[300, 0], [300, 900]])]);
    await b.sync(600, 450);                                       // dead: the real mouse moves, the body doesn't
    assert.equal(b.me().x, 110);
    await sleep(400);
    await b.sync(600, 450);
    assert.equal(b.me().dead, 0);
    assert.ok(b.me().x < 300, 'respawn stops at the wall, x=' + b.me().x);
  });
});

// ================================================================ lifecycle

test('idle players are dropped, leaving works, and a world can fill up', async () => {
  await withServer({ IDLE_MS: 300, MAX_PLAYERS: 2 }, async (g, base) => {
    const a = new Client(base), b = new Client(base), c = new Client(base);
    await a.join('A'); await b.join('B');
    const full = await c.join('C');
    assert.equal(full.status, 409);
    assert.equal(full.json.code, 'full');

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
    await sleep(500);
    await b.sync(0, 0);
    assert.equal(b.full, true);
    assert.equal(b.strokes.length, 1);
    await b.sync(0, 0);
    assert.equal(b.full, false);
  });
});

// ================================================================ http

test('serves the game at / and /cursorclash/, redirects /cursorclash, exposes /healthz, sets security headers', async () => {
  await withServer({}, async (g, base) => {
    const root = await raw(base, '/', 'GET');
    assert.equal(root.status, 200);
    assert.match(root.headers.get('content-type'), /text\/html/);
    assert.match(root.text, /CursorClash/);
    assert.match(root.text, /requestAnimationFrame/);
    assert.match(root.headers.get('content-security-policy'), /default-src 'self'/);
    assert.equal(root.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(root.headers.get('x-frame-options'), 'DENY');

    const pref = await raw(base, '/cursorclash/', 'GET');
    assert.equal(pref.status, 200);
    assert.equal(pref.text, root.text);

    const bare = await raw(base, '/cursorclash?w=abc', 'GET');
    assert.equal(bare.status, 301);
    assert.equal(bare.headers.get('location'), '/cursorclash/?w=abc');

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

// ================================================================ colours

test('there are 30 distinct colours', () => {
  assert.equal(COLORS.length, 30);
  assert.equal(new Set(COLORS.map(c => c[1])).size, 30);
  assert.equal(new Set(COLORS.map(c => c[0])).size, 30);
  for (const c of COLORS) assert.match(c[1], /^#[0-9a-f]{6}$/);
});

test('colours are chosen per world; a taken colour is refused and shown as taken', async () => {
  await withServer({}, async (g, base) => {
    const a = new Client(base), b = new Client(base), c = new Client(base);
    assert.equal((await a.join('A', { color: 5 })).status, 200);
    assert.equal(a.cidx, 5);
    assert.equal(a.color, COLORS[5][1]);

    const dup = await b.join('B', { color: 5 });
    assert.equal(dup.status, 409);
    assert.equal(dup.json.code, 'color');
    assert.deepEqual(dup.json.taken, [5]);

    const info = await raw(base, '/api/worldinfo', 'POST', { ticket: await ticketFor(base), world: 'w1' });
    assert.deepEqual(info.json.taken, [5]);
    assert.equal(info.json.max, 30);
    assert.equal(info.json.palette.length, 30);

    assert.equal((await b.join('B', { color: 6 })).status, 200);
    await c.join('C');
    assert.equal(c.cidx, 0);                                         // no choice made: first free colour
    assert.equal((await new Client(base).join('X', { color: 99 })).status, 400);
    assert.equal((await new Client(base).join('X', { color: 1.5 })).status, 400);

    await raw(base, '/api/leave', 'POST', { id: a.id, token: a.token });   // leaving frees the colour
    const again = new Client(base);
    assert.equal((await again.join('Again', { color: 5 })).status, 200);

    const other = new Client(base);                                  // colours are per world: w2 doesn't know about w1
    g.hub.createPublic();
    assert.equal((await other.join('O', { world: 'w2', color: 5 })).status, 200);
  });
});

test('30 players fit in a world with 30 different colours, the 31st is turned away', async () => {
  await withServer({}, async (g, base) => {
    const cs = [];
    for (let i = 0; i < 30; i++) { const c = new Client(base); assert.equal((await c.join('P' + i, { color: 29 - i })).status, 200); cs.push(c); }
    assert.equal(new Set(cs.map(c => c.cidx)).size, 30);
    const extra = await new Client(base).join('Late');
    assert.equal(extra.status, 409);
    assert.equal(extra.json.code, 'full');
    const info = await raw(base, '/api/worldinfo', 'POST', { ticket: await ticketFor(base), world: 'w1' });
    assert.equal(info.json.taken.length, 30);
    await cs[0].sync(1, 1);
    assert.equal(new Set([...cs[0].roster.values()].map(r => r.color)).size, 30);
  });
});

// ================================================================ worlds

test('worlds are separate rooms: players, attacks and drawings do not cross over', async () => {
  await withServer({ SHIELD: 0 }, async (g, base) => {
    g.hub.createPublic();
    const a = new Client(base), b = new Client(base);
    await a.join('A', { world: 'w1' }); await b.join('B', { world: 'w2' });
    await b.sync(110, 100);
    await a.sync(100, 100, [a.action({ t: 'atk' }), a.action({ t: 'draw', k: 1, s: 'line', p: [[1, 1], [50, 50]], d: 1 })]);
    await b.sync(110, 100);
    assert.equal(b.me().hp, 100);
    assert.equal(b.players.size, 1);
    assert.ok(!b.events.some(e => e.e === 'atk' || e.e === 'stroke'));
    assert.equal(a.players.size, 1);
    assert.equal(a.world.id, 'w1'); assert.equal(b.world.id, 'w2'); assert.equal(b.world.name, 'World 2');
  });
});

test('the lobby is peaceful: no attacks, no heals, no walls, but ink works', async () => {
  await withServer({ SHIELD: 0 }, async (g, base) => {
    const a = new Client(base), b = new Client(base);
    await a.join('A', { world: 'lobby' }); await b.join('B', { world: 'lobby' });
    assert.equal(a.world.kind, 'lobby');
    await b.sync(800, 285);
    const mana = a.me().mana;
    await a.sync(800, 285, [a.action({ t: 'atk' }), block(a, 1, 'line', [[100, 800], [900, 800]]), a.action({ t: 'draw', k: 2, s: 'line', p: [[1, 1], [50, 50]], d: 1 })]);
    await b.sync(800, 285);
    assert.equal(b.me().hp, 100);
    assert.ok(a.me().mana >= mana - 0.2);
    assert.ok(!b.events.some(e => e.e === 'atk'));
    const lobby = g.hub.worlds.get('l1');
    assert.equal(lobby.strokes.size, 1);                            // just the ink
    assert.equal([...lobby.strokes.values()][0].kind, 'ink');
  });
});

test('lobby lists a portal per public world plus the random and private portals', async () => {
  await withServer({}, async (g, base) => {
    g.hub.createPublic(); g.hub.createPublic();
    g.hub.tick(); g.hub.lastSlow = 0; g.hub.tick();                 // refresh the portal layout
    const a = new Client(base);
    await a.join('A', { world: 'lobby' });
    const ids = a.portals.map(q => q.id);
    assert.deepEqual(ids.slice(0, 2), ['rand', 'priv']);
    assert.deepEqual(ids.slice(2), ['w1', 'w2', 'w3']);
    const rand = a.portal('rand'), priv = a.portal('priv');
    assert.ok(rand.y < a.portal('w1').y && priv.y < a.portal('w1').y);          // random portal is at the top
    assert.equal(rand.x, 800);
    assert.equal(a.portal('w1').max, 30);
    // live counts: a second client joins w1 and the lobby sees "1/30" after the next refresh
    const p = new Client(base); await p.join('P', { world: 'w1' });
    await sleep(1200);
    await a.sync(800, 285);
    assert.equal(a.portal('w1').count, 1);
    assert.equal(a.portal('rand').count, 1);
  });
});

test('hovering a portal for PORTAL_DWELL seconds sends you there; moving away resets it', async () => {
  await withServer({ PORTAL_DWELL: 0.5 }, async (g, base) => {
    const a = new Client(base);
    await a.join('A', { world: 'lobby' });
    const w1 = a.portal('w1');
    await a.sync(w1.x, w1.y);
    await sleep(200);
    await a.sync(w1.x + 10, w1.y - 10);
    assert.equal(a.you.pt[0], 'w1');
    assert.ok(a.you.pt[1] > 0 && a.you.pt[1] < 1);
    assert.equal(a.go, null);

    await a.sync(800, 285);                                          // wandered off: progress resets on the next server tick
    await sleep(120);
    await a.sync(800, 285);
    assert.equal(a.you.pt, null);
    await a.sync(w1.x, w1.y);
    await sleep(700);
    await a.sync(w1.x, w1.y);
    assert.deepEqual(a.go, { k: 'world', w: 'w1', n: 'World 1' });
    await a.sync(w1.x, w1.y);
    assert.equal(a.go, null);                                        // delivered once
  });
});

test('the random portal picks a real public world that has room', async () => {
  await withServer({ PORTAL_DWELL: 0.3, MAX_PLAYERS: 2, PUBLIC_SPAWN_AT: 1 }, async (g, base) => {
    const f1 = new Client(base), f2 = new Client(base);
    await f1.join('F1', { world: 'w1' }); await f2.join('F2', { world: 'w1' });   // w1 is full (2/2) and has spawned w2
    assert.deepEqual(g.hub.publicWorlds().map(w => w.id), ['w1', 'w2']);
    await f1.sync(1, 1); await f2.sync(1, 1);
    const a = new Client(base);
    await a.join('A', { world: 'lobby' });
    const r = a.portal('rand');
    await a.sync(r.x, r.y);
    await sleep(450);
    await a.sync(r.x, r.y);
    assert.equal(a.go.k, 'world');
    assert.equal(a.go.w, 'w2');                                      // w1 is full, so the only open world
    // full worlds show as full and cannot be entered by portal
    assert.equal(a.portal('w1').full, true);
  });
});

test('the private-world portal asks the client to create one', async () => {
  await withServer({ PORTAL_DWELL: 0.3 }, async (g, base) => {
    const a = new Client(base);
    await a.join('A', { world: 'lobby' });
    const q = a.portal('priv');
    await a.sync(q.x, q.y);
    await sleep(450);
    await a.sync(q.x, q.y);
    assert.deepEqual(a.go, { k: 'private' });
  });
});

test('a new public world is generated when one goes over 20 players (and extras are cleaned up)', async () => {
  await withServer({ PUBLIC_SPAWN_AT: 2, MAX_PLAYERS: 5, PUBLIC_EMPTY_SEC: 0.3 }, async (g, base) => {
    const ids = () => g.hub.publicWorlds().map(w => w.id);
    const cs = [];
    const add = async (w) => { const c = new Client(base); const r = await c.join('P', { world: w }); assert.equal(r.status, 200); cs.push(c); return c; };
    await add('w1'); await add('w1');
    assert.deepEqual(ids(), ['w1']);                                  // 2 players: not over the limit yet
    await add('w1');
    assert.deepEqual(ids(), ['w1', 'w2']);                            // 3 > 2: World 2 appears
    await add('w1');
    assert.deepEqual(ids(), ['w1', 'w2']);                            // World 2 still has room, no need for another
    await add('w2'); await add('w2');
    assert.deepEqual(ids(), ['w1', 'w2']);
    await add('w2');
    assert.deepEqual(ids(), ['w1', 'w2', 'w3']);                      // World 2 went over too

    for (const c of cs.filter(c => c.world.id !== 'w1')) await raw(base, '/api/leave', 'POST', { id: c.id, token: c.token });
    await sleep(1800);                                                // lifecycle runs once a second
    assert.deepEqual(ids(), ['w1']);                                  // empty extras removed, World 1 always stays
  });
});

test('lobbies are sharded: a full lobby opens another instance', async () => {
  await withServer({ LOBBY_MAX: 2 }, async (g, base) => {
    const cs = [new Client(base), new Client(base), new Client(base)];
    for (const c of cs) assert.equal((await c.join('L', { world: 'lobby' })).status, 200);
    assert.equal(g.hub.worlds.has('l2'), true);
    assert.equal(g.hub.worlds.get('l1').count(), 2);
    assert.equal(g.hub.worlds.get('l2').count(), 1);
    assert.equal((await new Client(base).join('X', { world: 'l1' })).status, 404);   // lobby instances aren't addressable
  });
});

// ================================================================ private worlds

async function newPrivate(base, ticket) {
  const r = await raw(base, '/api/newprivate', 'POST', { ticket: ticket || await ticketFor(base) });
  return r;
}

test('private worlds: created on request, joined by code, hidden from the lobby, unknown codes refused', async () => {
  await withServer({ SHIELD: 0 }, async (g, base) => {
    const r = await newPrivate(base);
    assert.equal(r.status, 200);
    const code = r.json.code;
    assert.match(code, /^[a-z2-9]{8}$/);

    const a = new Client(base), b = new Client(base);
    assert.equal((await a.join('A', { world: code, color: 3 })).status, 200);
    assert.equal(a.world.kind, 'private');
    assert.equal((await b.join('B', { world: code.toUpperCase(), color: 3 })).json.code, 'color');   // codes are case-insensitive; colours still unique
    assert.equal((await b.join('B', { world: code.toUpperCase(), color: 4 })).status, 200);

    const info = await raw(base, '/api/worldinfo', 'POST', { ticket: await ticketFor(base), world: code });
    assert.equal(info.json.count, 2);
    assert.deepEqual(info.json.taken.sort(), [3, 4]);

    const lobby = new Client(base);
    await lobby.join('L', { world: 'lobby' });
    assert.ok(!lobby.portals.some(q => q.id === code));              // private worlds never show up as portals
    assert.equal(g.hub.pickRandomWorld().kind, 'public');            // ...and the random portal never picks one

    assert.equal((await new Client(base).join('X', { world: 'zzzzzzzz' })).status, 404);
    assert.equal((await raw(base, '/api/worldinfo', 'POST', { ticket: await ticketFor(base), world: 'nope1234' })).status, 404);
  });
});

test('a private world with one player is deleted after PRIVATE_SOLO_SEC; two players keep it alive', async () => {
  await withServer({ PRIVATE_SOLO_SEC: 1.5, PRIVATE_EMPTY_SEC: 60 }, async (g, base) => {
    const lone = (await newPrivate(base)).json.code, pair = (await newPrivate(base)).json.code;
    const a = new Client(base), b = new Client(base), c = new Client(base);
    await a.join('Lone', { world: lone });
    await b.join('P1', { world: pair }); await c.join('P2', { world: pair });

    await sleep(1200);
    await a.sync(5, 5);
    assert.ok(a.solo !== undefined && a.solo <= 1.5, 'countdown is sent while alone, solo=' + a.solo);
    await b.sync(5, 5); await c.sync(5, 5);
    assert.equal(b.solo, undefined);                                 // nobody is alone in the second world

    for (let i = 0; i < 12; i++) { await b.sync(5, 5); await c.sync(5, 5); await sleep(200); }   // ~2.4 s of keeping the pair alive
    const dead = await a.sync(5, 5);
    assert.equal(dead.status, 410);
    assert.equal(dead.json.reason, 'closed');
    assert.equal(g.hub.worlds.has(lone), false);
    assert.equal(g.hub.worlds.has(pair), true);
    assert.equal((await raw(base, '/api/worldinfo', 'POST', { ticket: await ticketFor(base), world: lone })).status, 404);
    assert.equal((await new Client(base).join('Late', { world: lone })).status, 404);
  });
});

test('the solo timer restarts when a friend joins and leaves; empty private worlds disappear', async () => {
  await withServer({ PRIVATE_SOLO_SEC: 60, PRIVATE_EMPTY_SEC: 0.5 }, async (g, base) => {
    const code = (await newPrivate(base)).json.code;
    const a = new Client(base);
    await a.join('A', { world: code });
    await sleep(1300);
    assert.ok(g.hub.worlds.get(code).soloSince !== null);
    const b = new Client(base); await b.join('B', { world: code });
    await sleep(1300);
    assert.equal(g.hub.worlds.get(code).soloSince, null);            // two players: no countdown
    await raw(base, '/api/leave', 'POST', { id: a.id, token: a.token });
    await raw(base, '/api/leave', 'POST', { id: b.id, token: b.token });
    await sleep(2800);
    assert.equal(g.hub.worlds.has(code), false);                     // nobody came back
  });
});

test('private world creation is limited per network', async () => {
  await withServer({ MAX_PRIVATE_PER_IP: 2 }, async (g, base) => {
    assert.equal((await newPrivate(base)).status, 200);
    assert.equal((await newPrivate(base)).status, 200);
    assert.equal((await newPrivate(base)).status, 429);
    assert.equal((await raw(base, '/api/newprivate', 'POST', { ticket: 'nope' })).status, 401);
  });
});

// ================================================================ bot protection

test('no ticket, no entry: joining, world info and private worlds all need the human check', async () => {
  await withServer({}, async (g, base) => {
    for (const route of ['join', 'worldinfo', 'newprivate']) {
      assert.equal((await raw(base, '/api/' + route, 'POST', { world: 'w1' })).status, 401, route);
      assert.equal((await raw(base, '/api/' + route, 'POST', { ticket: 'abc.def', world: 'w1' })).status, 401, route);
    }
    const good = await ticketFor(base);
    const forged = good.slice(0, -2) + (good.endsWith('AA') ? 'BB' : 'AA');
    assert.equal((await raw(base, '/api/join', 'POST', { ticket: forged, world: 'w1' })).status, 401);
    const [body, sig] = good.split('.');
    const tampered = Buffer.from(JSON.stringify(Object.assign(JSON.parse(Buffer.from(body, 'base64url')), { x: Date.now() + 9e9 }))).toString('base64url');
    assert.equal((await raw(base, '/api/join', 'POST', { ticket: tampered + '.' + sig, world: 'w1' })).status, 401);
    assert.equal((await raw(base, '/api/join', 'POST', { ticket: good, world: 'w1' })).status, 200);
  });
});

test('a ticket only works from the network it was issued to', async () => {
  await withServer({}, async (g, base) => {
    const ticket = (await getTicket(base, {}, { 'x-forwarded-for': '203.0.113.5' })).json.ticket;
    assert.ok(ticket);
    assert.equal((await raw(base, '/api/join', 'POST', { ticket, world: 'w1' }, { 'x-forwarded-for': '203.0.113.5' })).status, 200);
    assert.equal((await raw(base, '/api/join', 'POST', { ticket, world: 'w1' }, { 'x-forwarded-for': '198.51.100.9' })).status, 401);
    assert.equal((await raw(base, '/api/join', 'POST', { ticket, world: 'w1' }, { 'cf-connecting-ip': '203.0.113.5', 'x-forwarded-for': '1.1.1.1' })).status, 200);
  });
  await withServer({ TRUST_PROXY: false }, async (g, base) => {          // headers are ignored when TRUST_PROXY is off
    const t = (await getTicket(base, {}, { 'x-forwarded-for': '203.0.113.5' })).json.ticket;
    assert.equal((await raw(base, '/api/join', 'POST', { ticket: t, world: 'w1' }, { 'x-forwarded-for': '198.51.100.9' })).status, 200);
  });
});

test('the human check rejects bad proof-of-work, replays, honeypots and non-human traces', async () => {
  await withServer({ POW_BITS: 12 }, async (g, base) => {
    const fresh = async () => (await raw(base, '/api/challenge', 'POST', {})).json;
    const good = { hold: 1100, moves: 8, kind: 'pointer', pt: 'mouse', trusted: true, hp: '' };
    const solve = ch => { let n = 0; while (!powOk(ch.salt, n, ch.bits)) n++; return n; };
    const post = (ch, nonce, over) => raw(base, '/api/verify', 'POST', Object.assign({ ch: ch.ch, nonce }, good, over));

    let ch = await fresh(); let n = 0; while (powOk(ch.salt, n, ch.bits)) n++;
    assert.equal((await post(ch, n)).status, 400);                        // wrong nonce
    ch = await fresh();
    const nonce = solve(ch);
    assert.equal((await post(ch, nonce)).status, 200);
    assert.equal((await post(ch, nonce)).status, 400);                    // the same challenge can't be replayed

    for (const [why, over] of [
      ['honeypot filled', { hp: 'http://spam' }],
      ['not trusted events', { trusted: false }],
      ['hold too short', { hold: 80 }],
      ['hold absurdly long', { hold: 9e6 }],
      ['no pointer movement', { moves: 0 }],
      ['no hold at all', { hold: undefined }]
    ]) {
      ch = await fresh();
      assert.equal((await post(ch, solve(ch), over)).status, 400, why);
    }
    for (const [why, over] of [['keyboard', { kind: 'key', moves: 0, pt: undefined }], ['touch', { pt: 'touch', moves: 0 }]]) {
      ch = await fresh();
      assert.equal((await post(ch, solve(ch), over)).status, 200, why);   // keyboard and touch users aren't penalised
    }
    assert.equal((await raw(base, '/api/verify', 'POST', { ch: 'garbage', nonce: 1, ...good })).status, 400);
    assert.equal((await raw(base, '/api/verify', 'POST', '[]')).status, 400);
  });
});

test('a challenge answered too quickly, or too late, is refused', async () => {
  await withServer({ MIN_VERIFY_MS: 60000 }, async (g, base) => {
    assert.equal((await getTicket(base)).status, 400);
  });
  await withServer({ CHALLENGE_TTL: -1 }, async (g, base) => {
    assert.equal((await getTicket(base)).status, 400);
  });
});

test('HUMAN_CHECK=false keeps only the proof-of-work (for load-testing your own server)', async () => {
  await withServer({ HUMAN_CHECK: false }, async (g, base) => {
    const ch = (await raw(base, '/api/challenge', 'POST', {})).json;
    let nonce = 0; while (!powOk(ch.salt, nonce, ch.bits)) nonce++;
    assert.equal((await raw(base, '/api/verify', 'POST', { ch: ch.ch, nonce })).status, 200);
    const ch2 = (await raw(base, '/api/challenge', 'POST', {})).json;
    assert.equal((await raw(base, '/api/verify', 'POST', { ch: ch2.ch, nonce: 0 + (powOk(ch2.salt, 0, ch2.bits) ? 1e9 : 0) })).status, 400);
  });
});

test('Cloudflare Turnstile, when configured, is required on top of the other checks', async () => {
  const seen = [];
  const verify = async (tok, ip) => { seen.push([tok, ip]); return tok === 'good-token'; };
  await withServer({ TURNSTILE_SITEKEY: 'site-key', TURNSTILE_SECRET: 'secret' }, async (g, base) => {
    const ch = (await raw(base, '/api/challenge', 'POST', {})).json;
    assert.equal(ch.ts, 'site-key');                                     // the page learns the sitekey from here
    assert.equal((await getTicket(base)).status, 400);                   // no token
    assert.equal((await getTicket(base, { tsToken: 'forged' })).status, 400);
    assert.equal((await getTicket(base, { tsToken: 'good-token' })).status, 200);
    assert.equal(seen.length, 2);
  }, { turnstileVerify: verify });
  await withServer({}, async (g, base) => {                              // off by default
    assert.equal((await raw(base, '/api/challenge', 'POST', {})).json.ts, null);
  });
});

test('rate limits: challenge, verify, join and sync floods get 429 with Retry-After', async () => {
  await withServer({ RATE_LIMITS: true, CHALLENGE_BURST: 3, CHALLENGE_PER_SEC: 0.001, VERIFY_BURST: 2, VERIFY_PER_SEC: 0.001 }, async (g, base) => {
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await raw(base, '/api/challenge', 'POST', {})).status);
    assert.deepEqual(codes, [200, 200, 200, 429, 429]);
    assert.equal((await raw(base, '/api/challenge', 'POST', {})).headers.get('retry-after'), '2');
  });
  await withServer({ RATE_LIMITS: true, VERIFY_BURST: 2, VERIFY_PER_SEC: 0.001 }, async (g, base) => {
    const codes = [];
    for (let i = 0; i < 4; i++) codes.push((await getTicket(base)).status);
    assert.deepEqual(codes, [200, 200, 429, 429]);
  });
  await withServer({ RATE_LIMITS: true, JOIN_BURST: 2, JOIN_PER_SEC: 0.001, MAX_PLAYERS_PER_IP: 100 }, async (g, base) => {
    const codes = [];
    for (let i = 0; i < 4; i++) codes.push((await new Client(base).join('J' + i)).status);
    assert.deepEqual(codes, [200, 200, 429, 429]);
  });
  await withServer({ RATE_LIMITS: true, SYNC_BURST: 3, SYNC_PER_SEC: 0.001 }, async (g, base) => {
    const a = new Client(base); await a.join('A');
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await a.sync(10, 10)).status);
    assert.deepEqual(codes, [200, 200, 200, 429, 429]);
  });
});

test('only a few players can connect from one network at a time', async () => {
  await withServer({ MAX_PLAYERS_PER_IP: 2 }, async (g, base) => {
    const a = new Client(base), b = new Client(base), c = new Client(base);
    assert.equal((await a.join('A')).status, 200);
    assert.equal((await b.join('B', { world: 'lobby' })).status, 200);
    const r = await c.join('C');
    assert.equal(r.status, 429);
    assert.equal(r.json.code, 'ip');
    await raw(base, '/api/leave', 'POST', { id: a.id, token: a.token });
    assert.equal((await c.join('C')).status, 200);
    // other networks are unaffected
    const t = (await getTicket(base, {}, { 'x-forwarded-for': '203.0.113.77' })).json.ticket;
    assert.equal((await raw(base, '/api/join', 'POST', { ticket: t, world: 'w1' }, { 'x-forwarded-for': '203.0.113.77' })).status, 200);
  });
});

test('an auto-clicker (many attacks, cursor never moves) is sent back through the human check', async () => {
  await withServer({ AFK_ATTACKS: 5, AFK_MIN_MOVE: 6, ATTACK_CD: 0.01, SHIELD: 0, MANA_REGEN: 100, STRIKES_TO_BAN: 3 }, async (g, base) => {
    const bot = new Client(base), victim = new Client(base);
    await bot.join('Bot'); await victim.join('Victim');
    await bot.sync(300, 300);
    let status = 200, res = null;
    for (let i = 0; i < 12 && status === 200; i++) {
      res = await bot.sync(300, 300, [bot.action({ t: 'atk' })]);
      status = res.status; await sleep(15);
    }
    assert.equal(status, 410);
    assert.equal(res.json.reason, 'verify');
    assert.equal(g.hub.byId.has(bot.id), false);                          // removed from the world
    const rejoin = await bot.join('Bot');                                  // same ticket: revoked
    assert.equal(rejoin.status, 401);
    assert.equal(rejoin.json.reason, 'verify');
    const t2 = await getTicket(base);                                      // passing the check again works
    assert.equal(t2.status, 200);
    assert.equal((await new Client(base).join('Bot', { ticket: t2.json.ticket })).status, 200);
    ticketCache.delete(base);
  });
});

test('a normal player who moves while attacking is never flagged', async () => {
  await withServer({ AFK_ATTACKS: 5, AFK_MIN_MOVE: 6, ATTACK_CD: 0.01, SHIELD: 0, MANA_REGEN: 100 }, async (g, base) => {
    const a = new Client(base); await a.join('A');
    for (let i = 0; i < 30; i++) {
      const r = await a.sync(300 + (i % 2) * 20, 300, [a.action({ t: 'atk' })]);
      assert.equal(r.status, 200, 'iteration ' + i);
      await sleep(15);
    }
  });
});

test('repeat offenders are banned for a while', async () => {
  await withServer({ AFK_ATTACKS: 3, ATTACK_CD: 0.01, SHIELD: 0, MANA_REGEN: 100, STRIKES_TO_BAN: 2 }, async (g, base) => {
    const flagOnce = async () => {
      const t = await getTicket(base);
      const c = new Client(base);
      assert.equal((await c.join('Bot', { ticket: t.json.ticket })).status, 200);
      let res;
      for (let i = 0; i < 10; i++) { res = await c.sync(100, 100, [c.action({ t: 'atk' })]); if (res.status !== 200) break; await sleep(15); }
      return res;
    };
    assert.equal((await flagOnce()).json.reason, 'verify');
    assert.equal((await flagOnce()).json.reason, 'banned');
    assert.equal((await raw(base, '/api/challenge', 'POST', {})).status, 403);
    assert.equal((await raw(base, '/api/challenge', 'POST', {}, { 'x-forwarded-for': '203.0.113.9' })).status, 200);   // someone else is fine
  });
});

test('cursor speed is capped: teleporting across the arena over and over does not work', async () => {
  await withServer({ MAX_SPEED: 1000, MOVE_BURST: 500 }, async (g, base) => {
    const a = new Client(base); await a.join('A');
    await a.sync(800, 450);                                       // starts at the centre
    await a.sync(800, 450);
    await a.sync(1500, 450);                                      // asks for +700, may only move ~500 right away
    assert.ok(a.me().x > 1290 && a.me().x < 1320, 'clamped to the burst allowance, x=' + a.me().x);
    await sleep(400);                                             // 400 ms refills about 400 units
    await a.sync(1500, 450);
    assert.ok(Math.abs(a.me().x - 1500) < 2, 'catches up over time, x=' + a.me().x);
    await a.sync(100, 450);                                       // a huge jump back is limited again
    assert.ok(a.me().x > 1100 && a.me().x < 1500, 'big jump is limited, x=' + a.me().x);
  });
});
