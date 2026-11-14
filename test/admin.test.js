'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { start } = require('../server.js');
const { powOk } = require('../lib/security.js');

const TEST_CFG = { RATE_LIMITS: false, MAX_PLAYERS_PER_IP: 1000, POW_BITS: 4, MIN_VERIFY_MS: 0, MAX_SPEED: 1e9, MOVE_BURST: 1e9, AFK_ATTACKS: 1e9 };

async function withServer(config, fn, extra = {}) {
  const g = await start(Object.assign({ port: 0, host: '127.0.0.1', env: false, dataDir: null, config: Object.assign({}, TEST_CFG, config) }, extra));
  try { await fn(g, 'http://127.0.0.1:' + g.port); } finally { await g.close(); }
}

async function raw(base, p, method, body, headers) {
  const res = await fetch(base + p, { method, redirect: 'manual',
    headers: Object.assign(body !== undefined ? { 'Content-Type': 'application/json' } : {}, headers),
    body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch (e) { /* not json */ }
  return { status: res.status, text, json, headers: res.headers };
}

// an admin "browser": keeps its cookie, can pretend to come from another IP
class Admin {
  constructor(base, ip) { this.base = base; this.ip = ip || '198.51.100.1'; this.cookie = ''; }
  async call(route, body, extra) {
    const h = Object.assign({ 'X-CC-Admin': '1', 'X-Forwarded-For': this.ip }, this.cookie ? { Cookie: this.cookie } : {}, extra);
    const r = await raw(this.base, '/api/admin/' + route, 'POST', body || {}, h);
    const sc = r.headers.get('set-cookie');
    if (sc) this.cookie = sc.split(';')[0].endsWith('=') ? '' : sc.split(';')[0];
    return r;
  }
  async login(pw) { return this.call('login', { password: pw }); }
  // sign in and get past the forced password change
  async ready(pw = 'correct horse battery') {
    const r = await this.login('2468');
    assert.equal(r.status, 200); assert.equal(r.json.mustChange, true);
    const c = await this.call('password', { current: '2468', password: pw });
    assert.equal(c.status, 200);
    return this;
  }
}

async function ticketFor(base, ip) {
  const h = { 'X-Forwarded-For': ip || '203.0.113.9' };
  const ch = (await raw(base, '/api/challenge', 'POST', {}, h)).json;
  let nonce = 0; while (!powOk(ch.salt, nonce, ch.bits)) nonce++;
  const r = await raw(base, '/api/verify', 'POST', { ch: ch.ch, nonce, hold: 1100, moves: 8, kind: 'pointer', pt: 'mouse', trusted: true, hp: '' }, h);
  assert.equal(r.status, 200, r.text);
  return r.json.ticket;
}
async function join(base, name, o = {}) {
  const ip = o.ip || '203.0.113.9';
  const ticket = o.ticket || await ticketFor(base, ip);
  const r = await raw(base, '/api/join', 'POST', { ticket, name, world: o.world || 'w1' }, { 'X-Forwarded-For': ip });
  return { r, id: r.json && r.json.id, token: r.json && r.json.token, ip, ticket, seq: r.json && r.json.seq };
}
const sync = (base, c) => raw(base, '/api/sync', 'POST', { id: c.id, token: c.token, x: 800, y: 450, a: [], since: c.seq || 0, rv: 0, pv: 0 }, { 'X-Forwarded-For': c.ip });

// ================================================================ pages and auth

test('admin page is served (also under /cursorclash) and is not indexable', async () => {
  await withServer({}, async (g, base) => {
    for (const p of ['/admin', '/admin/', '/cursorclash/admin']) {
      const r = await raw(base, p, 'GET');
      assert.equal(r.status, 200, p);
      assert.match(r.text, /CursorClash admin/);
      assert.match(r.headers.get('x-robots-tag'), /noindex/);
      assert.equal(r.headers.get('cache-control'), 'no-store');
    }
  });
});

test('admin API needs the header and a session', async () => {
  await withServer({}, async (g, base) => {
    let r = await raw(base, '/api/admin/overview', 'POST', {});
    assert.equal(r.status, 403);                                           // no X-CC-Admin header
    r = await raw(base, '/api/admin/overview', 'POST', {}, { 'X-CC-Admin': '1' });
    assert.equal(r.status, 401);                                           // no session
    r = await raw(base, '/api/admin/overview', 'GET');
    assert.equal(r.status, 405);
    r = await raw(base, '/api/admin/overview', 'POST', {}, { 'X-CC-Admin': '1', Cookie: 'cc_admin=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' });
    assert.equal(r.status, 401);
  });
});

test('first login with 2468 forces a new password before anything else works', async () => {
  await withServer({}, async (g, base) => {
    const a = new Admin(base);
    const r = await a.login('2468');
    assert.equal(r.status, 200);
    assert.equal(r.json.mustChange, true);
    const sc = r.headers.get('set-cookie');
    assert.match(sc, /HttpOnly/); assert.match(sc, /SameSite=Strict/); assert.doesNotMatch(sc, /Secure/);

    for (const route of ['overview', 'logs', 'kick', 'settings', 'broadcast', 'maintenance']) {
      const x = await a.call(route, {});
      assert.equal(x.status, 403, route); assert.equal(x.json.code, 'mustChange');
    }
    assert.equal((await a.call('session')).json.mustChange, true);

    // rules for the new password
    assert.equal((await a.call('password', { current: 'wrong', password: 'abcdefghij' })).status, 401);
    assert.equal((await a.call('password', { current: '2468', password: 'short' })).status, 400);
    assert.equal((await a.call('password', { current: '2468', password: '2468' })).status, 400);
    assert.equal((await a.call('password', { current: '2468', password: 'my new password' })).status, 200);

    assert.equal((await a.call('overview')).status, 200);
    assert.equal((await a.call('session')).json.mustChange, false);

    // old password is dead, new one works from a fresh browser
    const b = new Admin(base, '198.51.100.77');
    assert.equal((await b.login('2468')).status, 401);
    const ok = await b.login('my new password');
    assert.equal(ok.status, 200); assert.equal(ok.json.mustChange, false);
  });
});

test('the cookie is Secure behind an https proxy', async () => {
  await withServer({}, async (g, base) => {
    const r = await raw(base, '/api/admin/login', 'POST', { password: '2468' }, { 'X-CC-Admin': '1', 'X-Forwarded-Proto': 'https' });
    assert.match(r.headers.get('set-cookie'), /; Secure/);
  });
});

test('5 wrong passwords lock the network; the right password is refused while locked; others are unaffected', async () => {
  await withServer({}, async (g, base) => {
    const a = new Admin(base, '198.51.100.5');
    for (let i = 1; i <= 4; i++) {
      const r = await a.login('nope' + i);
      assert.equal(r.status, 401);
      assert.equal(r.json.attemptsLeft, 5 - i);
    }
    const fifth = await a.login('nope5');
    assert.equal(fifth.status, 423);
    assert.equal(fifth.json.code, 'locked');
    assert.ok(fifth.json.retryAfter > 800);
    assert.ok(fifth.headers.get('retry-after'));
    const right = await a.login('2468');
    assert.equal(right.status, 423, 'correct password must not work during the lock');
    assert.equal(a.cookie, '');

    const other = new Admin(base, '198.51.100.6');                          // a different network can still sign in
    assert.equal((await other.login('2468')).status, 200);

    // the lock is visible and can be lifted by a signed-in admin
    await other.call('password', { current: '2468', password: 'another good one' });
    const ov = (await other.call('overview')).json;
    assert.deepEqual(ov.locks.map(l => l.ip), ['198.51.100.5']);
    assert.equal((await other.call('unlock-admin', { ip: '198.51.100.5' })).status, 200);
    assert.equal((await a.login('another good one')).status, 200);
    const types = (await other.call('logs', { types: ['admin-lock', 'admin-fail'] })).json.entries.map(e => e.type);
    assert.ok(types.includes('admin-lock')); assert.ok(types.filter(t => t === 'admin-fail').length >= 4);
  });
});

test('the lock expires by itself', async () => {
  await withServer({ ADMIN_LOCK_SEC: 1 }, async (g, base) => {
    const a = new Admin(base, '198.51.100.8');
    for (let i = 0; i < 5; i++) await a.login('bad');
    assert.equal((await a.login('2468')).status, 423);
    await new Promise(r => setTimeout(r, 1200));
    assert.equal((await a.login('2468')).status, 200);
  });
});

test('wrong guesses older than the window are forgotten; a success resets the count', async () => {
  await withServer({}, async (g, base) => {
    const a = new Admin(base, '198.51.100.9');
    for (let i = 0; i < 4; i++) await a.login('bad');
    assert.equal((await a.login('2468')).status, 200);                      // success resets
    for (let i = 0; i < 4; i++) assert.equal((await a.login('bad')).status, 401);   // 4 more: still not locked
  });
});

test('logout ends the session', async () => {
  await withServer({}, async (g, base) => {
    const a = await new Admin(base).ready();
    const old = a.cookie;
    assert.equal((await a.call('logout')).status, 200);
    const r = await raw(base, '/api/admin/overview', 'POST', {}, { 'X-CC-Admin': '1', Cookie: old });
    assert.equal(r.status, 401);
  });
});

test('changing the password signs every other session out', async () => {
  await withServer({}, async (g, base) => {
    const a = await new Admin(base, '198.51.100.20').ready('first password!');
    const b = new Admin(base, '198.51.100.21'); assert.equal((await b.login('first password!')).status, 200);
    assert.equal((await b.call('overview')).status, 200);
    assert.equal((await a.call('password', { current: 'first password!', password: 'second password!' })).status, 200);
    assert.equal((await b.call('overview')).status, 401);
    assert.equal((await a.call('overview')).status, 200);
  });
});

test('ADMIN_INITIAL_PASSWORD replaces 2468 (and the hash is never exposed)', async () => {
  await withServer({ ADMIN_INITIAL_PASSWORD: 'start-here-9' }, async (g, base) => {
    const a = new Admin(base);
    assert.equal((await a.login('2468')).status, 401);
    const r = await a.login('start-here-9');
    assert.equal(r.status, 200); assert.equal(r.json.mustChange, true);
    await a.call('password', { current: 'start-here-9', password: 'brand new pw' });
    const all = JSON.stringify((await a.call('overview')).json) + JSON.stringify((await a.call('logs', {})).json);
    assert.ok(!all.includes('brand new pw') && !all.includes('start-here-9'));
    assert.ok(!/scrypt|"hash"|"salt"/.test(all));
  });
});

// ================================================================ monitoring and the 24 h log

test('overview lists worlds and players (with IPs); the log records joins, kills, leaves, portals', async () => {
  await withServer({ SHIELD: 0 }, async (g, base) => {
    const a = await new Admin(base).ready();
    const p1 = await join(base, 'Alice', { ip: '203.0.113.10' }), p2 = await join(base, 'Bob', { ip: '203.0.113.11' });
    const w1 = g.hub.worlds.get('w1');
    w1.kill(w1.players.get(p2.id), w1.players.get(p1.id));
    await raw(base, '/api/leave', 'POST', { id: p2.id, token: p2.token }, { 'X-Forwarded-For': p2.ip });

    const ov = (await a.call('overview')).json;
    assert.equal(ov.counts.players, 1);
    assert.equal(ov.players[0].name, 'Alice'); assert.equal(ov.players[0].ip, '203.0.113.10'); assert.equal(ov.players[0].world, 'w1');
    assert.ok(ov.worlds.some(w => w.id === 'w1' && w.count === 1));
    assert.ok(ov.worlds.some(w => w.kind === 'lobby'));
    assert.equal(ov.version, require('../package.json').version);

    const log = (await a.call('logs', {})).json;
    const types = log.entries.map(e => e.type);
    for (const t of ['join', 'kill', 'leave', 'verify-ok', 'admin-login']) assert.ok(types.includes(t), t);
    assert.ok(log.entries.some(e => e.type === 'join' && /Alice joined World 1 from 203\.0\.113\.10/.test(e.msg)));
    assert.ok(log.entries.some(e => e.type === 'kill' && /Alice clashed Bob/.test(e.msg)));
    assert.ok(log.entries[0].t >= log.entries[log.entries.length - 1].t, 'newest first');

    // filters
    const only = (await a.call('logs', { types: ['kill'] })).json.entries;
    assert.ok(only.length === 1 && only[0].type === 'kill');
    const q = (await a.call('logs', { q: 'bob' })).json.entries;
    assert.ok(q.length >= 2 && q.every(e => /bob/i.test(e.msg) || /bob/i.test(e.ip || '')));
    assert.equal((await a.call('logs', { limit: 2 })).json.entries.length, 2);
    assert.equal((await a.call('logs', { since: Date.now() + 1000 })).json.entries.length, 0);
    assert.ok(log.counts.join >= 2);
  });
});

test('the log keeps only 24 hours and the stats sampler records counts', async () => {
  await withServer({}, async (g, base) => {
    const a = await new Admin(base).ready();
    g.admin.log.unshift({ t: Date.now() - 25 * 3600 * 1000, type: 'join', msg: 'ancient' });
    g.admin.stats.unshift({ t: Date.now() - 25 * 3600 * 1000, players: 5 });
    await join(base, 'Zed');
    g.admin.sample();
    g.admin.housekeeping();
    const log = (await a.call('logs', { q: 'ancient' })).json;
    assert.equal(log.entries.length, 0);
    const st = (await a.call('stats')).json.samples;
    assert.ok(st.length >= 1 && st.every(s => s.t > Date.now() - 24 * 3600 * 1000));
    assert.ok(st.some(s => s.players === 1));
  });
});

test('world open/close, private creation and portal use are logged', async () => {
  await withServer({ PUBLIC_SPAWN_AT: 1, SHIELD: 0 }, async (g, base) => {
    const a = await new Admin(base).ready();
    await join(base, 'A', { ip: '203.0.113.31' }); await join(base, 'B', { ip: '203.0.113.32' });     // 2 > 1 → World 2 spawns
    const tk = await ticketFor(base, '203.0.113.33');
    const pr = await raw(base, '/api/newprivate', 'POST', { ticket: tk }, { 'X-Forwarded-For': '203.0.113.33' });
    assert.equal(pr.status, 200);
    const log = (await a.call('logs', {})).json.entries;
    assert.ok(log.some(e => e.type === 'world-open' && /World 2/.test(e.msg)));
    assert.ok(log.some(e => e.type === 'private' && e.msg.includes(pr.json.code)));
    g.hub.closeWorld(g.hub.worlds.get(pr.json.code), 'closed');
    assert.ok((await a.call('logs', { types: ['world-close'] })).json.entries.some(e => e.msg.includes(pr.json.code)));
  });
});

// ================================================================ actions

test('kick removes a player (they see "kicked") but can rejoin', async () => {
  await withServer({}, async (g, base) => {
    const a = await new Admin(base).ready();
    const p = await join(base, 'Mallory');
    assert.equal((await a.call('kick', { id: p.id })).status, 200);
    const s = await sync(base, p);
    assert.equal(s.status, 410); assert.equal(s.json.reason, 'kicked');
    assert.equal((await join(base, 'Mallory', { ticket: p.ticket, ip: p.ip })).r.status, 200);   // ticket still valid
    assert.equal((await a.call('kick', { id: 99999 })).status, 404);
  });
});

test('ban from the player list removes them and blocks the whole network; unban restores it', async () => {
  await withServer({}, async (g, base) => {
    const a = await new Admin(base).ready();
    const p = await join(base, 'Troll', { ip: '203.0.113.50' }), q = await join(base, 'Troll2', { ip: '203.0.113.50' });
    assert.equal((await a.call('kick', { id: p.id, banMinutes: 30 })).status, 200);
    for (const c of [p, q]) { const s = await sync(base, c); assert.equal(s.status, 410); assert.equal(s.json.reason, 'banned'); }
    const again = await raw(base, '/api/challenge', 'POST', {}, { 'X-Forwarded-For': '203.0.113.50' });
    assert.equal(again.status, 403); assert.equal(again.json.reason, 'banned');
    const ov = (await a.call('overview')).json;
    assert.equal(ov.bans.length, 1); assert.equal(ov.bans[0].ip, '203.0.113.50'); assert.equal(ov.bans[0].manual, true);
    assert.equal((await a.call('unban', { ip: '203.0.113.50' })).status, 200);
    assert.equal((await raw(base, '/api/challenge', 'POST', {}, { 'X-Forwarded-For': '203.0.113.50' })).status, 200);
    assert.equal((await a.call('overview')).json.bans.length, 0);
  });
});

test('ban by IP (timed and permanent), IPv6 networks, and bad input', async () => {
  await withServer({}, async (g, base) => {
    const a = await new Admin(base).ready();
    assert.equal((await a.call('ban-ip', { ip: 'not an ip!' })).status, 400);
    assert.equal((await a.call('ban-ip', { ip: '' })).status, 400);
    assert.equal((await a.call('ban-ip', { ip: '203.0.113.60', minutes: 10, reason: 'spam' })).status, 200);
    assert.equal((await a.call('ban-ip', { ip: '203.0.113.61' })).status, 200);                  // no minutes → permanent
    const six = await a.call('ban-ip', { ip: '2001:db8:1:2:aaaa:bbbb:cccc:dddd' });
    assert.equal(six.json.ip, '2001:db8:1:2');                                                  // a whole /64
    const bans = (await a.call('overview')).json.bans;
    assert.equal(bans.length, 3);
    assert.ok(bans.find(b => b.ip === '203.0.113.61').expires - Date.now() > 50 * 365 * 86400000);
    assert.equal(bans.find(b => b.ip === '203.0.113.60').reason, 'spam');
    assert.equal((await raw(base, '/api/challenge', 'POST', {}, { 'X-Forwarded-For': '2001:db8:1:2:1:2:3:4' })).status, 403);
  });
});

test('a banned player can still open the admin portal (so the owner can never lock themselves out)', async () => {
  await withServer({}, async (g, base) => {
    const a = await new Admin(base, '198.51.100.99').ready();
    await a.call('ban-ip', { ip: '198.51.100.99', minutes: 60 });
    assert.equal((await a.call('overview')).status, 200);
    assert.equal((await raw(base, '/api/challenge', 'POST', {}, { 'X-Forwarded-For': '198.51.100.99' })).status, 403);
  });
});

test('automatic bans (3 strikes) show up in the security list and the log', async () => {
  await withServer({}, async (g, base) => {
    const a = await new Admin(base).ready();
    g.sec.strike('203.0.113.70'); g.sec.strike('203.0.113.70');
    let ov = (await a.call('overview')).json;
    assert.deepEqual(ov.strikes, [{ ip: '203.0.113.70', count: 2 }]);
    g.sec.strike('203.0.113.70');
    ov = (await a.call('overview')).json;
    assert.equal(ov.bans[0].ip, '203.0.113.70'); assert.equal(ov.bans[0].manual, false);
    const types = (await a.call('logs', {})).json.entries.map(e => e.type);
    assert.ok(types.includes('strike') && types.includes('ban'));
  });
});

test('closing a world sends players to the lobby with "admin-closed"; World 1 and Lobby 1 are protected', async () => {
  await withServer({}, async (g, base) => {
    const a = await new Admin(base).ready();
    const made = await a.call('create-world');
    assert.equal(made.status, 200); assert.equal(made.json.id, 'w2');
    const p = await join(base, 'Zoe', { world: 'w2' });
    assert.equal(p.r.status, 200);
    assert.equal((await a.call('close-world', { id: 'w1' })).status, 400);
    assert.equal((await a.call('close-world', { id: 'l1' })).status, 400);
    assert.equal((await a.call('close-world', { id: 'nope' })).status, 404);
    assert.equal((await a.call('close-world', { id: 'w2' })).status, 200);
    const s = await sync(base, p);
    assert.equal(s.status, 410); assert.equal(s.json.reason, 'admin-closed');
    assert.ok(!g.hub.worlds.has('w2'));
  });
});

test('broadcast reaches the players of one world or of all worlds', async () => {
  await withServer({}, async (g, base) => {
    const a = await new Admin(base).ready();
    const p = await join(base, 'Hear', { world: 'w1' });
    const lobby = await join(base, 'Lob', { world: 'lobby', ip: '203.0.113.81' });
    assert.equal((await a.call('broadcast', { message: '   ' })).status, 400);
    assert.equal((await a.call('broadcast', { world: 'zzz', message: 'x' })).status, 404);
    assert.equal((await a.call('broadcast', { world: 'w1', message: 'Server restarts soon' })).status, 200);
    let s = await sync(base, p);
    assert.ok(s.json.events.some(e => e.e === 'msg' && e.n === 'Server restarts soon'));
    s = await sync(base, lobby);
    assert.ok(!s.json.events.some(e => e.e === 'msg'));
    assert.equal((await a.call('broadcast', { message: 'x'.repeat(500) })).json.worlds, g.hub.worlds.size);
    s = await sync(base, lobby);
    assert.equal(s.json.events.find(e => e.e === 'msg').n.length, 140);
    assert.ok((await a.call('logs', { types: ['admin-action'] })).json.entries.some(e => /Broadcast/.test(e.msg)));
  });
});

test('maintenance mode blocks new joins with a friendly message and can kick everyone', async () => {
  await withServer({}, async (g, base) => {
    const a = await new Admin(base).ready();
    const p = await join(base, 'Inside');
    const on = await a.call('maintenance', { on: true, message: 'Back at 9pm', kick: true });
    assert.equal(on.status, 200); assert.equal(on.json.kicked, 1);
    assert.equal((await sync(base, p)).json.reason, 'kicked');
    const j = await join(base, 'Late', { ip: '203.0.113.90' });
    assert.equal(j.r.status, 503); assert.equal(j.r.json.code, 'maintenance'); assert.equal(j.r.json.error, 'Back at 9pm');
    assert.equal((await a.call('overview')).json.maintenance.on, true);
    await a.call('maintenance', { on: false });
    assert.equal((await join(base, 'Late', { ip: '203.0.113.90' })).r.status, 200);
  });
});

test('kick-all empties the game', async () => {
  await withServer({}, async (g, base) => {
    const a = await new Admin(base).ready();
    await join(base, 'One', { ip: '203.0.113.91' }); await join(base, 'Two', { ip: '203.0.113.92' });
    assert.equal((await a.call('kick-all')).json.n, 2);
    assert.equal((await a.call('overview')).json.counts.players, 0);
  });
});

test('live settings are validated, applied immediately, and can be reset', async () => {
  await withServer({}, async (g, base) => {
    const a = await new Admin(base).ready();
    const get = async () => Object.fromEntries((await a.call('overview')).json.settings.map(s => [s.key, s.value]));
    assert.equal((await a.call('settings', { values: { NOPE: 1 } })).status, 400);
    assert.equal((await a.call('settings', { values: { MAX_PLAYERS: 1000 } })).status, 400);
    assert.equal((await a.call('settings', { values: { ATTACK_DMG: 'lots' } })).status, 400);
    assert.equal((await a.call('settings', { values: { MAX_PLAYERS: 10, PUBLIC_SPAWN_AT: 10 } })).status, 400);   // threshold must stay below the cap
    assert.equal(g.config.MAX_PLAYERS, 30);                                                                         // nothing half-applied
    assert.equal((await a.call('settings', { values: { MAX_PLAYERS: 12, PUBLIC_SPAWN_AT: 8, ATTACK_DMG: 30 } })).status, 200);
    assert.equal(g.config.MAX_PLAYERS, 12); assert.equal(g.config.ATTACK_DMG, 30);
    assert.equal(g.hub.worlds.get('w1').capacity(), 12);
    assert.deepEqual([(await get()).MAX_PLAYERS, (await get()).PUBLIC_SPAWN_AT], [12, 8]);
    assert.ok((await a.call('logs', { types: ['admin-action'] })).json.entries.some(e => /MAX_PLAYERS 30 → 12/.test(e.msg)));
    await a.call('settings', { values: {}, reset: true });
    assert.equal(g.config.MAX_PLAYERS, 30); assert.equal(g.config.ATTACK_DMG, 14);
  });
});

test('clear-log empties the log but records that it happened', async () => {
  await withServer({}, async (g, base) => {
    const a = await new Admin(base).ready();
    await join(base, 'X');
    await a.call('clear-log');
    const e = (await a.call('logs', {})).json.entries;
    assert.ok(e.length >= 1 && e.length <= 2 && e.some(x => /Cleared the log/.test(x.msg)));
  });
});

test('log text is stored as plain text (nothing is rendered as HTML server-side)', async () => {
  await withServer({}, async (g, base) => {
    const a = await new Admin(base).ready();
    await join(base, '<img src=x onerror=alert(1)>');
    const j = JSON.stringify((await a.call('logs', {})).json);
    assert.ok(!j.includes('<img'));                                         // the game already strips < and >
  });
});

// ================================================================ persistence

test('password, bans, settings, maintenance and the log survive a restart when a data folder is set', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-admin-'));
  let g = null;
  try {
    const cfg = Object.assign({}, TEST_CFG);
    g = await start({ port: 0, host: '127.0.0.1', env: false, dataDir: dir, config: cfg });
    let base = 'http://127.0.0.1:' + g.port;
    let a = await new Admin(base).ready('persisted password');
    await a.call('ban-ip', { ip: '203.0.113.200', minutes: 120 });
    await a.call('settings', { values: { MAX_PLAYERS: 25 } });
    await a.call('maintenance', { on: true, message: 'Persist me' });
    await join(base, 'Remember').catch(() => null);
    await g.close();
    assert.ok(fs.existsSync(path.join(dir, 'admin.json')));
    const raw0 = fs.readFileSync(path.join(dir, 'admin.json'), 'utf8');
    assert.ok(!raw0.includes('persisted password') && !raw0.includes('2468'));

    g = await start({ port: 0, host: '127.0.0.1', env: false, dataDir: dir, config: Object.assign({}, TEST_CFG) });
    base = 'http://127.0.0.1:' + g.port;
    a = new Admin(base);
    assert.equal((await a.login('2468')).status, 401, 'the default password must not come back');
    const ok = await a.login('persisted password');
    assert.equal(ok.status, 200); assert.equal(ok.json.mustChange, false);
    const ov = (await a.call('overview')).json;
    assert.equal(ov.bans.length, 1); assert.equal(ov.bans[0].ip, '203.0.113.200');
    assert.equal(ov.settings.find(s => s.key === 'MAX_PLAYERS').value, 25);
    assert.equal(ov.maintenance.on, true); assert.equal(ov.maintenance.message, 'Persist me');
    assert.equal(ov.persist.enabled, true); assert.equal(ov.persist.ok, true);
    const log = (await a.call('logs', {})).json.entries;
    assert.ok(log.some(e => /Banned 203\.0\.113\.200/.test(e.msg)), 'old log entries are still there');
    assert.equal((await raw(base, '/api/challenge', 'POST', {}, { 'X-Forwarded-For': '203.0.113.200' })).status, 403);
    await g.close(); g = null;
  } finally { if (g) await g.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an unwritable data folder is reported but never crashes the game', async () => {
  const f = path.join(os.tmpdir(), 'cc-notadir-' + process.pid);
  fs.writeFileSync(f, 'x');
  try {
    const g = await start({ port: 0, host: '127.0.0.1', env: false, dataDir: path.join(f, 'sub'), config: Object.assign({}, TEST_CFG) });
    const base = 'http://127.0.0.1:' + g.port;
    const a = await new Admin(base).ready();
    const ov = (await a.call('overview')).json;
    assert.equal(ov.persist.enabled, true); assert.equal(ov.persist.ok, false);
    assert.equal((await join(base, 'StillWorks')).r.status, 200);
    await g.close();
  } finally { fs.rmSync(f, { force: true }); }
});
