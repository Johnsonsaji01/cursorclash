'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { start } = require('../server.js');
const { powOk } = require('../lib/security.js');
const { sniff, isPrivateIp } = require('../lib/images.js');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const CFG = { RATE_LIMITS: false, MAX_PLAYERS_PER_IP: 1000, POW_BITS: 4, MIN_VERIFY_MS: 0, MAX_SPEED: 1e9, MOVE_BURST: 1e9, AFK_ATTACKS: 1e9, BOT_COUNT: 0, SHIELD: 0 };

async function withServer(config, fn, extra = {}) {
  const g = await start(Object.assign({ port: 0, host: '127.0.0.1', env: false, dataDir: null, config: Object.assign({}, CFG, config) }, extra));
  try { await fn(g, 'http://127.0.0.1:' + g.port); } finally { await g.close(); }
}
async function raw(base, p, method, body, headers) {
  const res = await fetch(base + p, { method, redirect: 'manual', headers: Object.assign(body !== undefined ? { 'Content-Type': 'application/json' } : {}, headers), body: body === undefined ? undefined : JSON.stringify(body) });
  const buf = Buffer.from(await res.arrayBuffer());
  let json = null; try { json = JSON.parse(buf.toString('utf8')); } catch (e) { /* not json */ }
  return { status: res.status, buf, json, headers: res.headers };
}
const tickets = new Map();
async function ticketFor(base) {
  if (!tickets.has(base)) {
    const ch = (await raw(base, '/api/challenge', 'POST', {})).json;
    let n = 0; while (!powOk(ch.salt, n, ch.bits)) n++;
    const r = await raw(base, '/api/verify', 'POST', { ch: ch.ch, nonce: n, hold: 1100, moves: 8, kind: 'pointer', pt: 'mouse', trusted: true, hp: '' });
    assert.equal(r.status, 200); tickets.set(base, r.json.ticket);
  }
  return tickets.get(base);
}
class P {
  constructor(base) { this.base = base; this.aid = 0; this.seq = 0; this.cv = 0; this.events = []; this.pv = 0; }
  async join(name, o = {}) {
    const r = await raw(this.base, '/api/join', 'POST', { ticket: await ticketFor(this.base), name, world: o.world || 'w1', color: o.color, profile: o.profile });
    this.status = r.status; this.r = r.json;
    if (r.status === 200) { Object.assign(this, { id: r.json.id, token: r.json.token, profile: r.json.profile, inv: r.json.inv, world: r.json.world }); this.apply(r.json); }
    return r;
  }
  apply(d) {
    this.seq = d.seq; this.you = d.you; this.players = new Map(d.players.map(p => [p[0], { x: p[1], y: p[2], hp: p[3], mana: p[4] }]));
    if (d.roster) this.roster = d.roster; if (d.coins) { this.coins = d.coins; this.cv = d.cv; } if (d.imgs) this.imgs = d.imgs; if (d.tnts) this.tnts = d.tnts;
    for (const e of d.events) this.events.push(e); this.last = d;
  }
  act(a) { return Object.assign({ i: ++this.aid }, a); }
  async sync(x, y, a = []) {
    const r = await raw(this.base, '/api/sync', 'POST', { id: this.id, token: this.token, x, y, a, since: this.seq, rv: 0, pv: this.pv, cv: this.cv });
    if (r.status === 200) this.apply(r.json); return r;
  }
  shop(op, extra) { return raw(this.base, '/api/shop', 'POST', Object.assign({ id: this.id, token: this.token, op }, extra)); }
  me() { return this.players.get(this.id); }
}
const W = g => g.hub.worlds.get('w1');

// a real, valid PNG (solid colour) so browsers can draw it too
function png(w, h) {
  const crcT = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcT[n] = c >>> 0; }
  const crc = b => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 6;
  const rowLen = 1 + w * 4, rows = Buffer.alloc(rowLen * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = y * rowLen + 1 + x * 4; rows[o] = 200; rows[o + 1] = 200; rows[o + 2] = 200; rows[o + 3] = 255; }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
function imageServer(routes) {
  return new Promise(res => {
    const srv = http.createServer((req, rs) => { const r = routes[req.url]; if (!r) { rs.writeHead(404); return rs.end(); } if (r.redirect) { rs.writeHead(302, { Location: r.redirect }); return rs.end(); } rs.writeHead(200, { 'Content-Type': r.type || 'image/png' }); rs.end(r.body); });
    srv.listen(0, '127.0.0.1', () => res({ srv, url: p => 'http://127.0.0.1:' + srv.address().port + p }));
  });
}
const giveCoins = (g, p, n) => { const pr = [...g.hub.byId.values()].find(x => x.id === p.id).profile; g.hub.profiles.addCoins(pr, n); };

// ================================================================ bots

