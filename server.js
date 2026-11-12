'use strict';

/** CursorClash: dependency-free, HTTP-only multiplayer game server. */
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const W = 1600;
const H = 900;
const MAX_PLAYERS = 60;
const DRAW_TTL_MS = 3500;
const drawings = [];
let nextDrawingId = 0;
const HEAL = Object.freeze({ cost: 25, amount: 35, cooldown: 4500 });
const BASE_PATH = '/cursorclash'; // Allow the arena to live below this URL path.
const INACTIVE_MS = 15000;
const RESPAWN_MS = 3000;
const MANA_REGEN = 10; // points per second
const HEALTH_REGEN = 3; // points per second (after five undamaged seconds)

const WEAPONS = Object.freeze({
  spark:   { cost: 10, damage: 14, range: 250, cooldown: 280, mode: 'single' },
  lance:   { cost: 24, damage: 34, range: 380, cooldown: 780, mode: 'single' },
  nova:    { cost: 36, damage: 27, range: 155, cooldown: 1050, mode: 'area' },
  phantom: { cost: 50, damage: 70, range: 520, cooldown: 1550, mode: 'single' },
});
const COLORS = new Set(['#74f7dc', '#a995ff', '#ff87b8', '#ffcd75', '#79b8ff', '#e5fa87']);
const players = new Map();
const effects = [];
let latestEventId = 0;
let lastTick = Date.now();

const clamp = (n, min, max) => Math.max(min, Math.min(max, Number.isFinite(n) ? n : min));
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
function emit(event) {
  effects.push({ id: ++latestEventId, at: Date.now(), ...event });
  if (effects.length > 150) effects.splice(0, effects.length - 150);
}
function publicPlayer(p) {
  return { id: p.id, name: p.name, color: p.color, x: p.x, y: p.y,
    hp: Math.round(p.hp * 10) / 10, mana: Math.round(p.mana * 10) / 10,
    alive: p.alive, kills: p.kills, deaths: p.deaths, weapon: p.weapon,
    respawnAt: p.respawnAt, nextShotAt: p.nextShotAt, nextHealAt: p.nextHealAt };
}
function step() {
  const now = Date.now();
  const dt = Math.min((now - lastTick) / 1000, 0.3);
  lastTick = now;
  while (drawings.length && drawings[0].expiresAt <= now) drawings.shift();
  for (const [id, p] of players) {
    if (now - p.lastSeen > INACTIVE_MS) { players.delete(id); continue; }
    if (!p.alive) {
      if (now >= p.respawnAt) {
        p.alive = true;
        p.hp = 100;
        p.mana = 100;
        p.x = Math.round(140 + Math.random() * (W - 280));
        p.y = Math.round(140 + Math.random() * (H - 280));
        p.nextShotAt = now + 450;
        p.nextHealAt = now + 650;
        emit({ type: 'respawn', who: p.id, x: p.x, y: p.y });
      }
      continue;
    }
    p.mana = Math.min(100, p.mana + MANA_REGEN * dt);
    if (now - p.lastDamaged > 5000) p.hp = Math.min(100, p.hp + HEALTH_REGEN * dt);
  }
}
setInterval(step, 50).unref();

function attack(attacker, weaponId, now) {
  const w = WEAPONS[weaponId];
  if (!w) return 'Unknown weapon';
  if (!attacker.alive) return 'Respawning';
  if (now < attacker.nextShotAt) return 'Weapon recharging';
  if (attacker.mana + 0.001 < w.cost) return 'Not enough mana';

  attacker.mana -= w.cost;
  attacker.weapon = weaponId;
  attacker.nextShotAt = now + w.cooldown;
  const candidates = [...players.values()].filter(
    p => p.id !== attacker.id && p.alive && distance(attacker, p) <= w.range
  );
  const targets = w.mode === 'area'
    ? candidates
    : candidates.sort((a, b) => distance(attacker, a) - distance(attacker, b)).slice(0, 1);

  const hits = [];
  for (const target of targets) {
    target.hp = Math.max(0, target.hp - w.damage);
    target.lastDamaged = now;
    hits.push({ id: target.id, x: target.x, y: target.y, damage: w.damage });
    if (target.hp <= 0) {
      target.alive = false;
      target.respawnAt = now + RESPAWN_MS;
      target.deaths++;
      attacker.kills++;
      emit({ type: 'kill', killer: attacker.name, victim: target.name,
        killerId: attacker.id, victimId: target.id });
    }
  }
  emit({ type: 'shot', from: attacker.id, weapon: weaponId,
    x: attacker.x, y: attacker.y, hits });
  return null;
}

