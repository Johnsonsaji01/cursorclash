'use strict';
/*
 * The hub owns every world and every player.
 *
 *  lobby   (l1, l2, ...)  the main menu screen: a private room for ONE player (not a world, nobody else is ever
 *                         in it) with portals, the colour/name customiser and the shop
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
const { Profiles } = require('./profiles');
const { ImageStore } = require('./images');
const { ITEMS, ITEM_IDS, INV_MAX, HOTBAR, defaultShop, publicCatalog } = require('./shop');

const CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

class Hub {
  constructor(C, sec, opts = {}) {
    this.C = C; this.sec = sec;
    this.profiles = opts.profiles || new Profiles({ dataDir: opts.dataDir });
    this.images = opts.images || new ImageStore({ dataDir: opts.dataDir, allowPrivate: !!C.IMG_ALLOW_PRIVATE });
    this.shop = defaultShop();                          // edited live from the admin portal
    this.images.blocked = () => this.shop.blockedHosts;
    this.nextPid = 0;
    this.worlds = new Map();
    this.byId = new Map();            // player id -> player
    this.ipPlayers = new Map();       // ipKey -> Set(player id)
    this.gone = new Map();            // player id -> {reason, exp}: why a player vanished (for a helpful 410)
    this.portals = [];
    this.portalSig = '';
    this.shopVersion = 1;             // bumps whenever the admin changes the shop (clients re-read the catalogue)
    this.logger = null;               // (type, msg, extra) => void, set by the admin module
    this.settings = { on: false, message: '' };   // maintenance mode (shared with the admin module)
    this.lastSlow = 0; this.lastSweep = 0;
    this.createPublic();
    this.refreshPortals(true);
  }

  now() { return performance.now() / 1000; }
  log(type, msg, extra) { if (this.logger) { try { this.logger(type, msg, extra); } catch (e) { /* ignore */ } } }

  // ---------- worlds ----------
  createPublic() {
    let n = 1;
    while (this.worlds.has('w' + n)) n++;
    const w = new World(this, 'w' + n, 'public', 'World ' + n);
    w.num = n;
    w.botsOn = n === 1;                                 // World 1 keeps a few bots so it is never empty
    this.worlds.set(w.id, w);
    if (w.botsOn) w.ensureBots();
    if (n > 1) this.log('world-open', 'Opened public ' + w.name, { world: w.id });
    return w;
  }

  createLobby() {
    let n = 1;
    while (this.worlds.has('l' + n)) n++;
    const w = new World(this, 'l' + n, 'lobby', 'Menu');
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
    this.log('private', 'Private world ' + code + ' created by ' + ipk, { world: code, ip: ipk });
    return { world: w };
  }

  publicWorlds() { return [...this.worlds.values()].filter(w => w.kind === 'public').sort((a, b) => a.num - b.num); }

  // every player gets their own menu room: the lobby is never shared
  lobbyFor() { return this.createLobby(); }

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
    this.log('world-close', 'Closed ' + w.name + ' (' + w.id + ') — ' + reason + ', ' + w.players.size + ' player(s) inside', { world: w.id });
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
      INV_MAX, HOTBAR, COIN_R: C.COIN_R, KB_TIME: C.KB_TIME,
      PALETTE: COLORS
    };
  }

  // sess = {ip, ipk, tid, tidExp}; body = {name, world, color}
  join(sess, body) {
    const r = this.join0(sess, body);
    if (r[0] !== 200 && r[1] && r[1].code && r[1].code !== 'color') this.log('join-fail', 'Join refused for ' + sess.ip + ': ' + r[1].code + ' — ' + r[1].error, { ip: sess.ip });
    return r;
  }
  join0(sess, body) {
    const C = this.C;
    body = body || {};
    if (this.settings.on) return [503, { error: this.settings.message || 'Down for maintenance.', code: 'maintenance' }];
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

    const prof = this.profiles.getOrCreate(body.profile, this.shop.eco.starterCoins);
    const p = w.addPlayer(sess, body.name, cidx);
    p.profile = prof;
    this.byId.set(p.id, p);
    if (!this.ipPlayers.has(p.ipk)) this.ipPlayers.set(p.ipk, new Set());
    this.ipPlayers.get(p.ipk).add(p.id);
    this.afterJoin(w);
    if (w.botsOn) w.ensureBots();
    if (w.kind !== 'lobby') this.log('join', p.name + ' joined ' + w.name + ' from ' + p.ip, { world: w.id, ip: p.ip });

    const snap = w.build(p, null, 0, 0, true);
    snap.id = p.id; snap.token = p.token; snap.name = p.name; snap.color = p.color; snap.cidx = p.cidx;
    snap.world = w.info();
    snap.cfg = this.clientCfg();
    snap.profile = prof.id;
    snap.inv = this.profiles.view(prof);
    snap.catalog = publicCatalog(this.shop);
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
    p.world.removePlayer(p, 'left');
    return [200, { ok: true }];
  }

  // ---------- shop / inventory (called by the /api/shop route) ----------
  async shopOp(body) {
    body = body || {};
    const p = this.byId.get(body.id);
    if (!p || p.token !== body.token || !p.profile) {
      const g = this.gone.get(body.id);
      return [410, { error: 'unknown player', reason: g ? g.reason : 'gone' }];
    }
    if (!this.sec.allow('sh:' + p.id, 12, 1.5)) return [429, { error: 'Slow down a little.' }];
    const prof = p.profile, P = this.profiles;
    const reply = extra => [200, Object.assign({ inv: P.view(prof), catalog: publicCatalog(this.shop) }, extra)];

    if (body.op === 'catalog') return reply();
    if (body.op === 'hotbar') {
      if (!P.setHotbar(prof, body.hotbar)) return [400, { error: 'That arrangement isn\'t allowed — the three tools always stay on the hotbar.', inv: P.view(prof) }];
      return reply();
    }
    if (body.op === 'buy') {
      if (p.world.kind !== 'lobby') return [400, { error: 'The shop is in the main menu.' }];
      const id = body.item;
      if (!ITEM_IDS.includes(id)) return [400, { error: 'Unknown item.' }];
      const cfgI = this.shop.items[id];
      if (!cfgI.enabled) return [400, { error: ITEMS[id].name + ' isn\'t for sale right now.' }];
      if (prof.items.length >= INV_MAX + HOTBAR) return [400, { error: 'Your inventory is full.' }];
      if (prof.coins < cfgI.price) return [400, { error: 'Not enough coins — you need ' + cfgI.price + '.' }];
      const rec = { t: id };
      if (id === 'image') {
        if (!this.sec.allow('img:' + p.ipk, 4, 4 / 60)) return [429, { error: 'Too many image links — try again in a minute.' }];
        const url = typeof body.url === 'string' ? body.url.trim() : '';
        if (!url) return [400, { error: 'Paste the link of the picture you want.' }];
        let info;
        try { info = await this.images.fetchAndStore(url); } catch (e) { return [400, { error: e.message || 'Could not load that image.' }]; }
        if (p.profile !== prof || prof.coins < cfgI.price || !this.shop.items[id].enabled) return [400, { error: 'That purchase could not be completed.' }];
        rec.img = info.hash; rec.ar = Math.round(info.h / info.w * 1000) / 1000;
        rec.url = url.replace(/^https?:\/\//, '').slice(0, 120);
        this.log('image', p.name + ' (' + p.ip + ') chose the picture ' + url.slice(0, 200) + ' → ' + info.hash.slice(0, 10), { ip: p.ip });
      }
      prof.coins -= cfgI.price;
      P.addItem(prof, rec);
      this.log('shop', p.name + ' bought ' + ITEMS[id].name + ' for ' + cfgI.price + ' coins', { ip: p.ip });
      return reply({ bought: id });
    }
    return [400, { error: 'bad request' }];
  }

  // remove a player and make them pass the human check again
  kick(p, reason, revoke = true) {
    if (revoke) this.sec.revoke(p.tid, p.tidExp);
    this.gone.set(p.id, { reason, exp: Date.now() + 60000 });
    p.world.removePlayer(p, reason);
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
      } else if (w.kind === 'lobby') {
        if (n === 0 && w.emptySince !== null && t - w.emptySince > C.LOBBY_EMPTY_SEC) this.closeWorld(w, 'closed');
      }
    }
  }
}

module.exports = { Hub };
