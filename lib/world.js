'use strict';
/*
 * One game room. Three kinds exist (see hub.js):
 *   lobby   - the main menu: a peaceful room for ONE player; hold still on a portal to travel, click the
 *             customiser or the shop
 *   public  - the real battle arenas, max 30 players
 *   private - invite-link-only arenas
 *
 * A World is authoritative for everything inside it: combat, mana, healing, cooldowns, respawns,
 * drawing lifetime, block-wall collision and (in the lobby) portal dwell time.
 */
const crypto = require('node:crypto');
const COLORS = require('./colors');
const { clamp, r1, r2, num, polyPts, polyLength, segsFrom, truncatePoly, resolveMove } = require('./geometry');

const SHAPES = ['free', 'line', 'rect', 'circle'];
const BOT_NAMES = ['Zap', 'Nova', 'Pixel', 'Glitch', 'Byte', 'Echo', 'Flux', 'Orbit', 'Ripple', 'Spark', 'Blip', 'Comet'];

function cleanName(raw, id) {
  let s = typeof raw === 'string' ? raw : '';
  s = s.replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16);
  return s || 'Player' + String(1000 + (id * 37) % 9000);
}

class World {
  constructor(hub, id, kind, name) {
    this.hub = hub; this.C = hub.C;
    this.id = id; this.kind = kind; this.name = name;
    this.players = new Map();
    this.strokes = new Map();
    this.events = [];
    this.seq = 0;
    this.trimmedThrough = 0;
    this.rosterVersion = 1;
    this.wallSegs = [];
    this.lastTick = hub.now();
    this.emptySince = hub.now();       // set while nobody is inside
    this.soloSince = null;             // private worlds: when the lone player became alone
    this.creatorIpk = null;
    this.portals = [];                 // lobby only
    this.portalVersion = 0;
    this.closed = false;
    this.botsOn = false;               // World 1 keeps bots (see ensureBots)
    this.lastBotCheck = 0;
    this.coins = new Map(); this.coinVersion = 1;
    this.tnts = new Map(); this.images = new Map(); this.propId = 0;
  }

  get peaceful() { return this.kind === 'lobby'; }
  capacity() { return this.kind === 'lobby' ? 1 : this.C.MAX_PLAYERS; }
  count() { let n = 0; for (const p of this.players.values()) if (!p.bot) n++; return n; }       // real players only
  takenList() { return [...this.players.values()].filter(p => !p.bot).map(p => p.cidx); }
  isTaken(i) { for (const p of this.players.values()) if (!p.bot && p.cidx === i) return true; return false; }
  firstFree(prefer) {
    if (Number.isInteger(prefer) && prefer >= 0 && prefer < COLORS.length && !this.isTaken(prefer)) return prefer;
    for (let i = 0; i < COLORS.length; i++) if (!this.isTaken(i)) return i;
    return -1;
  }
  info() { return { id: this.id, kind: this.kind, name: this.name, count: this.count(), max: this.capacity() }; }

  pushEvent(ev) { ev.seq = ++this.seq; ev.ts = this.hub.now(); this.events.push(ev); return ev; }

  rebuildWalls() {
    this.wallSegs = [];
    for (const s of this.strokes.values()) if (s.kind === 'block' && s.done && s.segs) this.wallSegs.push(...s.segs);
  }