function heal(p, now) {
  if (!p.alive) return 'Respawning';
  if (p.hp >= 100) return 'Health already full';
  if (now < p.nextHealAt) return 'Healing recharging';
  if (p.mana < HEAL.cost) return 'Not enough mana';
  p.mana -= HEAL.cost;
  p.hp = Math.min(100, p.hp + HEAL.amount);
  p.nextHealAt = now + HEAL.cooldown;
  emit({ type: 'heal', who: p.id, x: p.x, y: p.y });
  return null;
}
function drawShape(p, action, now) {
  if (!p.alive) return 'Respawning';
  if (now - p.lastDrawAt < 140) return 'Drawing too quickly';
  const shapes = new Set(['pen', 'line', 'rect', 'circle']);
  if (!shapes.has(action.shape) || !Array.isArray(action.points)) return 'Invalid drawing';
  const validCount = action.shape === 'pen'
    ? action.points.length >= 2 && action.points.length <= 48
    : action.points.length === 2;
  if (!validCount || !action.points.every(q => Array.isArray(q) && q.length === 2 &&
    q.every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1600))) {
    return 'Invalid drawing';
  }
  const points = action.points.map(q => [Math.round(clamp(q[0], 0, W)), Math.round(clamp(q[1], 0, H))]);
  drawings.push({ id: ++nextDrawingId, by: p.id, color: p.color,
    shape: action.shape, points, expiresAt: now + DRAW_TTL_MS });
  if (drawings.length > 42) drawings.splice(0, drawings.length - 42);
  p.lastDrawAt = now;
  return null;
}

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff' });
  res.end(body);
}
async function getJson(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk.toString('utf8');
    if (raw.length > 8192) throw new Error('Request too large');
  }
  try { return JSON.parse(raw || '{}'); }
  catch { throw new Error('Invalid JSON'); }
}
function validateSession(data) {
  const p = players.get(data.id);
  if (!p || typeof data.token !== 'string' || !/^[0-9a-f]{48}$/.test(data.token)
    || !crypto.timingSafeEqual(Buffer.from(p.token, 'hex'), Buffer.from(data.token, 'hex'))) return null;
  return p;
}
const staticFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
]);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const rawPath = url.pathname;
  if (rawPath === BASE_PATH) {
    res.writeHead(308, { Location: BASE_PATH + '/' });
    return res.end();
  }
  const route = rawPath.startsWith(BASE_PATH + '/') ? rawPath.slice(BASE_PATH.length) : rawPath;
  try {
    if (req.method === 'GET' && route === '/api/health') {
      return send(res, 200, { status: 'ok', protocol: 'http-polling', players: players.size,
        uptime: Math.floor(process.uptime()) });
    }
    if (req.method === 'POST' && route === '/api/join') {
      const data = await getJson(req);
      if (players.size >= MAX_PLAYERS) return send(res, 503, { error: 'Arena is full' });
      const name = String(data.name || '').trim().replace(/[^\p{L}\p{N}_ .-]/gu, '').slice(0, 18);
      if (name.length < 2) return send(res, 400, { error: 'Choose a name with 2–18 characters' });
      const color = COLORS.has(data.color) ? data.color : '#74f7dc';
      const id = crypto.randomBytes(10).toString('hex');
      const token = crypto.randomBytes(24).toString('hex');
      const p = { id, token, name, color,
        x: Math.round(140 + Math.random() * (W - 280)),
        y: Math.round(140 + Math.random() * (H - 280)), hp: 100, mana: 100,
        alive: true, kills: 0, deaths: 0, weapon: 'spark', nextShotAt: 0,
        respawnAt: 0, lastSeen: Date.now(), lastDamaged: 0, lastActionSeq: 0,
        nextHealAt: 0, lastDrawAt: 0 };
      players.set(id, p);
      emit({ type: 'join', who: p.name, color: p.color });
      return send(res, 200, { id, token, player: publicPlayer(p), eventId: latestEventId,
        world: { width: W, height: H }, weapons: WEAPONS, heal: HEAL });
    }
    if (req.method === 'POST' && route === '/api/sync') {
      const data = await getJson(req);
      const p = validateSession(data);
      if (!p) return send(res, 401, { error: 'Session expired. Rejoin the arena.' });
      const now = Date.now();
      p.lastSeen = now;
      p.x = clamp(Number(data.x), 12, W - 12);
      p.y = clamp(Number(data.y), 12, H - 12);
      if (WEAPONS[data.weapon]) p.weapon = data.weapon;
      let notice = null;
      if (Array.isArray(data.actions)) {
        for (const action of data.actions.slice(0, 5)) {
          const seq = Number(action.seq);
          if (!Number.isSafeInteger(seq) || seq <= p.lastActionSeq || seq > 1000000000) continue;
          p.lastActionSeq = seq;
          const error = action.kind === 'heal' ? heal(p, now)
            : action.kind === 'draw' ? drawShape(p, action, now)
            : attack(p, action.weapon, now);
          notice = error || notice;
        }
      }
      const since = Math.max(0, Number(data.since) || 0);
      return send(res, 200, {
        now, me: publicPlayer(p),
        players: [...players.values()].map(publicPlayer),
        drawings, online: players.size, latestEventId,
        events: effects.filter(e => e.id > since).slice(-60),
        notice,
      });
    }
    if (req.method === 'POST' && route === '/api/leave') {
      const data = await getJson(req);
      const p = validateSession(data);
      if (p) players.delete(p.id);
      return send(res, 200, { ok: true });
    }
    if (req.method === 'GET' && staticFiles.has(route)) {
      const [file, type] = staticFiles.get(route);
      const body = await fs.readFile(path.join(__dirname, 'public', file));
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': body.length,
        'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
      return res.end(body);
    }
    return send(res, 404, { error: 'Not found' });
  } catch (error) {
    const clientError = error.message === 'Invalid JSON' || error.message === 'Request too large';
    if (!clientError) console.error(error);
    return send(res, clientError ? 400 : 500, { error: clientError ? error.message : 'Server error' });
  }
});
server.listen(PORT, HOST, () => {
  console.log(`CursorClash HTTP-only arena running at http://${HOST}:${PORT}`);
});
