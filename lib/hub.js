'use strict';
/*
 * The hub owns every world and every player.
 *
 *  lobby   (l1, l2, ...)  peaceful hall with portals; each instance holds up to LOBBY_MAX players
 *  public  (w1, w2, ...)  "World 1", "World 2", ...; max MAX_PLAYERS (30). When a public world goes over
 *                         PUBLIC_SPAWN_AT (20) players and no other public world has room below that, a new one
 *                         is generated. Empty extra worlds are removed again after a while (w1 always stays).
 *  private (random code)  invite-link-only. Deleted when empty for a minute, or when only one player has been
 *                         inside for more than PRIVATE_SOLO_SEC (5 minutes).
 */
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const COLORS = require('./colors');
const { World } = require('./world');

const CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

class Hub {
  constructor(C, sec) {
    this.C = C; this.sec = sec;
    this.nextPid = 0;
    this.worlds = new Map();
    this.byId = new Map();            // player id -> player
    this.ipPlayers = new Map();       // ipKey -> Set(player id)
    this.gone = new Map();            // player id -> {reason, exp}: why a player vanished (for a helpful 410)
    this.portals = [];
    this.portalSig = '';
    this.lastSlow = 0; this.lastSweep = 0;
    this.createPublic();
    this.createLobby();
    this.refreshPortals(true);
  }

  now() { return performance.now() / 1000; }

  // ---------- worlds ----------
  createPublic() {
    let n = 1;
    while (this.worlds.has('w' + n)) n++;
    const w = new World(this, 'w' + n, 'public', 'World ' + n);
    w.num = n;
    this.worlds.set(w.id, w);
    return w;
  }

  createLobby() {
    let n = 1;
    while (this.worlds.has('l' + n)) n++;
    const w = new World(this, 'l' + n, 'lobby', 'Lobby');
    w.num = n;
    w.portals = this.portals;
    w.portalVersion = 1;
    this.worlds.set(w.id, w);
    return w;
  }

  // returns {world} or {error: [status, payload]}
  createPrivate(ipk) {
    const C = this.C;
    const privs = [...this.worlds.values()].filter(w => w.kind === 'private');
    if (privs.length >= C.MAX_PRIVATE_TOTAL) return { error: [503, { error: 'Too many private worlds right now — try again in a few minutes.' }] };
    if (privs.filter(w => w.creatorIpk === ipk).length >= C.MAX_PRIVATE_PER_IP) {
      return { error: [429, { error: 'You already have ' + C.MAX_PRIVATE_PER_IP + ' private worlds open. Wait for one to close.' }] };
    }
    let code;
    do {
      code = '';
      const b = crypto.randomBytes(8);
      for (let i = 0; i < 8; i++) code += CODE_ALPHABET[b[i] % CODE_ALPHABET.length];
    } while (this.worlds.has(code));
    const w = new World(this, code, 'private', 'Private world');
    w.creatorIpk = ipk;
    this.worlds.set(code, w);
    return { world: w };
  }

  publicWorlds() { return [...this.worlds.values()].filter(w => w.kind === 'public').sort((a, b) => a.num - b.num); }

  lobbyFor() {
    const lobbies = [...this.worlds.values()].filter(w => w.kind === 'lobby').sort((a, b) => a.num - b.num);
    return lobbies.find(w => w.count() < this.C.LOBBY_MAX) || this.createLobby();
  }

  pickRandomWorld() {
    const C = this.C;
    const open = this.publicWorlds().filter(w => w.count() < w.capacity());
    if (!open.length) return this.createPublic();
    const roomy = open.filter(w => w.count() <= C.PUBLIC_SPAWN_AT);
    const pool = roomy.length ? roomy : open;
    return pool[crypto.randomInt(pool.length)];
  }

  // a public world going over PUBLIC_SPAWN_AT players makes a fresh one, unless a roomy one already exists
  afterJoin(w) {
    if (w.kind !== 'public' || w.count() <= this.C.PUBLIC_SPAWN_AT) return;
    if (!this.publicWorlds().some(o => o.count() <= this.C.PUBLIC_SPAWN_AT)) this.createPublic();
  }

  closeWorld(w, reason) {
    if (!this.worlds.delete(w.id)) return;
    w.closed = true;
    const exp = Date.now() + 60000;
    for (const p of [...w.players.values()]) {
      this.gone.set(p.id, { reason, exp });
      w.players.delete(p.id);
      this.unregister(p);
    }
  }