  // ---------- players ----------
  addPlayer(sess, name, cidx) {
    const C = this.C, t = this.hub.now();
    const id = ++this.hub.nextPid;
    const sx = C.W / 2, sy = this.kind === 'lobby' ? C.LOBBY_SPAWN_Y : C.H / 2;
    const p = {
      id, token: crypto.randomBytes(12).toString('hex'),
      name: cleanName(name, id), cidx, color: COLORS[cidx][1],
      ip: sess.ip, ipk: sess.ipk, tid: sess.tid, tidExp: sess.tidExp, world: this,
      x: sx, y: sy, rx: sx, ry: sy,
      hp: C.MAX_HP, mana: C.MAX_MANA,
      dead: false, deadUntil: 0, shieldUntil: this.peaceful ? 0 : t + C.SHIELD,
      atkReady: 0, healReady: 0, kills: 0, deaths: 0,
      lastAid: 0, lastSeen: t, joinedAt: t,
      budget: C.MOVE_BURST, lastMoveT: t, afkAtk: 0, moveSince: 0, flag: null,
      portalId: null, portalT: 0, go: null,
      invisUntil: 0, useReady: 0, kbRem: null, kbUntil: 0, profile: null, bot: false
    };
    this.players.set(id, p);
    this.rosterVersion++;
    this.emptySince = null;
    this.pushEvent({ e: 'join', n: p.name });
    return p;
  }

  // ---------- bots (World 1 only): BOT_COUNT minus the real players, so a full table of 5 has none ----------
  addBot() {
    const C = this.C, t = this.hub.now();
    const used = new Set([...this.players.values()].map(o => o.cidx));
    const start = Math.floor(Math.random() * COLORS.length);
    let cidx = -1;
    for (let k = 0; k < COLORS.length; k++) { const i = (start + k) % COLORS.length; if (!used.has(i)) { cidx = i; break; } }
    if (cidx < 0) return null;
    const id = ++this.hub.nextPid;
    const x = 120 + Math.random() * (C.W - 240), y = 120 + Math.random() * (C.H - 240);
    const p = {
      id, token: null, name: 'Bot ' + BOT_NAMES[id % BOT_NAMES.length], cidx, color: COLORS[cidx][1],
      ip: null, ipk: null, tid: null, tidExp: 0, world: this,
      x, y, rx: x, ry: y, hp: C.MAX_HP, mana: C.MAX_MANA,
      dead: false, deadUntil: 0, shieldUntil: t + C.SHIELD, atkReady: t + 1, healReady: 0, kills: 0, deaths: 0,
      lastAid: 0, lastSeen: t, joinedAt: t, budget: 0, lastMoveT: t, afkAtk: 0, moveSince: 0, flag: null,
      portalId: null, portalT: 0, go: null, invisUntil: 0, useReady: 0, kbRem: null, kbUntil: 0, profile: null,
      bot: true, tx: x, ty: y, think: 0, speed: 230 + Math.random() * 130
    };
    this.players.set(id, p);
    this.rosterVersion++;
    return p;
  }

  ensureBots() {
    if (!this.botsOn) return;
    const want = Math.max(0, Math.round(this.C.BOT_COUNT) - this.count());
    const humanColors = new Set([...this.players.values()].filter(o => !o.bot).map(o => o.cidx));
    let bots = [...this.players.values()].filter(o => o.bot);
    while (bots.length > want) {
      const i = Math.max(0, bots.findIndex(b => humanColors.has(b.cidx)));       // the bot wearing a joiner's colour goes first
      const [b] = bots.splice(i, 1);
      this.players.delete(b.id); this.rosterVersion++;
    }
    while (bots.length < want) { const b = this.addBot(); if (!b) break; bots.push(b); }
    for (const b of bots) {                                                      // never share a colour with a real player
      if (!humanColors.has(b.cidx)) continue;
      const used = new Set([...this.players.values()].map(o => o.cidx));
      const free = COLORS.findIndex((_, i) => !used.has(i));
      if (free >= 0) { b.cidx = free; b.color = COLORS[free][1]; this.rosterVersion++; }
    }
  }