test('World 1 keeps 5 bots; every real player removes one; with 5 players there are none', async () => {
  await withServer({ BOT_COUNT: 5 }, async (g, base) => {
    const bots = () => [...W(g).players.values()].filter(p => p.bot).length;
    assert.equal(bots(), 5); assert.equal(W(g).count(), 0);
    const ps = [];
    for (let i = 1; i <= 5; i++) { const p = new P(base); await p.join('H' + i); ps.push(p); assert.equal(bots(), 5 - i, 'after ' + i + ' players'); }
    assert.equal(bots(), 0);
    assert.equal((await ps[0].sync(100, 100)).json.n, 5);                               // bots are not counted as players
    await raw(base, '/api/leave', 'POST', { id: ps[4].id, token: ps[4].token });
    assert.equal(bots(), 1);                                                            // a place frees up → a bot returns
    const w2 = g.hub.createPublic(); assert.equal([...w2.players.values()].filter(p => p.bot).length, 0);   // only the main world
    assert.equal(g.hub.worlds.get(ps[0].world.id).kind, 'public');
  });
});

test('bots are listed in the roster flagged as bots, never share a colour with a player, and are not in the player count/portals', async () => {
  await withServer({ BOT_COUNT: 5 }, async (g, base) => {
    const p = new P(base);
    await p.join('Human', { color: [...W(g).players.values()][0].cidx });          // ask for a colour a bot is wearing
    assert.equal(p.status, 200);
    const flagged = p.roster.filter(r => r[5] === 1);
    assert.equal(flagged.length, 4);
    assert.ok(flagged.every(r => /^Bot /.test(r[1])));
    const colours = p.roster.map(r => r[2]); assert.equal(new Set(colours).size, colours.length);
    assert.equal(W(g).takenList().length, 1);                                       // the colour picker only counts people
    assert.equal(g.hub.byId.size, 1);
  });
});

test('bots roam and fight; admin can change how many there are', async () => {
  await withServer({ BOT_COUNT: 3 }, async (g, base) => {
    const w = W(g);
    const bots = [...w.players.values()].filter(p => p.bot);
    const before = bots.map(b => [b.x, b.y]);
    await sleep(700);
    assert.ok(bots.some((b, i) => Math.hypot(b.x - before[i][0], b.y - before[i][1]) > 20), 'bots move on their own');
    const h = new P(base); await h.join('Victim');
    const hp0 = [...w.players.values()].find(x => x.id === h.id);
    const bot = [...w.players.values()].find(p => p.bot);
    for (const b of [...w.players.values()].filter(p => p.bot && p !== bot)) { b.x = 5; b.y = 5; }
    bot.x = hp0.x + 20; bot.y = hp0.y; bot.shieldUntil = 0;
    await h.sync(hp0.x, hp0.y);
    for (let i = 0; i < 25 && hp0.hp >= 100; i++) { await sleep(80); bot.x = hp0.x + 20; bot.y = hp0.y; await h.sync(hp0.x, hp0.y); }
    assert.ok(hp0.hp < 100, 'a bot next to a player hits them');
    g.config.BOT_COUNT = 1; g.hub.tick(); w.lastBotCheck = 0; g.hub.tick();
    assert.equal([...w.players.values()].filter(p => p.bot).length, 0);             // 1 real player + 0 bots = 1 already (target 1)
  });
});

// ================================================================ profiles, coins

test('new players get a profile with starter coins and a default hotbar; the same profile id is recognised again', async () => {
  await withServer({}, async (g, base) => {
    const a = new P(base); await a.join('A');
    assert.match(a.profile, /^p_[0-9a-f]{32}$/);
    assert.equal(a.inv.coins, 20);
    assert.deepEqual(a.inv.hotbar, ['fist', 'draw', 'block', null, null, null, null, null, null]);
    assert.equal(a.last.you.c, 20);
    assert.ok(a.r.catalog.some(i => i.id === 'tnt' && i.price === 30));
    giveCoins(g, a, 7);
    const again = new P(base); await again.join('A2', { profile: a.profile });
    assert.equal(again.profile, a.profile); assert.equal(again.inv.coins, 27);
    const stranger = new P(base); await stranger.join('S', { profile: 'p_' + '0'.repeat(32) });
    assert.notEqual(stranger.profile, 'p_' + '0'.repeat(32)); assert.equal(stranger.inv.coins, 20);
  });
});

test('coins spawn by chance in arenas (not the menu), respect the limits, expire and are collected for money', async () => {
  await withServer({}, async (g, base) => {
    const a = new P(base); await a.join('Collector');
    const w = W(g);
    assert.equal(w.coins.size, 0);
    g.hub.shop.eco.coinEvery = 0.05; g.hub.shop.eco.coinMax = 3;
    await sleep(500);
    assert.equal(w.coins.size, 3);                                                  // stops at the limit
    await a.sync(800, 450);
    assert.equal(a.coins.length, 3);
    // collect one
    const coin = [...w.coins.values()][0];
    g.hub.shop.eco.coinEvery = 1e9;
    const me = w.players.get(a.id);
    const money = me.profile.coins;
    await a.sync(coin.x, coin.y);
    await sleep(120);
    const r = await a.sync(coin.x, coin.y);
    assert.equal(me.profile.coins, money + 1);
    assert.equal(r.json.you.c, money + 1);
    assert.ok(a.events.some(e => e.e === 'coin' && e.id === a.id));
    assert.equal(w.coins.size, 2);
    // expiry
    for (const c of w.coins.values()) c.exp = g.hub.now() - 1;
    await sleep(120); assert.equal(w.coins.size, 0);
    // the menu never has coins, and an empty world doesn't fill with them
    const m = new P(base); await m.join('InMenu', { world: 'lobby' });
    g.hub.shop.eco.coinEvery = 0.01; await sleep(200);
    assert.equal(g.hub.worlds.get(m.world.id).coins.size, 0);
    const priv = g.hub.createPrivate('x').world; await sleep(150); assert.equal(priv.coins.size, 0);      // nobody inside
  });
});