  // ---------- lobby portals ----------
  buildPortals() {
    const C = this.C;
    const pubs = this.publicWorlds();
    let shown = pubs;
    if (pubs.length > C.LOBBY_PORTAL_MAX) {
      shown = [...pubs.filter(w => w.count() < w.capacity()), ...pubs.filter(w => w.count() >= w.capacity())]
        .slice(0, C.LOBBY_PORTAL_MAX).sort((a, b) => a.num - b.num);
    }
    const total = pubs.reduce((n, w) => n + w.count(), 0);
    const out = [
      { id: 'rand', kind: 'random', x: C.W / 2, y: 150, label: 'Random world', count: total, max: 0, full: false },
      { id: 'priv', kind: 'private', x: C.W - 200, y: 150, label: 'Private world', count: 0, max: 0, full: false }
    ];
    const perRow = 5;
    shown.forEach((w, i) => {
      const row = Math.floor(i / perRow), col = i % perRow;
      const inRow = Math.min(perRow, shown.length - row * perRow);
      out.push({
        id: w.id, kind: 'world', x: Math.round(C.W / 2 + (col - (inRow - 1) / 2) * 260), y: 400 + row * 170,
        label: w.name, count: w.count(), max: w.capacity(), full: w.count() >= w.capacity()
      });
    });
    return out;
  }

  refreshPortals(force) {
    const list = this.buildPortals();
    const sig = JSON.stringify(list);
    if (!force && sig === this.portalSig) return;
    this.portalSig = sig;
    this.portals = list;
    for (const w of this.worlds.values()) if (w.kind === 'lobby') { w.portals = list; w.portalVersion++; }
  }

  // what happens when someone has hovered a portal long enough
  resolvePortal(q) {
    if (q.kind === 'private') return { k: 'private' };
    let w = null;
    if (q.kind === 'random') w = this.pickRandomWorld();
    else { w = this.worlds.get(q.id); if (!w || w.count() >= w.capacity()) return null; }
    return { k: 'world', w: w.id, n: w.name };
  }

  // ---------- players ----------
  unregister(p) {
    this.byId.delete(p.id);
    const set = this.ipPlayers.get(p.ipk);
    if (set) { set.delete(p.id); if (!set.size) this.ipPlayers.delete(p.ipk); }
  }

  clientCfg() {
    const C = this.C;
    return {
      W: C.W, H: C.H, MAX_HP: C.MAX_HP, MAX_MANA: C.MAX_MANA,
      ATTACK_COST: C.ATTACK_COST, ATTACK_RADIUS: C.ATTACK_RADIUS, ATTACK_CD: C.ATTACK_CD,
      HEAL_COST: C.HEAL_COST, HEAL_CD: C.HEAL_CD, HEAL_AMOUNT: C.HEAL_AMOUNT,
      DRAW_FADE: C.DRAW_FADE, MAX_STROKE_POINTS: C.MAX_STROKE_POINTS, MAX_POINTS_PER_ACTION: C.MAX_POINTS_PER_ACTION,
      MAX_ACTIONS: C.MAX_ACTIONS,
      BLOCK_LIFE: C.BLOCK_LIFE, BLOCK_COST_PER_UNIT: C.BLOCK_COST_PER_UNIT, BLOCK_MIN_LEN: C.BLOCK_MIN_LEN,
      CIRCLE_SEGMENTS: C.CIRCLE_SEGMENTS,
      PORTAL_R: C.PORTAL_R, PORTAL_DWELL: C.PORTAL_DWELL, PRIVATE_SOLO_SEC: C.PRIVATE_SOLO_SEC,
      PALETTE: COLORS
    };
  }