  botThink(p, t, dt) {
    const C = this.C;
    if (p.dead || p.kbRem) return;
    let best = null, bd = 380;
    for (const o of this.players.values()) {
      if (o === p || o.dead || t < o.shieldUntil || t < o.invisUntil) continue;      // bots can't see invisible players
      const d = Math.hypot(o.x - p.x, o.y - p.y);
      if (d < bd) { bd = d; best = o; }
    }
    if (best) { p.tx = best.x; p.ty = best.y; }
    else if (t >= p.think || Math.hypot(p.tx - p.x, p.ty - p.y) < 20) { p.tx = 80 + Math.random() * (C.W - 160); p.ty = 80 + Math.random() * (C.H - 160); p.think = t + 2 + Math.random() * 3; }
    const dx = p.tx - p.x, dy = p.ty - p.y, d = Math.hypot(dx, dy);
    if (d > 4) {
      const step = Math.min(d, p.speed * (best ? 1.15 : 0.7) * dt);
      [p.x, p.y] = resolveMove(p.x, p.y, p.x + dx / d * step, p.y + dy / d * step, this.wallSegs, p.id);
    }
    p.rx = p.x; p.ry = p.y;
    if (best && bd <= C.ATTACK_RADIUS * 0.8 && t >= p.atkReady && p.mana >= C.ATTACK_COST) {
      this.doAttack(p);
      p.atkReady = t + C.ATTACK_CD * (1.4 + Math.random());                      // bots swing a little slower than people
    }
    if (p.hp < 45 && p.mana >= C.HEAL_COST && t >= p.healReady) this.doHeal(p);
  }

  removePlayer(p, reason) {
    if (!this.players.delete(p.id)) return;
    this.hub.log('leave', p.name + ' left ' + this.name + ' (' + (reason === 'left' ? 'left' : reason || 'timed out') + ', ' + Math.round(this.hub.now() - p.joinedAt) + ' s, ' + p.kills + ' kills / ' + p.deaths + ' deaths)', { world: this.id, ip: p.ip });
    this.hub.unregister(p);
    this.rosterVersion++;
    const t = this.hub.now();
    for (const s of this.strokes.values()) if (s.owner === p.id && !s.done) this.closeStroke(s, t);
    this.pushEvent({ e: 'leave', n: p.name });
    if (this.count() === 0) this.emptySince = t;
    if (this.botsOn) this.ensureBots();
  }

  // ---------- combat ----------
  doAttack(p) {
    const C = this.C, t = this.hub.now();
    if (this.peaceful || p.dead || t < p.atkReady || p.mana < C.ATTACK_COST) return;
    p.atkReady = t + C.ATTACK_CD;
    p.mana -= C.ATTACK_COST;
    p.shieldUntil = 0;                         // attacking drops spawn protection
    if (t >= p.invisUntil) this.pushEvent({ e: 'atk', id: p.id, x: r1(p.x), y: r1(p.y) });   // an invisible attacker stays unseen
    const reach = C.ATTACK_RADIUS + C.HIT_SLACK;
    for (const o of this.players.values()) {
      if (o === p || o.dead || t < o.shieldUntil) continue;
      if (Math.hypot(o.x - p.x, o.y - p.y) > reach) continue;
      o.hp -= C.ATTACK_DMG;
      this.pushEvent({ e: 'hit', id: o.id, by: p.id, dmg: C.ATTACK_DMG, x: r1(o.x), y: r1(o.y) });
      if (o.hp <= 0) this.kill(o, p);
    }
    // auto-clicker detector: lots of attacks while the cursor never really moved
    if (++p.afkAtk >= C.AFK_ATTACKS) {
      if (p.moveSince < C.AFK_MIN_MOVE) p.flag = 'afk';
      p.afkAtk = 0; p.moveSince = 0;
    }
  }

  doHeal(p) {
    const C = this.C, t = this.hub.now();
    if (this.peaceful || p.dead || t < p.healReady || p.mana < C.HEAL_COST || p.hp >= C.MAX_HP) return;
    p.healReady = t + C.HEAL_CD;
    p.mana -= C.HEAL_COST;
    const gained = Math.min(C.HEAL_AMOUNT, C.MAX_HP - p.hp);
    p.hp += gained;
    this.pushEvent({ e: 'heal', id: p.id, amt: Math.round(gained), x: r1(p.x), y: r1(p.y) });
  }

