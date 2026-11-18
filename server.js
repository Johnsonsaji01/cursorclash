'use strict';
/*
 * CursorClash server — zero dependencies, HTTP polling only (no WebSockets).
 *
 *   POST /api/challenge   {}                              -> proof-of-work challenge for the human check
 *   POST /api/verify      {ch, nonce, hold, ...}          -> {ticket}
 *   POST /api/join        {ticket, name, world, color}    -> snapshot (+ player id/token)
 *   POST /api/worldinfo   {ticket, world}                 -> {name, count, max, taken:[colour ids]}
 *   POST /api/newprivate  {ticket}                        -> {code}
 *   POST /api/sync        {id, token, x, y, pp, a, ...}   -> state delta
 *   POST /api/leave       {id, token}
 *   GET  /healthz                                         -> "ok"
 *   GET  /                                                -> the game (public/index.html)
 *   GET  /admin                                           -> admin portal (public/admin.html); API under /api/admin/*
 *
 * Everything is also served under the /cursorclash prefix, so both https://host/ and
 * https://host/cursorclash/ work (with or without a reverse proxy that strips the prefix).
 *
 * Game rules live in lib/world.js, world management in lib/hub.js, bot protection in lib/security.js.
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { Security, clientIp, ipKey } = require('./lib/security');
const { Hub } = require('./lib/hub');
const { Admin } = require('./lib/admin');
const VERSION = require('./package.json').version;

const PREFIX = '/cursorclash';

const DEFAULTS = {
  // arena (virtual world size; clients stretch it to fill the window)
  W: 1600, H: 900,
  // combat
  MAX_HP: 100, MAX_MANA: 100, MANA_REGEN: 8,
  ATTACK_COST: 5, ATTACK_DMG: 14, ATTACK_RADIUS: 52, ATTACK_CD: 0.32, HIT_SLACK: 6,
  HEAL_AMOUNT: 35, HEAL_COST: 25, HEAL_CD: 4.5,
  RESPAWN: 2.2, SHIELD: 1.5,
  // ink drawings (cosmetic) and block drawings (walls)
  DRAW_FADE: 3.5,
  MAX_ACTIONS: 24,
  MAX_STROKES_PER_PLAYER: 8, MAX_STROKE_POINTS: 400, MAX_POINTS_PER_ACTION: 60,
  STROKE_OPEN_MAX: 30,
  BLOCK_LIFE: 5, BLOCK_COST_PER_UNIT: 0.05, BLOCK_MIN_LEN: 8, MAX_BLOCKS_PER_PLAYER: 4, CIRCLE_SEGMENTS: 40,
  // players / sync
  IDLE_MS: 8000,                       // drop players that stop polling
  EVENT_KEEP: 8,                       // seconds of events kept for catching up
  // worlds
  MAX_PLAYERS: 30,                     // per public / private world
  LOBBY_MAX: 1,                        // the menu room is private to one player
  PUBLIC_SPAWN_AT: 20,                 // a public world going over this makes a new one
  PUBLIC_EMPTY_SEC: 120, LOBBY_EMPTY_SEC: 5,
  PORTAL_DWELL: 2.5, PORTAL_R: 62, LOBBY_SPAWN_Y: 285, LOBBY_PORTAL_MAX: 15,
  PRIVATE_SOLO_SEC: 300,               // a private world with one player for this long is deleted
  PRIVATE_EMPTY_SEC: 60,
  MAX_PRIVATE_PER_IP: 3, MAX_PRIVATE_TOTAL: 200,
  // bots in World 1, coins, explosions
  BOT_COUNT: 5, COIN_R: 26, KB_TIME: 0.55, IMG_ALLOW_PRIVATE: false,
  // bot / macro protection
  HUMAN_CHECK: true,                   // false = proof-of-work only (for load-testing your own server)
  POW_BITS: 16, CHALLENGE_TTL: 600, MIN_VERIFY_MS: 1200, MIN_HOLD_MS: 900, MIN_MOVES: 3,
  TICKET_TTL: 7200,
  RATE_LIMITS: true,
  CHALLENGE_BURST: 10, CHALLENGE_PER_SEC: 10 / 60,
  VERIFY_BURST: 6, VERIFY_PER_SEC: 6 / 60,
  JOIN_BURST: 12, JOIN_PER_SEC: 0.5,
  INFO_BURST: 20, INFO_PER_SEC: 1,
  NEWPRIVATE_BURST: 3, NEWPRIVATE_PER_SEC: 3 / 60,
  IP_BURST: 400, IP_PER_SEC: 250,      // every request from one network
  SYNC_BURST: 40, SYNC_PER_SEC: 45,    // one player (the client polls about 18 times a second)
  MAX_PLAYERS_PER_IP: 4,
  MAX_SPEED: 14000, MOVE_BURST: 8000,  // cursor speed cap, world units per second
  AFK_ATTACKS: 40, AFK_MIN_MOVE: 6,    // this many attacks with the cursor barely moving = auto-clicker
  STRIKES_TO_BAN: 3, STRIKE_WINDOW_SEC: 600, BAN_SEC: 600,
  TRUST_PROXY: true,                   // read the visitor's address from CF-Connecting-IP / X-Forwarded-For
  SECRET: '', TURNSTILE_SITEKEY: '', TURNSTILE_SECRET: '',
  // admin portal
  ADMIN_INITIAL_PASSWORD: '2468',      // the first login; the portal then forces a new password
  ADMIN_MAX_ATTEMPTS: 5, ADMIN_LOCK_SEC: 900
};

function envConfig(env) {
  const out = {};
  const bool = v => !/^(0|false|off|no)$/i.test(String(v));
  if (env.SECRET || env.CC_SECRET) out.SECRET = env.SECRET || env.CC_SECRET;
  if (env.TURNSTILE_SITEKEY) out.TURNSTILE_SITEKEY = env.TURNSTILE_SITEKEY;
  if (env.TURNSTILE_SECRET) out.TURNSTILE_SECRET = env.TURNSTILE_SECRET;
  if (env.ADMIN_MAX_ATTEMPTS && Number(env.ADMIN_MAX_ATTEMPTS) >= 1) out.ADMIN_MAX_ATTEMPTS = Number(env.ADMIN_MAX_ATTEMPTS);
  if (env.ADMIN_LOCK_SEC && Number(env.ADMIN_LOCK_SEC) >= 1) out.ADMIN_LOCK_SEC = Number(env.ADMIN_LOCK_SEC);
  if (env.ADMIN_INITIAL_PASSWORD) out.ADMIN_INITIAL_PASSWORD = env.ADMIN_INITIAL_PASSWORD;
  if (env.TRUST_PROXY !== undefined) out.TRUST_PROXY = bool(env.TRUST_PROXY);
  if (env.HUMAN_CHECK !== undefined) out.HUMAN_CHECK = bool(env.HUMAN_CHECK);
  for (const k of ['POW_BITS', 'MAX_PLAYERS_PER_IP', 'MAX_PLAYERS', 'PUBLIC_SPAWN_AT', 'PRIVATE_SOLO_SEC']) {
    if (env[k] !== undefined && Number.isFinite(Number(env[k]))) out[k] = Number(env[k]);
  }
  return out;
}

function start(opts = {}) {
  const C = Object.assign({}, DEFAULTS, opts.env === false ? {} : envConfig(process.env), opts.config || {});
  const indexPath = opts.indexPath || path.join(__dirname, 'public', 'index.html');
  const indexHtml = fs.readFileSync(indexPath);
  const adminHtml = fs.readFileSync(opts.adminPath || path.join(__dirname, 'public', 'admin.html'));

  const dataDir = opts.dataDir !== undefined ? opts.dataDir : (opts.env === false ? null : (process.env.DATA_DIR || path.join(__dirname, 'data')));
  const sec = new Security(C, { turnstileVerify: opts.turnstileVerify });
  const hub = new Hub(C, sec, { dataDir });
  const admin = new Admin(hub, sec, C, { dataDir, version: VERSION, initialPassword: C.ADMIN_INITIAL_PASSWORD, maxAttempts: C.ADMIN_MAX_ATTEMPTS, lockSec: C.ADMIN_LOCK_SEC });
  const loop = setInterval(() => hub.tick(), 50);
  loop.unref && loop.unref();

  const SECURITY_HEADERS = {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',            // invite links carry a secret code; never leak it
    'X-Frame-Options': 'DENY'
  };
  const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com; " +
    "style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; " +
    "frame-src https://challenges.cloudflare.com; base-uri 'none'; form-action 'none'";

  // ---------- API ----------
  const tooMany = ipk => { admin.addRate(ipk); return [429, { error: 'Too many requests — slow down a little.' }]; };

  async function api(route, body, req) {
    const ip = clientIp(req, C.TRUST_PROXY), ipk = ipKey(ip);
    if (sec.banned(ipk)) {
      // a player who is already inside gets the same "gone" answer the page understands
      if (route === 'sync' || route === 'leave') return [410, { error: 'Too many automated-looking actions from your network. Try again in a few minutes.', reason: 'banned' }];
      return [403, { error: 'Too many automated-looking actions from your network. Try again in a few minutes.', reason: 'banned' }];
    }
    if (!sec.allow('ip:' + ipk, C.IP_BURST, C.IP_PER_SEC)) return tooMany(ipk);

    switch (route) {
      case 'challenge':
        if (!sec.allow('ch:' + ipk, C.CHALLENGE_BURST, C.CHALLENGE_PER_SEC)) return tooMany(ipk);
        return [200, sec.newChallenge(ipk)];

      case 'verify': {
        if (!sec.allow('vf:' + ipk, C.VERIFY_BURST, C.VERIFY_PER_SEC)) return tooMany(ipk);
        const bad = await sec.verify(body, ipk, ip);
        if (bad) return bad;
        admin.add('verify-ok', 'Human check passed by ' + ip, { ip });
        return [200, { ticket: sec.issueTicket(ipk).ticket }];
      }

      case 'sync': return hub.sync(body);
      case 'shop': return hub.shopOp(body);
      case 'leave': return hub.leave(body);

      case 'join': case 'worldinfo': case 'newprivate': {
        const t = sec.checkTicket(body && body.ticket, ipk);
        if (!t) return [401, { error: 'Please complete the quick human check first.', reason: 'verify' }];
        if (route === 'join') {
          if (!sec.allow('jn:' + ipk, C.JOIN_BURST, C.JOIN_PER_SEC)) return tooMany(ipk);
          return hub.join({ ip, ipk, tid: t.tid, tidExp: t.exp }, body);
        }
        if (route === 'worldinfo') {
          if (!sec.allow('wi:' + ipk, C.INFO_BURST, C.INFO_PER_SEC)) return tooMany(ipk);
          return hub.worldInfo(body.world);
        }
        if (!sec.allow('np:' + ipk, C.NEWPRIVATE_BURST, C.NEWPRIVATE_PER_SEC)) return tooMany(ipk);
        const r = hub.createPrivate(ipk);
        return r.error || [200, { code: r.world.id }];
      }
      default: return [404, { error: 'not found' }];
    }
  }

  function adminApi(route, body, req) {
    const ip = clientIp(req, C.TRUST_PROXY), ipk = ipKey(ip);
    const secure = !!(req.socket && req.socket.encrypted) || /https/i.test(String(req.headers['x-forwarded-proto'] || '')) || /https/i.test(String(req.headers['cf-visitor'] || ''));
    return admin.handle(route, body, req, { ip, ipk, secure });
  }

  // ---------- HTTP ----------
  function send(res, status, payload, headers) {
    const isObj = typeof payload === 'object' && !Buffer.isBuffer(payload);
    const body = isObj ? JSON.stringify(payload) : payload;
    res.writeHead(status, Object.assign({
      'Content-Type': isObj ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store'
    }, SECURITY_HEADERS, headers));
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
      res.writeHead(200, Object.assign({
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Content-Security-Policy': CSP
      }, SECURITY_HEADERS));
      return res.end(req.method === 'HEAD' ? undefined : indexHtml);
    }

    if (pathname === '/admin' || pathname === '/admin/' || pathname === '/admin.html') {
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'method not allowed');
      res.writeHead(200, Object.assign({
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Robots-Tag': 'noindex, nofollow',
        'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
      }, SECURITY_HEADERS));
      return res.end(req.method === 'HEAD' ? undefined : adminHtml);
    }

    const im = /^\/img\/([0-9a-f]{64})$/.exec(pathname);
    if (im) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'method not allowed');
      const rec = hub.images.get(im[1]);
      if (!rec) return send(res, 404, 'not found');
      res.writeHead(200, {
        'Content-Type': rec.type, 'Content-Length': rec.buf.length, 'Cache-Control': 'public, max-age=86400, immutable',
        'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox", 'Referrer-Policy': 'no-referrer'
      });
      return res.end(req.method === 'HEAD' ? undefined : rec.buf);
    }

    const am = /^\/api\/admin\/([a-z-]{3,20})$/.exec(pathname);
    if (am) {
      if (req.method !== 'POST') return send(res, 405, 'method not allowed', { Allow: 'POST' });
      return readBody(req, 16 * 1024, (err, body) => {
        if (err) return send(res, 400, { error: 'bad request' });
        let r;
        try { r = adminApi(am[1], body, req); } catch (e) { r = [500, { error: 'server error' }]; }
        send(res, r[0], r[1], r[2]);
      });
    }

    const m = /^\/api\/(challenge|verify|join|worldinfo|newprivate|sync|leave|shop)$/.exec(pathname);
    if (m) {
      if (req.method !== 'POST') return send(res, 405, 'method not allowed', { Allow: 'POST' });
      return readBody(req, 64 * 1024, (err, body) => {
        if (err) return send(res, 400, { error: 'bad request' });
        Promise.resolve(api(m[1], body, req))
          .then(([status, payload, hdrs]) => send(res, status, payload, hdrs || (status === 429 ? { 'Retry-After': '2' } : undefined)))
          .catch(() => send(res, 500, { error: 'server error' }));
      });
    }

    send(res, 404, 'not found');
  });

  server.keepAliveTimeout = 30000;
  server.requestTimeout = 30000;

  const port = opts.port != null ? opts.port : (parseInt(process.env.PORT, 10) || 3000);
  return new Promise(resolve => {
    server.listen(port, opts.host || '0.0.0.0', () => {
      resolve({
        server, hub, sec, admin, config: C,
        port: server.address().port,
        // the first public world (what most tests poke at)
        get state() { const w = hub.worlds.get('w1'); return { players: w.players, strokes: w.strokes, events: w.events }; },
        tick: () => hub.tick(),
        close: () => new Promise(r => { clearInterval(loop); admin.close(); server.closeAllConnections && server.closeAllConnections(); server.close(() => r()); })
      });
    });
  });
}

module.exports = { start, DEFAULTS };

if (require.main === module) {
  start().then(g => {
    console.log('CursorClash listening on port ' + g.port + ' (also served under ' + PREFIX + '/)');
    if (g.config.TURNSTILE_SITEKEY && g.config.TURNSTILE_SECRET) console.log('Cloudflare Turnstile is ON');
    else console.log('Cloudflare Turnstile is off (set TURNSTILE_SITEKEY and TURNSTILE_SECRET to turn it on)');
    const stop = () => g.close().then(() => process.exit(0));
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
  });
}