  // sess = {ip, ipk, tid, tidExp}; body = {name, world, color}
  join(sess, body) {
    const C = this.C;
    body = body || {};
    const set = this.ipPlayers.get(sess.ipk);
    if (set && set.size >= C.MAX_PLAYERS_PER_IP) {
      return [429, { error: 'Too many players are connected from your network.', code: 'ip' }];
    }
    const want = typeof body.world === 'string' ? body.world.toLowerCase() : 'lobby';
    let w;
    if (want === 'lobby') w = this.lobbyFor();
    else {
      w = this.worlds.get(want);
      if (!w || w.kind === 'lobby' || w.closed) return [404, { error: 'That world doesn\'t exist (any more).', code: 'notfound' }];
    }
    if (w.count() >= w.capacity()) return [409, { error: 'That world is full.', code: 'full' }];

    let cidx;
    if (w.kind === 'lobby' || body.color === undefined || body.color === null) {
      cidx = w.firstFree(body.color);
    } else {
      if (!Number.isInteger(body.color) || body.color < 0 || body.color >= COLORS.length) return [400, { error: 'bad colour' }];
      if (w.isTaken(body.color)) return [409, { error: 'That colour was just taken.', code: 'color', taken: w.takenList() }];
      cidx = body.color;
    }
    if (cidx < 0) return [409, { error: 'That world is full.', code: 'full' }];

    const p = w.addPlayer(sess, body.name, cidx);
    this.byId.set(p.id, p);
    if (!this.ipPlayers.has(p.ipk)) this.ipPlayers.set(p.ipk, new Set());
    this.ipPlayers.get(p.ipk).add(p.id);
    this.afterJoin(w);

    const snap = w.build(p, null, 0, 0, true);
    snap.id = p.id; snap.token = p.token; snap.name = p.name; snap.color = p.color; snap.cidx = p.cidx;
    snap.world = w.info();
    snap.cfg = this.clientCfg();
    return [200, snap];
  }

  worldInfo(id) {
    const w = typeof id === 'string' ? this.worlds.get(id.toLowerCase()) : null;
    if (!w || w.kind === 'lobby' || w.closed) return [404, { error: 'That world doesn\'t exist (any more).', code: 'notfound' }];
    return [200, Object.assign(w.info(), { taken: w.takenList(), palette: COLORS })];
  }

  sync(body) {
    const p = body && this.byId.get(body.id);
    if (!p || p.token !== body.token) {
      const g = body && this.gone.get(body.id);
      return [410, { error: 'unknown player', reason: g ? g.reason : 'gone' }];
    }
    if (!this.sec.allow('p:' + p.id, this.C.SYNC_BURST, this.C.SYNC_PER_SEC)) return [429, { error: 'slow down' }];
    const out = p.world.sync(p, body);
    if (p.flag) {
      const banned = this.sec.strike(p.ipk);
      this.kick(p, banned ? 'banned' : 'verify');
      return [410, { error: banned ? 'Too many automated-looking actions. Try again later.' : 'verify', reason: banned ? 'banned' : 'verify' }];
    }
    return [200, out];
  }

  leave(body) {
    const p = body && this.byId.get(body.id);
    if (!p || p.token !== body.token) return [410, { error: 'unknown player' }];
    p.world.removePlayer(p);
    return [200, { ok: true }];
  }

  // remove a player and make them pass the human check again
  kick(p, reason) {
    this.sec.revoke(p.tid, p.tidExp);
    this.gone.set(p.id, { reason, exp: Date.now() + 60000 });
    p.world.removePlayer(p);
  }

  // ---------- housekeeping ----------
  tick() {
    const t = this.now();
    for (const w of [...this.worlds.values()]) w.tick(t);
    if (t - this.lastSlow >= 1) { this.lastSlow = t; this.lifecycle(t); this.refreshPortals(false); }
    if (t - this.lastSweep >= 30) {
      this.lastSweep = t;
      this.sec.sweep();
      const now = Date.now();
      for (const [k, g] of this.gone) if (now > g.exp) this.gone.delete(k);
    }
  }

  lifecycle(t) {
    const C = this.C;
    for (const w of [...this.worlds.values()]) {
      const n = w.count();
      if (w.kind === 'private') {
        if (n >= 2) { w.soloSince = null; w.emptySince = null; }
        else if (n === 1) {
          w.emptySince = null;
          if (w.soloSince === null) w.soloSince = t;
          else if (t - w.soloSince > C.PRIVATE_SOLO_SEC) this.closeWorld(w, 'closed');
        } else {
          w.soloSince = null;
          if (w.emptySince === null) w.emptySince = t;
          if (t - w.emptySince > C.PRIVATE_EMPTY_SEC) this.closeWorld(w, 'closed');
        }
      } else if (w.kind === 'public' && w.id !== 'w1') {
        if (n === 0 && w.emptySince !== null && t - w.emptySince > C.PUBLIC_EMPTY_SEC) this.closeWorld(w, 'closed');
      } else if (w.kind === 'lobby' && w.id !== 'l1') {
        if (n === 0 && w.emptySince !== null && t - w.emptySince > C.LOBBY_EMPTY_SEC) this.closeWorld(w, 'closed');
      }
    }
  }
}

module.exports = { Hub };