  kill(victim, killer) {
    victim.hp = 0;
    victim.dead = true;
    victim.deadUntil = this.hub.now() + this.C.RESPAWN;
    victim.deaths++;
    killer.kills++;
    this.rosterVersion++;
    this.hub.log('kill', killer.name + ' clashed ' + victim.name + ' in ' + this.name, { world: this.id });
    this.pushEvent({ e: 'kill', victim: victim.id, killer: killer.id, vn: victim.name, kn: killer.name, x: r1(victim.x), y: r1(victim.y) });
  }

  // ---------- drawings ----------
  closeStroke(s, t) {
    if (s.done) return null;
    if (s.kind === 'block') { this.strokes.delete(s.key); return null; }   // unfinished walls never appear
    s.done = true;
    s.doneAt = t;
    return this.pushEvent({ e: 'stroke', key: s.key, owner: s.owner, c: s.color, sh: s.shape, pts: [], rep: false, d: 1 });
  }

  // A finished block drawing becomes a wall: it costs mana per unit of length (the part you can't afford
  // is cut off), blocks every player except its owner, and disappears after BLOCK_LIFE seconds.
  finalizeBlock(p, s, t) {
    const C = this.C;
    if (p.dead) { this.strokes.delete(s.key); return; }
    const cost = C.BLOCK_COST_PER_UNIT;
    let pts = s.pts;
    if (s.shape === 'free') {
      pts = truncatePoly(pts, p.mana / cost);
    } else if (pts.length >= 2) {
      const full = polyLength(polyPts(s.shape, pts, C.CIRCLE_SEGMENTS));
      if (full * cost > p.mana) {
        const f = p.mana / (full * cost);
        pts = [pts[0], [r1(pts[0][0] + (pts[1][0] - pts[0][0]) * f), r1(pts[0][1] + (pts[1][1] - pts[0][1]) * f)]];
      }
    }
    const poly = polyPts(s.shape, pts, C.CIRCLE_SEGMENTS);
    const len = polyLength(poly);
    if (pts.length < 2 || len < C.BLOCK_MIN_LEN) { this.strokes.delete(s.key); return; }
    p.mana = Math.max(0, p.mana - len * cost);
    s.pts = pts; s.done = true; s.doneAt = t; s.expireAt = t + C.BLOCK_LIFE;
    s.segs = segsFrom(poly, p.id);
    this.rebuildWalls();
    this.pushEvent({ e: 'stroke', key: s.key, owner: p.id, c: s.color, sh: s.shape, pts: s.pts, rep: true, d: 1, k: 'block', life: C.BLOCK_LIFE });
  }

