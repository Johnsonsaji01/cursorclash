'use strict';
/*
 * CursorClash server — zero dependencies, HTTP polling only (no WebSockets).
 *
 *   POST /api/join   {name}                         -> full snapshot + player id/token
 *   POST /api/sync   {id,token,x,y,a,since,rv}      -> state delta (players, events, roster)
 *   POST /api/leave  {id,token}                     -> remove player
 *   GET  /healthz                                   -> "ok"
 *   GET  /                                          -> the game (public/index.html)
 *
 * Everything is also served under the /cursorclash prefix, so both
 * https://host/ and https://host/cursorclash/ work (with or without a
 * reverse proxy that strips the prefix).
 *
 * The server is authoritative for combat, mana, healing, cooldowns, respawns
 * and the lifetime of shared drawings. Clients only report where their cursor
 * is and which actions they performed.
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');

const PREFIX = '/cursorclash';

const DEFAULTS = {
  W: 1600, H: 900,                       // virtual world size (clients stretch it to fill the window)
  MAX_HP: 100, MAX_MANA: 100, MANA_REGEN: 8,
  ATTACK_COST: 5, ATTACK_DMG: 14, ATTACK_RADIUS: 52, ATTACK_CD: 0.32, HIT_SLACK: 6,
  HEAL_AMOUNT: 35, HEAL_COST: 25, HEAL_CD: 4.5,
  DRAW_FADE: 3.5,                        // seconds a finished drawing stays visible
  RESPAWN: 2.2, SHIELD: 1.5,
  MAX_PLAYERS: 40,
  IDLE_MS: 8000,                         // drop players that stop polling
  EVENT_KEEP: 8,                         // seconds of events kept for catching up
  MAX_ACTIONS: 24,
  MAX_STROKES_PER_PLAYER: 8, MAX_STROKE_POINTS: 400, MAX_POINTS_PER_ACTION: 60,
  STROKE_OPEN_MAX: 30                    // an unfinished drawing is closed after this many seconds
};

const PALETTE = ['#ff5c7a', '#ffb347', '#7be07b', '#5cc8ff', '#c792ff', '#ffe24d', '#ff8fd8', '#4de3c5'];

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const r1 = v => Math.round(v * 10) / 10;
const r2 = v => Math.round(v * 100) / 100;
const num = v => (typeof v === 'number' && Number.isFinite(v));

function cleanName(raw, id) {
  let s = typeof raw === 'string' ? raw : '';
  s = s.replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16);
  return s || 'Player' + String(1000 + (id * 37) % 9000);
}

function start(opts = {}) {
  const C = Object.assign({}, DEFAULTS, opts.config || {});
  const now = () => performance.now() / 1000;
  const indexPath = opts.indexPath || path.join(__dirname, 'public', 'index.html');
  const indexHtml = fs.readFileSync(indexPath);

  const players = new Map();      // id -> player
  const strokes = new Map();      // key -> stroke
  const events = [];              // {seq, ts, e, ...}
  let seq = 0;
  let trimmedThrough = 0;         // highest event seq that was dropped from the log
  let nextId = 0;
  let rosterVersion = 1;
  let lastTick = now();

  // ---------- events ----------
  function pushEvent(ev) { ev.seq = ++seq; ev.ts = now(); events.push(ev); return ev; }

  // ---------- players ----------
  function pickColor() {
    const used = new Set([...players.values()].map(p => p.color));
    for (const c of PALETTE) if (!used.has(c)) return c;
    return 'hsl(' + Math.floor(Math.random() * 360) + ',85%,65%)';
  }

  function addPlayer(name) {
    const id = ++nextId;
    const t = now();
    const p = {
      id, token: crypto.randomBytes(12).toString('hex'),
      name: cleanName(name, id), color: pickColor(),
      x: C.W / 2, y: C.H / 2, rx: C.W / 2, ry: C.H / 2,
      hp: C.MAX_HP, mana: C.MAX_MANA,
      dead: false, deadUntil: 0, shieldUntil: t + C.SHIELD,
      atkReady: 0, healReady: 0,
      kills: 0, deaths: 0,
      lastAid: 0, lastSeen: t
    };
    players.set(id, p);
    rosterVersion++;
    pushEvent({ e: 'join', n: p.name });
    return p;
  }

  function removePlayer(p) {
    if (!players.delete(p.id)) return;
    rosterVersion++;
    const t = now();
    for (const s of strokes.values()) {       // let their drawings finish fading
      if (s.owner === p.id && !s.done) closeStroke(s, t);
    }
    pushEvent({ e: 'leave', n: p.name });
  }

  // ---------- combat ----------
  function doAttack(p) {
    const t = now();
    if (p.dead || t < p.atkReady || p.mana < C.ATTACK_COST) return;
    p.atkReady = t + C.ATTACK_CD;
    p.mana -= C.ATTACK_COST;
    p.shieldUntil = 0;                         // attacking drops spawn protection
    pushEvent({ e: 'atk', id: p.id, x: r1(p.x), y: r1(p.y) });
    const reach = C.ATTACK_RADIUS + C.HIT_SLACK;
    for (const o of players.values()) {
      if (o === p || o.dead || t < o.shieldUntil) continue;
      if (Math.hypot(o.x - p.x, o.y - p.y) > reach) continue;
      o.hp -= C.ATTACK_DMG;
      pushEvent({ e: 'hit', id: o.id, by: p.id, dmg: C.ATTACK_DMG, x: r1(o.x), y: r1(o.y) });
      if (o.hp <= 0) kill(o, p);
    }
  }

  function doHeal(p) {
    const t = now();
    if (p.dead || t < p.healReady || p.mana < C.HEAL_COST || p.hp >= C.MAX_HP) return;
    p.healReady = t + C.HEAL_CD;
    p.mana -= C.HEAL_COST;
    const gained = Math.min(C.HEAL_AMOUNT, C.MAX_HP - p.hp);
    p.hp += gained;
    pushEvent({ e: 'heal', id: p.id, amt: Math.round(gained), x: r1(p.x), y: r1(p.y) });
  }

  function kill(victim, killer) {
    victim.hp = 0;
    victim.dead = true;
    victim.deadUntil = now() + C.RESPAWN;
    victim.deaths++;
    killer.kills++;
    rosterVersion++;
    pushEvent({ e: 'kill', victim: victim.id, killer: killer.id, vn: victim.name, kn: killer.name, x: r1(victim.x), y: r1(victim.y) });
  }

  // ---------- drawings ----------
  function closeStroke(s, t) {
    if (s.done) return null;
    s.done = true;
    s.doneAt = t;
    return pushEvent({ e: 'stroke', key: s.key, owner: s.owner, c: s.color, sh: s.shape, pts: [], rep: false, d: 1 });
  }

  function doStroke(p, a) {
    const shape = a.s;
    if (!['free', 'line', 'rect', 'circle'].includes(shape)) return;
    if (!Number.isInteger(a.k) || a.k < 0 || a.k > 1e9) return;
    if (!Array.isArray(a.p)) return;
    const key = p.id + ':' + a.k;
    const t = now();
    const pts = [];
    for (const q of a.p.slice(0, C.MAX_POINTS_PER_ACTION)) {
      if (Array.isArray(q) && num(q[0]) && num(q[1])) pts.push([r1(clamp(q[0], 0, C.W)), r1(clamp(q[1], 0, C.H))]);
    }
    let s = strokes.get(key);
    if (!s) {
      if (pts.length < (shape === 'free' ? 1 : 2)) return;   // nothing drawable yet — don't claim a slot
      let mine = 0;
      for (const o of strokes.values()) if (o.owner === p.id) mine++;
      if (mine >= C.MAX_STROKES_PER_PLAYER) return;
      s = { key, owner: p.id, color: p.color, shape, pts: [], done: false, doneAt: 0, born: t };
      strokes.set(key, s);
    }
    if (s.done) return;                        // finished drawings are immutable
    let changed = null;
    if (shape === 'free') {
      const room = C.MAX_STROKE_POINTS - s.pts.length;
      const add = pts.slice(0, Math.max(0, room));
      if (add.length) { s.pts.push(...add); changed = { pts: add, rep: false }; }
    } else if (pts.length >= 2) {
      s.pts = [pts[0], pts[1]];
      changed = { pts: s.pts, rep: true };
    }
    if (changed) {
      pushEvent({ e: 'stroke', key, owner: p.id, c: p.color, sh: shape, pts: changed.pts, rep: changed.rep, d: 0 });
    }
    if (a.d) closeStroke(s, t);
  }

  // ---------- snapshots ----------
  function rosterList() {
    return [...players.values()].map(p => [p.id, p.name, p.color, p.kills, p.deaths]);
  }

  function strokeSnapshot() {
    const t = now();
    return [...strokes.values()].map(s => ({
      key: s.key, owner: s.owner, c: s.color, sh: s.shape, pts: s.pts,
      age: s.done ? r2(t - s.doneAt) : -1
    }));
  }

  function build(p, since, rv, forceFull) {
    const t = now();
    const full = forceFull || since == null || since < trimmedThrough;
    const out = {
      seq,
      players: [...players.values()].map(o => [
        o.id, r1(o.x), r1(o.y), Math.max(0, Math.round(o.hp)), Math.floor(o.mana), o.dead ? 1 : 0, t < o.shieldUntil ? 1 : 0
      ]),
      you: {
        ac: r2(Math.max(0, p.atkReady - t)),
        hc: r2(Math.max(0, p.healReady - t)),
        rs: r2(p.dead ? Math.max(0, p.deadUntil - t) : 0)
      }
    };
    if (full) {
      out.full = true;
      out.strokes = strokeSnapshot();
      out.events = [];
    } else {
      out.events = events.filter(ev => ev.seq > since);
    }
    if (full || rv !== rosterVersion) { out.rv = rosterVersion; out.roster = rosterList(); }
    return out;
  }

  // ---------- game loop ----------
  function tick() {
    const t = now();
    const dt = Math.min(0.5, t - lastTick);
    lastTick = t;

    for (const p of [...players.values()]) {
      if (t - p.lastSeen > C.IDLE_MS / 1000) { removePlayer(p); continue; }
      if (p.dead) {
        if (t >= p.deadUntil) {
          p.dead = false; p.hp = C.MAX_HP; p.mana = C.MAX_MANA;
          p.x = p.rx; p.y = p.ry;
          p.shieldUntil = t + C.SHIELD;
          p.atkReady = t + 0.3; p.healReady = 0;
          pushEvent({ e: 'spawn', id: p.id });
        }
      } else {
        p.mana = Math.min(C.MAX_MANA, p.mana + C.MANA_REGEN * dt);
      }
    }

    for (const s of [...strokes.values()]) {
      if (!s.done && t - s.born > C.STROKE_OPEN_MAX) closeStroke(s, t);
      if (s.done && t - s.doneAt > C.DRAW_FADE + 0.5) strokes.delete(s.key);
    }

    const cutoff = t - C.EVENT_KEEP;
    while (events.length && events[0].ts < cutoff) trimmedThrough = events.shift().seq;
  }
  const loop = setInterval(tick, 50);
  loop.unref && loop.unref();

  // ---------- API ----------
  function api(route, body) {
    if (route === 'join') {
      if (players.size >= C.MAX_PLAYERS) return [503, { error: 'Server is full — try again in a moment.' }];
      const p = addPlayer(body && body.name);
      const snap = build(p, null, 0, true);
      snap.id = p.id; snap.token = p.token; snap.name = p.name; snap.color = p.color;
      snap.cfg = {
        W: C.W, H: C.H, MAX_HP: C.MAX_HP, MAX_MANA: C.MAX_MANA,
        ATTACK_COST: C.ATTACK_COST, ATTACK_RADIUS: C.ATTACK_RADIUS, ATTACK_CD: C.ATTACK_CD,
        HEAL_COST: C.HEAL_COST, HEAL_CD: C.HEAL_CD, HEAL_AMOUNT: C.HEAL_AMOUNT,
        DRAW_FADE: C.DRAW_FADE, MAX_STROKE_POINTS: C.MAX_STROKE_POINTS, MAX_POINTS_PER_ACTION: C.MAX_POINTS_PER_ACTION,
        MAX_ACTIONS: C.MAX_ACTIONS
      };
      return [200, snap];
    }

    const p = body && players.get(body.id);
    if (!p || p.token !== body.token) return [410, { error: 'unknown player' }];

    if (route === 'leave') { removePlayer(p); return [200, { ok: true }]; }

    // route === 'sync'
    p.lastSeen = now();
    if (num(body.x) && num(body.y)) {
      p.rx = clamp(body.x, 0, C.W);
      p.ry = clamp(body.y, 0, C.H);
      if (!p.dead) { p.x = p.rx; p.y = p.ry; }
    }
    if (Array.isArray(body.a)) {
      for (const a of body.a.slice(0, C.MAX_ACTIONS)) {
        if (!a || !Number.isInteger(a.i) || a.i <= p.lastAid) continue;
        p.lastAid = a.i;
        if (a.t === 'atk') doAttack(p);
        else if (a.t === 'heal') doHeal(p);
        else if (a.t === 'draw') doStroke(p, a);
      }
    }
    return [200, build(p, num(body.since) ? body.since : null, body.rv, false)];
  }

  // ---------- HTTP ----------
  function send(res, status, payload, headers) {
    const body = typeof payload === 'string' || Buffer.isBuffer(payload) ? payload : JSON.stringify(payload);
    res.writeHead(status, Object.assign({
      'Content-Type': typeof payload === 'object' && !Buffer.isBuffer(payload) ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    }, headers));
    res.end(body);
  }

  function readBody(req, limit, cb) {
    const chunks = []; let size = 0; let dead = false;
    req.on('data', c => {
      if (dead) return;
      size += c.length;
      if (size > limit) { dead = true; cb(new Error('too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (dead) return;
      try { cb(null, JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch (e) { cb(e); }
    });
    req.on('error', () => { if (!dead) { dead = true; cb(new Error('read error')); } });
  }

  const server = http.createServer((req, res) => {
    let pathname;
    let search = '';
    try { const u = new URL(req.url, 'http://localhost'); pathname = u.pathname; search = u.search; }
    catch (e) { return send(res, 400, 'bad request'); }

    if (pathname === PREFIX) return send(res, 301, '', { Location: PREFIX + '/' + search });
    if (pathname.startsWith(PREFIX + '/')) pathname = pathname.slice(PREFIX.length);

    if (pathname === '/healthz') return send(res, 200, 'ok');

    if (pathname === '/' || pathname === '/index.html') {
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'method not allowed');
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff'
      });
      return res.end(req.method === 'HEAD' ? undefined : indexHtml);
    }

    const m = /^\/api\/(join|sync|leave)$/.exec(pathname);
    if (m) {
      if (req.method !== 'POST') return send(res, 405, 'method not allowed', { Allow: 'POST' });
      return readBody(req, 64 * 1024, (err, body) => {
        if (err) return send(res, 400, { error: 'bad request' });
        const [status, payload] = api(m[1], body);
        send(res, status, payload);
      });
    }

    send(res, 404, 'not found');
  });

  server.keepAliveTimeout = 30000;

  const port = opts.port != null ? opts.port : (parseInt(process.env.PORT, 10) || 3000);
  return new Promise(resolve => {
    server.listen(port, opts.host || '0.0.0.0', () => {
      resolve({
        server,
        port: server.address().port,
        state: { players, strokes, events },
        tick,
        close: () => new Promise(r => { clearInterval(loop); server.closeAllConnections && server.closeAllConnections(); server.close(() => r()); })
      });
    });
  });
}

module.exports = { start, DEFAULTS };

if (require.main === module) {
  start().then(g => {
    console.log('CursorClash listening on port ' + g.port + ' (also served under ' + PREFIX + '/)');
    const stop = () => g.close().then(() => process.exit(0));
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
  });
}