// ================================================================ shop + hotbar

test('buying: price is charged, the item lands in the first free hotbar slot, and limits are enforced', async () => {
  await withServer({}, async (g, base) => {
    const a = new P(base); await a.join('Shopper', { world: 'lobby' });
    let r = await a.shop('buy', { item: 'invis' });
    assert.equal(r.status, 200); assert.equal(r.json.bought, 'invis');
    assert.equal(r.json.inv.coins, 5);
    assert.equal(r.json.inv.items.length, 1);
    assert.equal(r.json.inv.hotbar[3], r.json.inv.items[0].u);                       // slot 4
    r = await a.shop('buy', { item: 'tnt' });                                          // costs 30, has 5
    assert.equal(r.status, 400); assert.match(r.json.error, /Not enough coins/);
    assert.equal((await a.shop('buy', { item: 'nope' })).status, 400);
    giveCoins(g, a, 1000);
    g.hub.shop.items.tnt.enabled = false;
    assert.match((await a.shop('buy', { item: 'tnt' })).json.error, /isn't for sale/);
    g.hub.shop.items.tnt.enabled = true;
    g.hub.shop.items.tnt.price = 2;                                                    // prices come from the live config
    r = await a.shop('buy', { item: 'tnt' }); assert.equal(r.status, 200);
    assert.equal(r.json.inv.coins, 5 + 1000 - 2);
    for (let i = 0; i < 40; i++) { r = await a.shop('buy', { item: 'invis' }); if (r.status !== 200) break; }
    assert.match(r.json.error, /inventory is full/);
    // can't shop from inside a world
    const w = new P(base); await w.join('InWorld');
    assert.match((await w.shop('buy', { item: 'invis' })).json.error, /main menu/);
    assert.equal((await raw(base, '/api/shop', 'POST', { id: 99999, token: 'x', op: 'catalog' })).status, 410);
  });
});

test('hotbar: items can be rearranged, the three tools can move but never leave, bad layouts are refused', async () => {
  await withServer({}, async (g, base) => {
    const a = new P(base); await a.join('Arranger', { world: 'lobby' });
    giveCoins(g, a, 500);
    await a.shop('buy', { item: 'invis' }); const r = await a.shop('buy', { item: 'tnt' });
    const [i1, i2] = r.json.inv.items.map(i => i.u);
    // move: tools to slots 7-9, items to 1-2
    let hb = [i2, i1, null, null, null, null, 'fist', 'draw', 'block'];
    let x = await a.shop('hotbar', { hotbar: hb });
    assert.equal(x.status, 200); assert.deepEqual(x.json.inv.hotbar, hb);
    // a tool can't be dropped into the inventory (removed from the hotbar)
    x = await a.shop('hotbar', { hotbar: [i2, i1, null, null, null, null, 'fist', 'draw', null] });
    assert.equal(x.status, 400); assert.deepEqual(x.json.inv.hotbar, hb);
    // duplicates, unknown items, wrong length
    assert.equal((await a.shop('hotbar', { hotbar: [i1, i1, null, null, null, null, 'fist', 'draw', 'block'] })).status, 400);
    assert.equal((await a.shop('hotbar', { hotbar: [999, null, null, null, null, null, 'fist', 'draw', 'block'] })).status, 400);
    assert.equal((await a.shop('hotbar', { hotbar: ['fist', 'draw'] })).status, 400);
    assert.equal((await a.shop('hotbar', { hotbar: ['fist', 'fist', 'block', null, null, null, null, null, null] })).status, 400);
    // an item can sit in the inventory (not on the hotbar)
    x = await a.shop('hotbar', { hotbar: ['fist', 'draw', 'block', null, null, null, null, null, null] });
    assert.equal(x.status, 200); assert.equal(x.json.inv.items.length, 2);
  });
});

// ================================================================ pictures

test('image paster: the server downloads the link, checks it, stores it, charges only on success', async () => {
  const good = png(40, 20);
  const { srv, url } = await imageServer({ '/ok.png': { body: good }, '/redir': { redirect: '/ok.png' }, '/page.html': { body: '<html>hi</html>', type: 'text/html' }, '/big.png': { body: Buffer.concat([good, Buffer.alloc(2 * 1024 * 1024)]) }, '/huge.png': { body: png(5000, 5000).subarray(0, 60) } });
  try {
    await withServer({ IMG_ALLOW_PRIVATE: true }, async (g, base) => {
      const a = new P(base); await a.join('Artist', { world: 'lobby' });
      giveCoins(g, a, 100);
      const coins = () => [...g.hub.byId.values()][0].profile.coins;
      const c0 = coins();
      for (const bad of ['/page.html', '/big.png', '/huge.png', '/missing.png']) {
        const r = await a.shop('buy', { item: 'image', url: url(bad) });
        assert.equal(r.status, 400, bad); assert.ok(r.json.error);
        assert.equal(coins(), c0, 'no charge for ' + bad);
      }
      assert.match((await a.shop('buy', { item: 'image', url: '' })).json.error, /link/);
      assert.match((await a.shop('buy', { item: 'image', url: 'ftp://x/y.png' })).json.error, /http/);
      assert.match((await a.shop('buy', { item: 'image', url: 'http://user:pw@127.0.0.1/x.png' })).json.error, /login/);
      const r = await a.shop('buy', { item: 'image', url: url('/redir') });          // redirects are followed
      assert.equal(r.status, 200);
      const it = r.json.inv.items[0];
      assert.equal(it.t, 'image'); assert.match(it.img, /^[0-9a-f]{64}$/); assert.equal(it.ar, 0.5);
      assert.equal(coins(), c0 - 40);
      // served from our own address with safe headers
      const img = await raw(base, '/img/' + it.img, 'GET');
      assert.equal(img.status, 200); assert.equal(img.headers.get('content-type'), 'image/png');
      assert.deepEqual(img.buf, good);
      assert.match(img.headers.get('content-security-policy'), /sandbox/); assert.equal(img.headers.get('x-content-type-options'), 'nosniff');
      assert.equal((await raw(base, '/img/' + '0'.repeat(64), 'GET')).status, 404);
      assert.equal((await raw(base, '/cursorclash/img/' + it.img, 'GET')).status, 200);
      assert.ok((await raw(base, '/api/admin/logs', 'POST', {}, { 'X-CC-Admin': '1' })).status === 401);
      assert.ok(g.admin.log.some(e => e.type === 'image' && e.msg.includes('/ok.png') === false && e.msg.includes('/redir')), 'the chosen link is logged for moderation');
    });
  } finally { srv.close(); }
});

test('image fetching refuses private/internal addresses by default and blocked sites', async () => {
  const { srv, url } = await imageServer({ '/ok.png': { body: png(20, 20) } });
  try {
    await withServer({}, async (g, base) => {
      const a = new P(base); await a.join('Sneaky', { world: 'lobby' });
      giveCoins(g, a, 100);
      for (const u of [url('/ok.png'), 'http://localhost/x.png', 'http://169.254.169.254/latest/meta-data', 'http://[::1]/x.png', 'http://10.0.0.5/x.png', 'http://192.168.1.1:8080/x.png', 'http://127.0.0.1:22/x.png']) {
        const r = await a.shop('buy', { item: 'image', url: u });
        assert.equal(r.status, 400, u);
        assert.match(r.json.error, /isn't allowed|unsupported port|Could not find|Could not download/, u);
      }
      g.hub.shop.blockedHosts = ['bad.example'];
      assert.match((await a.shop('buy', { item: 'image', url: 'https://www.bad.example/x.png' })).json.error, /not allowed/);
      assert.match((await a.shop('buy', { item: 'image', url: 'https://cdn.bad.example/x.png' })).json.error, /not allowed/);
    });
  } finally { srv.close(); }
  assert.ok(isPrivateIp('10.1.2.3') && isPrivateIp('127.0.0.1') && isPrivateIp('::1') && isPrivateIp('fd00::1') && isPrivateIp('::ffff:192.168.0.1') && isPrivateIp('172.20.0.1') && isPrivateIp('169.254.1.1'));
  assert.ok(!isPrivateIp('8.8.8.8') && !isPrivateIp('1.1.1.1') && !isPrivateIp('2606:4700::1111'));
  assert.equal(sniff(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'.padEnd(40))), null);
});

// ================================================================ items in play

async function setup(g, base, items) {
  const a = new P(base), b = new P(base);
  await a.join('Igniter'); await b.join('Target');
  for (const p of [a, b]) { const s = [...g.hub.byId.values()].find(x => x.id === p.id); s.x = s.rx = p.id === a.id ? 400 : 500; s.y = s.ry = 400; }
  const sa = [...g.hub.byId.values()].find(x => x.id === a.id);
  const own = {};
  for (const t of items) { const rec = g.hub.profiles.addItem(sa.profile, Object.assign({ t }, t === 'image' ? { img: 'x', ar: 1 } : {})); own[t] = rec.u; }
  return { a, b, sa, sb: [...g.hub.byId.values()].find(x => x.id === b.id), own };
}

test('invisibility hides you from everyone else for its duration, is used up, and lasts the configured time', async () => {
  await withServer({}, async (g, base) => {
    g.hub.shop.items.invis.duration = 0.6;
    const { a, b, sa, own } = await setup(g, base, ['invis']);
    await b.sync(500, 400); assert.ok(b.players.has(a.id));
    await a.sync(400, 400, [a.act({ t: 'use', u: own.invis })]);
    assert.equal(sa.profile.items.length, 0);                                        // consumed
    await b.sync(500, 400);
    assert.ok(!b.players.has(a.id), 'invisible to others');
    const mine = await a.sync(400, 400);
    assert.ok(mine.json.players.some(p => p[0] === a.id), 'I still see myself');
    assert.ok(mine.json.you.gh > 0 && mine.json.you.gh <= 0.6);
    // an invisible attacker doesn't give their position away
    b.events = []; a.events = [];
    await a.sync(400, 400, [a.act({ t: 'atk' })]);
    await b.sync(500, 400);
    assert.ok(!b.events.some(e => e.e === 'atk'));
    await sleep(700);
    await b.sync(500, 400); assert.ok(b.players.has(a.id), 'visible again');
    // not owned / dead / unknown item ids do nothing
    await a.sync(400, 400, [a.act({ t: 'use', u: 9999 })]);
    assert.equal(a.last.you.gh, 0);
  });
});

test('TNT: after the fuse it hurts and shoves everyone in range except its igniter, and nobody can steer out of the shove', async () => {
  await withServer({}, async (g, base) => {
    Object.assign(g.hub.shop.items.tnt, { fuse: 0.5, radius: 250, damage: 30, push: 300 });
    const { a, b, sa, sb, own } = await setup(g, base, ['tnt']);
    const c = new P(base); await c.join('Far'); const sc = [...g.hub.byId.values()].find(x => x.id === c.id); sc.x = sc.rx = 1500; sc.y = sc.ry = 800;
    a.events = []; b.events = [];
    await a.sync(400, 400, [a.act({ t: 'use', u: own.tnt })]);
    assert.equal(sa.profile.items.length, 0); assert.equal(g.hub.worlds.get('w1').tnts.size, 1);
    await b.sync(500, 400); assert.ok(b.events.some(e => e.e === 'tnt' && e.fuse === 0.5));
    // a late joiner sees the live charge in the full snapshot
    const late = new P(base); await late.join('Late'); assert.equal(late.last.tnts.length, 1);
    await sleep(650);
    await b.sync(500, 400);
    assert.ok(b.events.some(e => e.e === 'boom'));
    assert.equal(sb.hp, 70, 'target took 30');
    assert.equal(sa.hp, 100, 'igniter unhurt'); assert.equal(sc.hp, 100, 'far player unhurt');
    assert.ok(sb.kbRem, 'target is being pushed');
    // steering during the shove is ignored: ask for x=100 and the server still carries them east
    await b.sync(100, 400); await sleep(250); await b.sync(100, 400);
    assert.ok(sb.x > 560, 'pushed away from the blast (was 500, blast at 400): ' + sb.x);
    assert.equal(sa.x, 400, 'igniter not moved');
    const k = (await b.sync(100, 400)).json.you.kb; assert.ok(k >= 0);
    await sleep(500);
    await b.sync(sb.x, sb.y);
    assert.equal(sb.kbRem, null);
    await b.sync(100, 400);                                                          // control returns afterwards
    assert.ok(sb.x < 150);
  });
});

test('TNT kills are credited to the igniter, walls stop the shove, shields protect, and limits apply', async () => {
  await withServer({}, async (g, base) => {
    Object.assign(g.hub.shop.items.tnt, { fuse: 0.3, radius: 300, damage: 100, push: 0 });
    const { a, b, sa, sb, own } = await setup(g, base, ['tnt']);
    sb.hp = 40;
    await a.sync(400, 400, [a.act({ t: 'use', u: own.tnt })]);
    await sleep(450); await b.sync(500, 400);
    assert.equal(sb.dead, true); assert.equal(sa.kills, 1);
    assert.ok(b.events.some(e => e.e === 'kill' && e.kn === 'Igniter'));
    // per-player limit of 3 live charges
    g.hub.shop.items.tnt.fuse = 30;
    const recs = [1, 2, 3, 4].map(() => g.hub.profiles.addItem(sa.profile, { t: 'tnt' }).u);
    for (let i = 0; i < 4; i++) { await sleep(320); await a.sync(400, 400, [a.act({ t: 'use', u: recs[i] })]); }
    assert.equal(g.hub.worlds.get('w1').tnts.size, 3);
    assert.equal(sa.profile.items.length, 1);                                        // the 4th was refused and kept
  });
});

test('image paster: size is dragged, bigger costs more mana, it is tinted/owned by the player and vanishes after its time', async () => {
  await withServer({}, async (g, base) => {
    Object.assign(g.hub.shop.items.image, { life: 0.5, manaPer1000: 1, minSize: 50, maxSize: 400 });
    const { a, b, sa, own } = await setup(g, base, ['image']);
    const img = g.hub.images.put(png(10, 10));
    sa.profile.items[0].img = img.hash;
    sa.mana = 100;
    const mana0 = sa.mana;
    b.events = [];
    await a.sync(400, 400, [a.act({ t: 'use', u: own.image, x: 800, y: 450, w: 100 })]);          // 100×100 → 10 mana
    assert.ok(Math.abs((mana0 - sa.mana) - 10) < 0.6, 'cost ~10: ' + (mana0 - sa.mana));
    const w1 = g.hub.worlds.get('w1');
    assert.equal(w1.images.size, 1); assert.equal(sa.profile.items.length, 0);
    const m = [...w1.images.values()][0];
    assert.equal(m.c, sa.color); assert.equal(m.w, 100);
    await b.sync(500, 400); assert.ok(b.events.some(e => e.e === 'img' && e.img === img.hash && e.life === 0.5));
    const late = new P(base); await late.join('Late'); assert.equal(late.last.imgs.length, 1);
    await sleep(650); assert.equal(w1.images.size, 0);
    // too big a drag is clamped to the maximum; not enough mana → refused, item kept
    g.hub.shop.items.image.manaPer1000 = 0.5;
    const r2 = g.hub.profiles.addItem(sa.profile, { t: 'image', img: img.hash, ar: 1 });
    await sleep(320); sa.mana = 100;
    await a.sync(400, 400, [a.act({ t: 'use', u: r2.u, x: 800, y: 450, w: 5000 })]);
    assert.equal([...w1.images.values()][0].w, 400);
    const r3 = g.hub.profiles.addItem(sa.profile, { t: 'image', img: img.hash, ar: 1 });
    await sleep(320); sa.mana = 3;
    await a.sync(400, 400, [a.act({ t: 'use', u: r3.u, x: 800, y: 450, w: 300 })]);
    assert.equal(sa.profile.items.length, 1, 'kept because 45 mana were needed');
    // an item whose picture is gone can't be used (and isn't wasted)
    g.hub.images.purge(); sa.mana = 100; await sleep(320);
    await a.sync(400, 400, [a.act({ t: 'use', u: r3.u, x: 800, y: 450, w: 60 })]);
    assert.equal(sa.profile.items.length, 1);
  });
});

test('items do nothing in the menu or when switched off by the admin', async () => {
  await withServer({}, async (g, base) => {
    const m = new P(base); await m.join('Menu', { world: 'lobby' });
    const sm = [...g.hub.byId.values()][0];
    const u = g.hub.profiles.addItem(sm.profile, { t: 'invis' }).u;
    await m.sync(100, 100, [m.act({ t: 'use', u })]);
    assert.equal(sm.profile.items.length, 1);
    const a = new P(base); await a.join('Off'); const sa = [...g.hub.byId.values()].find(x => x.id === a.id);
    const v = g.hub.profiles.addItem(sa.profile, { t: 'invis' }).u;
    g.hub.shop.items.invis.enabled = false;
    await a.sync(100, 100, [a.act({ t: 'use', u: v })]);
    assert.equal(sa.profile.items.length, 1); assert.equal(a.last.you.gh, 0);
  });
});

test('menu customiser: name and colour changes apply in the menu only', async () => {
  await withServer({}, async (g, base) => {
    const m = new P(base); await m.join('Old', { world: 'lobby', color: 2 });
    const r = await m.sync(100, 100, [m.act({ t: 'rename', n: '  <b>Fresh</b> Name That Is Long ' }), m.act({ t: 'color', c: 9 })]);
    const sm = [...g.hub.byId.values()][0];
    assert.equal(sm.name, 'bFresh/b Name Th');   // cleaned and cut to 16 characters
     assert.equal(sm.cidx, 9);
    assert.ok(r.json.roster.some(x => x[0] === m.id && x[1] === sm.name));
    await m.sync(100, 100, [m.act({ t: 'color', c: 99 }), m.act({ t: 'color', c: -1 })]);
    assert.equal(sm.cidx, 9);
    const w = new P(base); await w.join('InWorld'); const sw = [...g.hub.byId.values()].find(x => x.id === w.id);
    await w.sync(100, 100, [w.act({ t: 'rename', n: 'Hacker' }), w.act({ t: 'color', c: 5 })]);
    assert.equal(sw.name, 'InWorld'); assert.notEqual(sw.cidx, 5);
  });
});

test('the default portal hover time is 2.5 s: not yet at 2 s, through by 3 s', async () => {
  await withServer({}, async (g, base) => {
    assert.equal(g.config.PORTAL_DWELL, 2.5);
    const m = new P(base); await m.join('Hover', { world: 'lobby' });
    const t0 = Date.now();
    let go = null;
    while (Date.now() - t0 < 3600 && !go) { const r = await m.sync(800, 150); go = r.json.go; await sleep(100); }
    const took = (Date.now() - t0) / 1000;
    assert.ok(go && go.k === 'world', 'travelled');
    assert.ok(took > 2.2 && took < 3.4, 'took ' + took);
  });
});

// ================================================================ persistence + admin

test('coins, inventory, hotbar and the shop settings survive a restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-eco-'));
  let g = null;
  try {
    g = await start({ port: 0, host: '127.0.0.1', env: false, dataDir: dir, config: Object.assign({}, CFG) });
    let base = 'http://127.0.0.1:' + g.port;
    const a = new P(base); await a.join('Saver', { world: 'lobby' });
    await a.shop('buy', { item: 'invis' }); await a.shop('buy', { item: 'invis' }).catch(() => 0);
    const prof = a.profile;
    const pr = [...g.hub.byId.values()][0].profile;
    g.hub.shop.items.tnt.price = 77; g.hub.shopVersion++;
    pr.hotbar = ['draw', 'fist', 'block', null, pr.items[0].u, null, null, null, null];
    g.admin.save(true); await g.close(); g = null;
    assert.ok(fs.existsSync(path.join(dir, 'profiles.json')));
    g = await start({ port: 0, host: '127.0.0.1', env: false, dataDir: dir, config: Object.assign({}, CFG) });
    base = 'http://127.0.0.1:' + g.port; tickets.delete(base);
    const b = new P(base); await b.join('Saver', { world: 'lobby', profile: prof });
    assert.equal(b.profile, prof); assert.equal(b.inv.coins, 5); assert.equal(b.inv.items.length, 1);
    assert.deepEqual(b.inv.hotbar.slice(0, 3), ['draw', 'fist', 'block']);
    assert.equal(g.hub.shop.items.tnt.price, 77);
    await g.close(); g = null;
  } finally { if (g) await g.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

class Admin {
  constructor(base) { this.base = base; this.cookie = ''; }
  async call(route, body) {
    const r = await raw(this.base, '/api/admin/' + route, 'POST', body || {}, Object.assign({ 'X-CC-Admin': '1' }, this.cookie ? { Cookie: this.cookie } : {}));
    const sc = r.headers.get('set-cookie'); if (sc) this.cookie = sc.split(';')[0];
    return r;
  }
  async ready() { await this.call('login', { password: '2468' }); await this.call('password', { current: '2468', password: 'a long password' }); return this; }
}

test('admin: every shop item and its properties can be edited, validated, and take effect at once', async () => {
  await withServer({}, async (g, base) => {
    const ad = await new Admin(base).ready();
    const ov = (await ad.call('overview')).json;
    assert.deepEqual(ov.shop.items.map(i => i.id), ['invis', 'tnt', 'image']);
    assert.ok(ov.shop.items.find(i => i.id === 'tnt').props.some(p => p.key === 'fuse' && p.def === 3));
    assert.ok(ov.shop.eco.some(e => e.key === 'starterCoins'));
    assert.equal(ov.shop.values.items.invis.duration, 20);

    const bad = [{ items: { tnt: { fuse: 0 } } }, { items: { tnt: { price: -5 } } }, { items: { nope: { price: 1 } } }, { items: { tnt: { weird: 1 } } }, { items: { image: { minSize: 500, maxSize: 100 } } }, { eco: { coinMax: 9999 } }, { eco: { x: 1 } }, { items: { tnt: { fuse: 'abc' } } }];
    for (const patch of bad) assert.equal((await ad.call('shop-save', { patch })).status, 400, JSON.stringify(patch));
    assert.equal(g.hub.shop.items.tnt.fuse, 3, 'nothing half-applied');

    const v0 = g.hub.shopVersion;
    const ok = await ad.call('shop-save', { patch: { items: { tnt: { fuse: 5, price: 99, damage: 50, radius: 300, push: 100 }, invis: { duration: 45, price: 7 }, image: { life: 20, price: 10, manaPer1000: 0.5, maxSize: 600 } }, eco: { starterCoins: 100, coinEvery: 4, coinMax: 8, coinValue: 5, coinLife: 60 }, blockedHosts: ['Evil.com', 'https://www.bad.org/x'] } });
    assert.equal(ok.status, 200);
    assert.equal(g.hub.shop.items.tnt.fuse, 5); assert.equal(g.hub.shop.items.invis.duration, 45); assert.equal(g.hub.shop.eco.coinMax, 8);
    assert.deepEqual(g.hub.shop.blockedHosts, ['evil.com', 'bad.org']);
    assert.ok(g.hub.shopVersion > v0);
    assert.ok((await ad.call('logs', { types: ['admin-action'] })).json.entries.some(e => /Shop changed: .*TNT fuse 3 → 5/.test(e.msg)));
    // players see the new prices/starter coins immediately
    const p = new P(base); await p.join('NewGuy', { world: 'lobby' });
    assert.equal(p.inv.coins, 100);
    assert.equal(p.r.catalog.find(i => i.id === 'tnt').price, 99);
    assert.equal(p.r.catalog.find(i => i.id === 'invis').props.duration, 45);
    assert.equal(p.last.sv, g.hub.shopVersion);
    // disable an item
    await ad.call('shop-save', { patch: { items: { invis: { enabled: false } } } });
    assert.equal((await p.shop('catalog')).json.catalog.find(i => i.id === 'invis').enabled, false);
    // reset
    await ad.call('shop-reset');
    assert.equal(g.hub.shop.items.tnt.price, 30); assert.equal(g.hub.shop.items.invis.enabled, true); assert.deepEqual(g.hub.shop.blockedHosts, []);
  });
});

test('admin: give/take coins, see coins and bots, purge pictures, change bot count', async () => {
  await withServer({ BOT_COUNT: 5 }, async (g, base) => {
    const ad = await new Admin(base).ready();
    const p = new P(base); await p.join('Rich');
    let ov = (await ad.call('overview')).json;
    assert.equal(ov.players[0].coins, 20);
    assert.equal(ov.worlds.find(w => w.id === 'w1').bots, 4);
    assert.equal((await ad.call('give-coins', { id: p.id, amount: 80 })).json.coins, 100);
    assert.equal((await ad.call('give-coins', { id: p.id, amount: -500 })).json.coins, 0);            // never below zero
    assert.equal((await ad.call('give-coins', { id: p.id, amount: 0 })).status, 400);
    assert.equal((await ad.call('give-coins', { id: p.id, amount: 1e9 })).status, 400);
    assert.equal((await ad.call('give-coins', { id: 12345, amount: 5 })).status, 404);
    assert.equal((await p.sync(100, 100)).json.you.c, 0);
    // bots follow the admin's setting
    assert.equal((await ad.call('settings', { values: { BOT_COUNT: 2 } })).status, 200);
    W(g).lastBotCheck = 0; g.hub.tick();
    assert.equal([...W(g).players.values()].filter(x => x.bot).length, 1);                              // 2 wanted − 1 player
    // pictures
    g.hub.images.put(png(16, 16));
    assert.equal((await ad.call('purge-images')).json.purged, 1);
    assert.equal(g.hub.images.stats().count, 0);
    assert.ok((await ad.call('logs', { types: ['admin-action'] })).json.entries.some(e => /Gave 80 coins to Rich/.test(e.msg)));
  });
});

test('private worlds: only the owner can add up to 5 bots; bots never count as players; ownership passes on', async () => {
  await withServer({ PRIVATE_SOLO_SEC: 1000 }, async (g, base) => {
    const w = g.hub.createPrivate('x').world;
    const a = new P(base), b = new P(base);
    await a.join('Owner', { world: w.id, color: 0 }); await b.join('Guest', { world: w.id, color: 1 });
    assert.deepEqual(a.last.pb, [0, 1, 5]); assert.deepEqual(b.last.pb, [0, 0, 5]);
    await b.sync(100, 100, [b.act({ t: 'bots', n: 3 })]);                    // a guest can't
    assert.equal([...w.players.values()].filter(p => p.bot).length, 0);
    await a.sync(100, 100, [a.act({ t: 'bots', n: 9 })]);                    // the owner is capped at 5
    const bots = () => [...w.players.values()].filter(p => p.bot);
    assert.equal(bots().length, 5);
    assert.equal(w.count(), 2);                                              // bots are not players
    assert.equal(w.info().count, 2);
    const s = await a.sync(100, 100, [a.act({ t: 'bots', n: 2 })]);
    assert.equal(bots().length, 2); assert.equal(s.json.pb[0], 2);
    assert.ok(a.roster.length === 4 || a.last.roster === undefined);
    g.hub.leave({ id: a.id, token: a.token });                               // owner leaves: the guest takes over
    await sleep(50);
    const r = await b.sync(100, 100, []); assert.equal(r.json.pb[1], 1);
    await b.sync(100, 100, [b.act({ t: 'bots', n: 0 })]); assert.equal(bots().length, 0);
    assert.equal(g.hub.worlds.get('w1').kind, 'public');
    assert.equal([...g.hub.worlds.get('w1').players.values()].filter(p => p.bot).length, 0);   // other worlds are unaffected
  });
});

test('bot AI: they hunt, keep moving, flee when hurt, dodge TNT and never get stuck in one place', async () => {
  await withServer({ BOT_COUNT: 3, SHIELD: 0 }, async (g, base) => {
    const w = W(g);
    const p = new P(base); await p.join('Human', { color: 0 });
    const bots = () => [...w.players.values()].filter(o => o.bot);
    assert.equal(bots().length, 2);
    // roaming: with the human far away they still travel a lot and look for the human
    const me = [...w.players.values()].find(o => !o.bot); me.x = 40; me.y = 40; me.shieldUntil = 1e9;
    const last = bots().map(b => [b.x, b.y]); const dist = bots().map(() => 0);
    for (let i = 0; i < 60; i++) { await sleep(50); bots().forEach((b, j) => { dist[j] += Math.hypot(b.x - last[j][0], b.y - last[j][1]); last[j] = [b.x, b.y]; }); }
    for (const d of dist) assert.ok(d > 300, 'bot travelled ' + d);
    // hurt bots run away from the nearest foe and heal
    const b = bots()[0], o = bots()[1];
    me.shieldUntil = 0; me.dead = true;
    b.x = 800; b.y = 450; b.hp = 20; b.fleeing = false; o.x = 860; o.y = 450; o.shieldUntil = 0; o.atkReady = 1e9;
    await sleep(900);
    assert.ok(b.fleeing && Math.hypot(b.x - o.x, b.y - o.y) > 100, 'fled to ' + Math.round(Math.hypot(b.x - o.x, b.y - o.y)));
    assert.ok(b.hp > 20 || b.mana < 100, 'it healed');
    // a lit TNT makes them leave its blast radius
    me.dead = false; me.x = 40; me.y = 40; me.shieldUntil = 1e9; b.hp = 100; b.fleeing = false; o.hp = 100;
    b.x = 800; b.y = 450; o.x = 1400; o.y = 800;
    w.tnts.set(99, { id: 99, x: 810, y: 450, owner: 0, on: 'x', fuse: 3, boom: g.hub.now() + 3, radius: 220, damage: 35, push: 0 });
    await sleep(1500);
    assert.ok(Math.hypot(b.x - 810, b.y - 450) > 220, 'left the blast zone');
  });
});