  doStroke(p, a) {
    const C = this.C;
    const shape = a.s;
    if (!SHAPES.includes(shape)) return;
    if (a.b && this.peaceful) return;          // no walls in the lobby
    if (!Number.isInteger(a.k) || a.k < 0 || a.k > 1e9) return;
    if (!Array.isArray(a.p)) return;
    const key = p.id + ':' + a.k;
    const t = this.hub.now();
    const pts = [];
    for (const q of a.p.slice(0, C.MAX_POINTS_PER_ACTION)) {
      if (Array.isArray(q) && num(q[0]) && num(q[1])) pts.push([r1(clamp(q[0], 0, C.W)), r1(clamp(q[1], 0, C.H))]);
    }
    let s = this.strokes.get(key);
    if (!s) {
      if (pts.length < (shape === 'free' ? 1 : 2)) return;   // nothing drawable yet — don't claim a slot
      const kind = a.b ? 'block' : 'ink';
      if (kind === 'block' && p.dead) return;
      let mine = 0;
      for (const o of this.strokes.values()) if (o.owner === p.id && o.kind === kind) mine++;
      if (mine >= (kind === 'block' ? C.MAX_BLOCKS_PER_PLAYER : C.MAX_STROKES_PER_PLAYER)) return;
      s = { key, owner: p.id, color: p.color, shape, kind, pts: [], done: false, doneAt: 0, born: t, expireAt: 0 };
      this.strokes.set(key, s);
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
    if (s.kind === 'block') {                  // walls stay private until they are finished
      if (a.d) this.finalizeBlock(p, s, t);
      return;
    }
    if (changed) this.pushEvent({ e: 'stroke', key, owner: p.id, c: p.color, sh: shape, pts: changed.pts, rep: changed.rep, d: 0 });
    if (a.d) this.closeStroke(s, t);
  }

  // ---------- snapshots ----------
  rosterList() { return [...this.players.values()].map(p => [p.id, p.name, p.color, p.kills, p.deaths, p.bot ? 1 : 0]); }

  strokeSnapshot() {
    const t = this.hub.now();
    return [...this.strokes.values()]
      .filter(s => !(s.kind === 'block' && !s.done))
      .map(s => s.kind === 'block'
        ? { key: s.key, owner: s.owner, c: s.color, sh: s.shape, pts: s.pts, k: 'block', rem: r2(Math.max(0, s.expireAt - t)) }
        : { key: s.key, owner: s.owner, c: s.color, sh: s.shape, pts: s.pts, age: s.done ? r2(t - s.doneAt) : -1 });
  }

  build(p, since, rv, pv, forceFull, cv) {
    const C = this.C, t = this.hub.now();
    const full = forceFull || since == null || since < this.trimmedThrough;
    const out = {
      seq: this.seq, t: r2(t), n: this.count(),
      players: [...this.players.values()].filter(o => o.id === p.id || t >= o.invisUntil).map(o => [      // invisible players are left out for everyone else
        o.id, r1(o.x), r1(o.y), Math.max(0, Math.round(o.hp)), Math.floor(o.mana), o.dead ? 1 : 0, t < o.shieldUntil ? 1 : 0
      ]),
      you: {
        ac: r2(Math.max(0, p.atkReady - t)),
        hc: r2(Math.max(0, p.healReady - t)),
        rs: r2(p.dead ? Math.max(0, p.deadUntil - t) : 0),
        kb: p.kbRem ? r2(Math.max(0, p.kbUntil - t)) : 0,
        gh: r2(Math.max(0, p.invisUntil - t)),
        c: p.profile ? p.profile.coins : 0,
        pv: p.profile ? p.profile.ver : 0
      },
      sv: this.hub.shopVersion || 0
    };
    if (this.kind !== 'lobby' && (full || cv !== this.coinVersion)) {
      out.cv = this.coinVersion;
      out.coins = [...this.coins.values()].map(c => [c.id, c.x, c.y, c.v, r1(Math.max(0, c.exp - t))]);
    }
    if (this.kind === 'lobby') {
      out.you.pt = p.portalId ? [p.portalId, r2(Math.min(1, p.portalT / C.PORTAL_DWELL))] : null;
      if (pv !== this.portalVersion) {
        out.pv = this.portalVersion;
        out.portals = this.portals.map(q => [q.id, q.kind, q.x, q.y, q.count, q.max, q.label, q.full ? 1 : 0]);
      }
    }
    if (this.kind === 'private' && this.count() === 1 && this.soloSince !== null) {
      out.solo = r1(Math.max(0, C.PRIVATE_SOLO_SEC - (t - this.soloSince)));
    }
    if (p.go) { out.go = p.go; p.go = null; }
    if (full) {
      out.full = true;
      out.strokes = this.strokeSnapshot();
      out.tnts = [...this.tnts.values()].map(b => ({ id: b.id, x: b.x, y: b.y, rem: r2(Math.max(0, b.boom - t)), fuse: b.fuse, r: b.radius }));
      out.imgs = [...this.images.values()].map(m => ({ id: m.id, owner: m.owner, c: m.c, img: m.img, x: m.x, y: m.y, w: m.w, h: m.h, rem: r2(Math.max(0, m.exp - t)), life: m.life }));
      out.events = [];
    } else {
      out.events = this.events.filter(ev => ev.seq > since);
    }
    if (full || rv !== this.rosterVersion) { out.rv = this.rosterVersion; out.roster = this.rosterList(); }
    return out;
  }

  // ---------- a sync request from one of my players ----------
  sync(p, body) {
    const C = this.C, t = this.hub.now();
    p.lastSeen = t;

    // The client reports where its cursor has been since the last sync (pp) plus where it is now (x,y).
    // The server walks that path under a speed cap and stops at other players' walls.
    p.budget = Math.min(C.MOVE_BURST, p.budget + C.MAX_SPEED * Math.max(0, t - p.lastMoveT));
    p.lastMoveT = t;
    const raw = [];
    if (Array.isArray(body.pp)) for (const q of body.pp.slice(-12)) if (Array.isArray(q) && num(q[0]) && num(q[1])) raw.push(q);
    if (num(body.x) && num(body.y)) raw.push([body.x, body.y]);
    let px = p.rx, py = p.ry;
    for (const q of raw) {
      let qx = clamp(q[0], 0, C.W), qy = clamp(q[1], 0, C.H);
      const d = Math.hypot(qx - px, qy - py);
      p.moveSince += d;
      if (d > p.budget) {
        const f = d > 0 ? p.budget / d : 0;
        qx = px + (qx - px) * f; qy = py + (qy - py) * f; p.budget = 0;
      } else p.budget -= d;
      px = qx; py = qy;
      p.rx = qx; p.ry = qy;
      if (!p.dead && !p.kbRem) [p.x, p.y] = resolveMove(p.x, p.y, qx, qy, this.wallSegs, p.id);   // no steering while an explosion has you
    }

    if (Array.isArray(body.a)) {
      for (const a of body.a.slice(0, C.MAX_ACTIONS)) {
        if (!a || !Number.isInteger(a.i) || a.i <= p.lastAid) continue;
        p.lastAid = a.i;
        if (a.t === 'atk') this.doAttack(p);
        else if (a.t === 'heal') this.doHeal(p);
        else if (a.t === 'draw') this.doStroke(p, a);
        else if (a.t === 'use') this.useItem(p, a, t);
        else if (a.t === 'rename' && this.peaceful) { p.name = cleanName(a.n, p.id); this.rosterVersion++; }
        else if (a.t === 'color' && this.peaceful && Number.isInteger(a.c) && a.c >= 0 && a.c < COLORS.length) { p.cidx = a.c; p.color = COLORS[a.c][1]; this.rosterVersion++; }
      }
    }
    return this.build(p, num(body.since) ? body.since : null, body.rv, body.pv, false, body.cv);
  }

  // ---------- shop items in use ----------
  useItem(p, a, t) {
    const C = this.C;
    if (this.peaceful || p.dead || !p.profile || t < p.useReady || !Number.isInteger(a.u)) return;
    const rec = p.profile.items.find(i => i.u === a.u);
    if (!rec) return;
    const conf = this.hub.shop.items[rec.t];
    if (!conf || !conf.enabled) return;                                    // switched off by the admin: it stays in the inventory
    const P = this.hub.profiles;
    if (rec.t === 'invis') {
      p.useReady = t + 0.3;
      P.removeItem(p.profile, rec.u);
      p.invisUntil = t + conf.duration;
    } else if (rec.t === 'tnt') {
      let mine = 0;
      for (const b of this.tnts.values()) if (b.owner === p.id) mine++;
      if (mine >= 3 || this.tnts.size >= 12) return;
      p.useReady = t + 0.3;
      P.removeItem(p.profile, rec.u);
      const b = { id: ++this.propId, x: r1(p.x), y: r1(p.y), owner: p.id, on: p.name, fuse: conf.fuse, boom: t + conf.fuse, radius: conf.radius, damage: conf.damage, push: conf.push };
      this.tnts.set(b.id, b);
      this.hub.log('tnt', p.name + ' lit TNT in ' + this.name, { world: this.id });
      this.pushEvent({ e: 'tnt', id: b.id, x: b.x, y: b.y, fuse: b.fuse, r: b.radius, owner: p.id });
    } else if (rec.t === 'image') {
      const img = this.hub.images.get(rec.img);
      if (!img || !num(a.w) || !num(a.x) || !num(a.y)) return;
      let mine = 0;
      for (const m of this.images.values()) if (m.owner === p.id) mine++;
      if (mine >= 3 || this.images.size >= 24) return;
      const ar = rec.ar || 1;
      let w = clamp(a.w, conf.minSize, conf.maxSize), h = w * ar;
      if (h > C.H) { h = C.H; w = h / ar; }
      const cost = w * h / 1000 * conf.manaPer1000;
      if (p.mana < cost) return;
      p.useReady = t + 0.3;
      p.mana -= cost;
      P.removeItem(p.profile, rec.u);
      const m = { id: ++this.propId, owner: p.id, c: p.color, img: rec.img, x: r1(clamp(a.x, 0, C.W)), y: r1(clamp(a.y, 0, C.H)), w: r1(w), h: r1(h), exp: t + conf.life, life: conf.life };
      this.images.set(m.id, m);
      this.pushEvent({ e: 'img', id: m.id, owner: m.owner, c: m.c, img: m.img, x: m.x, y: m.y, w: m.w, h: m.h, life: m.life });
    }
  }

  explode(b, t) {
    const C = this.C;
    this.pushEvent({ e: 'boom', id: b.id, x: b.x, y: b.y, r: b.radius });
    const owner = this.players.get(b.owner) || { id: 0, name: b.on, kills: 0 };
    for (const o of [...this.players.values()]) {
      if (o.id === b.owner || o.dead || t < o.shieldUntil) continue;
      const dx = o.x - b.x, dy = o.y - b.y, d = Math.hypot(dx, dy);
      if (d > b.radius) continue;
      if (b.damage > 0) {
        o.hp -= b.damage;
        this.pushEvent({ e: 'hit', id: o.id, by: b.owner, dmg: b.damage, x: r1(o.x), y: r1(o.y) });
        if (o.hp <= 0) { this.kill(o, owner); continue; }
      }
      if (b.push > 0) {
        const mag = b.push * (1 - 0.6 * d / b.radius);
        const ang = d < 1 ? Math.random() * Math.PI * 2 : Math.atan2(dy, dx);
        o.kbRem = [Math.cos(ang) * mag, Math.sin(ang) * mag];
        o.kbUntil = t + C.KB_TIME;
      }
    }
  }

  coinTick(t, dt) {
    const C = this.C, eco = this.hub.shop.eco;
    for (const [id, c] of this.coins) if (t >= c.exp) { this.coins.delete(id); this.coinVersion++; }
    if (this.count() > 0 && this.coins.size < eco.coinMax && Math.random() < dt / eco.coinEvery) {
      const id = ++this.propId;
      this.coins.set(id, { id, x: r1(70 + Math.random() * (C.W - 140)), y: r1(70 + Math.random() * (C.H - 140)), v: eco.coinValue, exp: t + eco.coinLife });
      this.coinVersion++;
    }
    if (!this.coins.size) return;
    for (const p of this.players.values()) {
      if (p.bot || p.dead || !p.profile) continue;
      for (const [id, c] of this.coins) {
        if (Math.hypot(c.x - p.x, c.y - p.y) > C.COIN_R) continue;
        this.coins.delete(id); this.coinVersion++;
        this.hub.profiles.addCoins(p.profile, c.v);
        this.pushEvent({ e: 'coin', id: p.id, x: c.x, y: c.y, v: c.v });
      }
    }
  }

  // ---------- 20 ticks a second ----------
  tick(t) {
    const C = this.C;
    const dt = Math.min(0.5, t - this.lastTick);
    this.lastTick = t;

    if (this.botsOn && t - this.lastBotCheck >= 1) { this.lastBotCheck = t; this.ensureBots(); }

    for (const p of [...this.players.values()]) {
      if (p.bot) { this.botThink(p, t, dt); }
      else if (t - p.lastSeen > C.IDLE_MS / 1000) { this.removePlayer(p); continue; }
      if (p.kbRem) {                                                           // being blown away by TNT
        if (t >= p.kbUntil || p.dead) { p.kbRem = null; p.rx = p.x; p.ry = p.y; }
        else {
          const f = Math.min(1, dt * 7), sx = p.kbRem[0] * f, sy = p.kbRem[1] * f;
          p.kbRem[0] -= sx; p.kbRem[1] -= sy;
          [p.x, p.y] = resolveMove(p.x, p.y, clamp(p.x + sx, 0, C.W), clamp(p.y + sy, 0, C.H), this.wallSegs, p.id);
          p.rx = p.x; p.ry = p.y;
        }
      }
      if (p.dead) {
        if (t >= p.deadUntil) {
          p.dead = false; p.hp = C.MAX_HP; p.mana = C.MAX_MANA;
          [p.x, p.y] = resolveMove(p.x, p.y, p.rx, p.ry, this.wallSegs, p.id);
          p.shieldUntil = t + C.SHIELD;
          p.atkReady = t + 0.3; p.healReady = 0;
          this.pushEvent({ e: 'spawn', id: p.id });
        }
      } else {
        p.mana = Math.min(C.MAX_MANA, p.mana + C.MANA_REGEN * dt);
        if (this.kind === 'lobby') this.portalTick(p, dt);
      }
    }

    if (!this.peaceful) {
      this.coinTick(t, dt);
      for (const [id, b] of this.tnts) if (t >= b.boom) { this.tnts.delete(id); this.explode(b, t); }
      for (const [id, m] of this.images) if (t >= m.exp) this.images.delete(id);
    }

    for (const s of [...this.strokes.values()]) {
      if (s.kind === 'block') {
        if (!s.done && t - s.born > C.STROKE_OPEN_MAX) this.strokes.delete(s.key);
        else if (s.done && t >= s.expireAt) { this.strokes.delete(s.key); this.rebuildWalls(); }
        continue;
      }
      if (!s.done && t - s.born > C.STROKE_OPEN_MAX) this.closeStroke(s, t);
      if (s.done && t - s.doneAt > C.DRAW_FADE + 0.5) this.strokes.delete(s.key);
    }

    const cutoff = t - C.EVENT_KEEP;
    while (this.events.length && this.events[0].ts < cutoff) this.trimmedThrough = this.events.shift().seq;
  }

  // Lobby: stay inside a portal for PORTAL_DWELL seconds and the server tells you where to go.
  portalTick(p, dt) {
    const C = this.C;
    let hit = null;
    for (const q of this.portals) {
      if (!q.full && Math.hypot(p.x - q.x, p.y - q.y) <= C.PORTAL_R) { hit = q; break; }
    }
    if (!hit) { p.portalId = null; p.portalT = 0; return; }
    if (p.portalId !== hit.id) { p.portalId = hit.id; p.portalT = 0; }
    p.portalT += dt;
    if (p.portalT >= C.PORTAL_DWELL && !p.go) {
      p.go = this.hub.resolvePortal(hit);
      p.portalT = 0;
      if (p.go) this.hub.log('portal', p.name + ' took the ' + hit.label + ' portal' + (p.go.k === 'world' ? ' → ' + p.go.n : ''), { world: this.id });
    }
  }
}

module.exports = { World, cleanName, SHAPES };
