'use strict';
/*
 * Admin portal backend (zero dependencies).
 *
 *  - Login: the first password is ADMIN_INITIAL_PASSWORD (default "2468"). Logging in with it only opens the
 *    "choose a new password" screen; every other admin action is refused until a new password is set.
 *  - Brute force: 5 wrong passwords from one network (IPv4 address / IPv6 /64) lock that network out of the
 *    admin for 15 minutes (ADMIN_MAX_ATTEMPTS / ADMIN_LOCK_SEC). The right password is refused while locked.
 *  - Sessions: random token in an HttpOnly, SameSite=Strict cookie (12 h, sliding). Every admin POST must also
 *    carry the header X-CC-Admin: 1.
 *  - Log: everything that happens (joins, leaves, kills, worlds, portals, bans, human-check failures, admin
 *    actions ...) is kept for 24 hours. A sample of the player/world counts is taken every minute.
 *  - Persistence: with a data directory (DATA_DIR) the password, settings, bans and log survive restarts.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { ipKey, normIp } = require('./security');
const { ITEMS, ECONOMY, defaultShop, sanitizeShop, loadShop } = require('./shop');

const DAY = 24 * 3600 * 1000;
const LOG_MAX = 20000;
const SESSION_MS = 12 * 3600 * 1000;
const FOREVER = 100 * 365 * DAY;

// Settings the admin may change while the server is running: [min, max, label]
const TUNABLE = {
  MAX_PLAYERS:        [2, 100, 'Max players per public/private world'],
  PUBLIC_SPAWN_AT:    [1, 99, 'A public world over this many players spawns a new one'],
  PRIVATE_SOLO_SEC:   [30, 3600, 'Private world deleted after one player alone for (s)'],
  MAX_PLAYERS_PER_IP: [1, 50, 'Max simultaneous players per network'],
  MAX_PRIVATE_PER_IP: [1, 20, 'Max private worlds per network'],
  STRIKES_TO_BAN:     [1, 20, 'Auto-clicker strikes before a ban'],
  BAN_SEC:            [30, 86400, 'Automatic ban length (s)'],
  ATTACK_DMG:         [1, 100, 'Attack damage'],
  HEAL_AMOUNT:        [1, 100, 'Heal amount'],
  MANA_REGEN:         [0, 100, 'Mana regeneration per second'],
  RESPAWN:            [0.5, 20, 'Respawn time (s)'],
  BOT_COUNT:          [0, 15, 'Bots kept in World 1 (real players replace them one by one)'],
  PORTAL_DWELL:       [0.5, 30, 'Portal hover time (s) — applies to players who join afterwards'],
  COIN_R:             [10, 80, 'Coin pick-up distance (units)']
};

class Admin {
  constructor(hub, sec, C, opts = {}) {
    this.hub = hub; this.sec = sec; this.C = C;
    this.version = opts.version || '0';
    this.dir = opts.dataDir || null;
    this.startedAt = Date.now();
    this.defaults = {};
    for (const k of Object.keys(TUNABLE)) this.defaults[k] = C[k];
    this.maxAttempts = opts.maxAttempts || 5;
    this.lockMs = (opts.lockSec || 900) * 1000;
    this.sessions = new Map();         // token -> {exp, ipk, mustChange}
    this.attempts = new Map();         // ipKey -> {fails:[ts], lockedUntil}
    this.log = [];
    this.stats = [];
    this.logDirty = false;
    this.persistOk = true;
    this.lastRate = new Map();         // throttle for 'ratelimit' log lines
    this.maintenance = { on: false, message: 'CursorClash is being updated — back in a few minutes.' };
    this.globalLogin = [];             // all login attempts (to blunt attacks spread over many networks)

    this.creds = { salt: null, hash: null, changed: false };
    this.load();
    if (!this.creds.hash) this.setPassword(String(opts.initialPassword || '2468'), false);

    hub.logger = (type, msg, extra) => this.add(type, msg, extra);
    sec.onEvent = (type, msg, extra) => this.add(type, msg, extra);
    hub.settings = this.maintenance;
    this.add('system', 'Server started (v' + this.version + ')');
    this.sample();
    this.timer = setInterval(() => this.housekeeping(), 30000);
    this.timer.unref && this.timer.unref();
    this.lastSample = Date.now();
  }

  // ---------- persistence ----------
  file(n) { return this.dir ? path.join(this.dir, n) : null; }
  readJson(n) {
    const f = this.file(n);
    if (!f) return null;
    try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; }
  }
  writeJson(n, data) {
    const f = this.file(n);
    if (!f) return true;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const tmp = f + '.' + process.pid + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
      fs.renameSync(tmp, f);
      return true;
    } catch (e) { return false; }
  }
  load() {
    const a = this.readJson('admin.json');
    if (a && typeof a.salt === 'string' && typeof a.hash === 'string') this.creds = { salt: a.salt, hash: a.hash, changed: !!a.changed };
    const s = this.readJson('settings.json');
    if (s && typeof s === 'object') {
      if (s.values) for (const [k, v] of Object.entries(s.values)) if (TUNABLE[k] && this.valid(k, v)) this.C[k] = Number(v);
      if (s.shop) this.hub.shop = loadShop(s.shop);
      if (s.maintenance) { this.maintenance.on = !!s.maintenance.on; if (typeof s.maintenance.message === 'string') this.maintenance.message = s.maintenance.message.slice(0, 200); }
    }
    const b = this.readJson('bans.json');
    if (Array.isArray(b)) {
      const now = Date.now();
      for (const x of b) if (x && typeof x.ip === 'string' && x.expires > now) { this.sec.bans.set(x.ip, x.expires); this.sec.banInfo.set(x.ip, { reason: x.reason, manual: !!x.manual, at: x.at }); }
    }
    const l = this.readJson('log.json');
    if (Array.isArray(l)) { const cut = Date.now() - DAY; this.log = l.filter(e => e && e.t > cut).slice(-LOG_MAX); }
    const st = this.readJson('stats.json');
    if (Array.isArray(st)) { const cut = Date.now() - DAY; this.stats = st.filter(e => e && e.t > cut); }
  }
  save(all) {
    if (!this.dir) return;
    let ok = true;
    ok = this.writeJson('settings.json', { values: this.currentValues(), maintenance: this.maintenance, shop: this.hub.shop }) && ok;
    if (this.hub.profiles) { this.hub.profiles.save(); ok = this.hub.profiles.ok && ok; }
    ok = this.writeJson('bans.json', this.sec.listBans()) && ok;
    if (all || this.logDirty) { ok = this.writeJson('log.json', this.log) && ok; ok = this.writeJson('stats.json', this.stats) && ok; this.logDirty = false; }
    this.persistOk = ok;
  }
  saveCreds() { if (this.dir) this.persistOk = this.writeJson('admin.json', this.creds) && this.persistOk; }

  housekeeping() {
    const now = Date.now();
    this.prune();
    if (now - this.lastSample >= 60000) { this.lastSample = now; this.sample(); }
    for (const [k, s] of this.sessions) if (now > s.exp) this.sessions.delete(k);
    for (const [k, a] of this.attempts) { a.fails = a.fails.filter(x => now - x < this.lockMs); if (!a.fails.length && now > a.lockedUntil) this.attempts.delete(k); }
    for (const [k, t] of this.lastRate) if (now - t > 120000) this.lastRate.delete(k);
    this.save(false);
  }
  close() { clearInterval(this.timer); this.save(true); }

  // ---------- log + stats ----------
  add(type, msg, extra) {
    const e = { t: Date.now(), type, msg: String(msg).slice(0, 300) };
    if (extra) { if (extra.ip) e.ip = String(extra.ip).slice(0, 64); if (extra.world) e.world = extra.world; }
    this.log.push(e);
    if (this.log.length > LOG_MAX + 500) this.log.splice(0, this.log.length - LOG_MAX);
    this.logDirty = true;
  }
  // 'ratelimit' lines would flood the log, so at most one per network every 30 s
  addRate(ipk) {
    const now = Date.now();
    if (now - (this.lastRate.get(ipk) || 0) < 30000) return;
    this.lastRate.set(ipk, now);
    this.add('ratelimit', 'Rate limit hit by ' + ipk, { ip: ipk });
  }
  prune() { const cut = Date.now() - DAY; let i = 0; while (i < this.log.length && this.log[i].t < cut) i++; if (i) this.log.splice(0, i); while (this.stats.length && this.stats[0].t < cut) this.stats.shift(); }
  counts() {
    let players = 0, lobby = 0, pub = 0, priv = 0;
    const worlds = { lobby: 0, public: 0, private: 0 };
    for (const w of this.hub.worlds.values()) {
      worlds[w.kind]++;
      const n = w.count();
      players += n;
      if (w.kind === 'lobby') lobby += n; else if (w.kind === 'public') pub += n; else priv += n;
    }
    return { players, lobby, pub, priv, worlds };
  }
  sample() {
    const c = this.counts();
    this.stats.push({ t: Date.now(), players: c.players, lobby: c.lobby, pub: c.pub, priv: c.priv, worlds: c.worlds.public + c.worlds.private + c.worlds.lobby });
    this.prune();
  }

  // ---------- passwords ----------
  hashPw(pw, salt) { return crypto.scryptSync(String(pw), salt, 32).toString('hex'); }
  setPassword(pw, changed) {
    const salt = crypto.randomBytes(16).toString('hex');
    this.creds = { salt, hash: this.hashPw(pw, salt), changed: !!changed };
  }
  checkPassword(pw) {
    if (typeof pw !== 'string' || pw.length > 200) return false;
    const a = Buffer.from(this.hashPw(pw, this.creds.salt), 'hex'), b = Buffer.from(this.creds.hash, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  // ---------- helpers ----------
  currentValues() { const o = {}; for (const k of Object.keys(TUNABLE)) o[k] = this.C[k]; return o; }
  valid(k, v) { const r = TUNABLE[k]; v = Number(v); return !!r && Number.isFinite(v) && v >= r[0] && v <= r[1]; }
  lockInfo(ipk) { const a = this.attempts.get(ipk); return a && a.lockedUntil > Date.now() ? a.lockedUntil : 0; }
  locks() { const now = Date.now(), out = []; for (const [ip, a] of this.attempts) if (a.lockedUntil > now) out.push({ ip, until: a.lockedUntil }); return out; }

  cookie(token, secure, maxAgeSec) {
    return 'cc_admin=' + token + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=' + maxAgeSec + (secure ? '; Secure' : '');
  }
  sessionOf(req) {
    const h = req.headers.cookie;
    if (typeof h !== 'string') return null;
    const m = /(?:^|;\s*)cc_admin=([A-Za-z0-9_-]{20,80})/.exec(h);
    if (!m) return null;
    const s = this.sessions.get(m[1]);
    if (!s || Date.now() > s.exp) { if (s) this.sessions.delete(m[1]); return null; }
    s.exp = Date.now() + SESSION_MS;
    return { token: m[1], s };
  }

  // ---------- request handling ----------
  // returns [status, payload, headers?]
  handle(route, body, req, ctx) {
    body = body && typeof body === 'object' ? body : {};
    if (req.headers['x-cc-admin'] !== '1') return [403, { error: 'Forbidden.' }];
    const { ip, ipk, secure } = ctx;
    if (!this.sec.allow('adm:' + ipk, 200, 20)) return [429, { error: 'Too many requests.' }];

    if (route === 'login') return this.login(body, ip, ipk, secure);

    const sess = this.sessionOf(req);
    if (!sess) return [401, { error: 'Not signed in.', code: 'auth' }];
    const must = sess.s.mustChange;
    if (route === 'session') return [200, { ok: true, mustChange: must, version: this.version }];
    if (route === 'logout') { this.sessions.delete(sess.token); return [200, { ok: true }, { 'Set-Cookie': this.cookie('', secure, 0) }]; }
    if (route === 'password') return this.changePassword(body, sess, ip);
    if (must) return [403, { error: 'Choose a new password first.', code: 'mustChange' }];

    const act = (msg, extra) => this.add('admin-action', msg + ' (by ' + ip + ')', extra);
    const hub = this.hub, sec = this.sec;

    switch (route) {
      case 'overview': return [200, this.overview()];

      case 'logs': {
        const types = Array.isArray(body.types) ? body.types.filter(x => typeof x === 'string').slice(0, 30) : null;
        const q = typeof body.q === 'string' ? body.q.trim().toLowerCase().slice(0, 100) : '';
        const since = Number.isFinite(body.since) ? body.since : 0;
        const limit = Math.min(2000, Math.max(1, Number.isInteger(body.limit) ? body.limit : 300));
        const countsByType = {};
        for (const e of this.log) countsByType[e.type] = (countsByType[e.type] || 0) + 1;
        const out = [];
        for (let i = this.log.length - 1; i >= 0 && out.length < limit; i--) {
          const e = this.log[i];
          if (e.t < since) break;
          if (types && types.length && !types.includes(e.type)) continue;
          if (q && !(e.msg.toLowerCase().includes(q) || (e.ip || '').toLowerCase().includes(q))) continue;
          out.push(e);
        }
        return [200, { entries: out, total: this.log.length, counts: countsByType }];
      }

      case 'stats': return [200, { samples: this.stats }];

      case 'kick': {
        const p = hub.byId.get(Number(body.id));
        if (!p) return [404, { error: 'That player is no longer connected.' }];
        const mins = Number(body.banMinutes) || 0;
        const name = p.name, key = p.ipk;
        if (mins > 0) {
          sec.ban(key, Math.min(mins, 525600) * 60000, 'banned by admin (player ' + name + ')', true);
          for (const q of [...hub.byId.values()].filter(x => x.ipk === key)) hub.kick(q, 'banned', false);
          act('Banned ' + key + ' for ' + mins + ' min and removed ' + name, { ip: key });
        } else { hub.kick(p, 'kicked', false); act('Kicked ' + name, { ip: key }); }
        this.save(false);
        return [200, { ok: true }];
      }

      case 'ban-ip': {
        const raw = typeof body.ip === 'string' ? body.ip.trim() : '';
        if (!raw || raw.length > 64 || /[^0-9a-fA-F:.]/.test(raw)) return [400, { error: 'Enter an IP address.' }];
        const key = ipKey(normIp(raw));
        const mins = Number(body.minutes);
        const ms = !Number.isFinite(mins) || mins <= 0 ? FOREVER : Math.min(mins, 525600) * 60000;
        const reason = typeof body.reason === 'string' ? body.reason.slice(0, 80) : '';
        sec.ban(key, ms, reason || 'banned by admin', true);
        for (const q of [...hub.byId.values()].filter(x => x.ipk === key)) hub.kick(q, 'banned', false);
        act('Banned ' + key + (ms === FOREVER ? ' permanently' : ' for ' + Math.round(ms / 60000) + ' min'), { ip: key });
        this.save(false);
        return [200, { ok: true, ip: key }];
      }

      case 'unban': {
        const key = ipKey(normIp(String(body.ip || '')));
        const had = sec.unban(key);
        act((had ? 'Unbanned ' : 'Unban requested for (not banned) ') + key, { ip: key });
        this.save(false);
        return [200, { ok: true, had }];
      }

      case 'close-world': {
        const w = hub.worlds.get(String(body.id || ''));
        if (!w) return [404, { error: 'That world no longer exists.' }];
        if (w.id === 'w1' || w.id === 'l1') return [400, { error: 'The main lobby and World 1 can\'t be closed.' }];
        const n = w.count(), label = w.name + ' (' + w.id + ')';
        hub.closeWorld(w, 'admin-closed');
        act('Closed ' + label + ', removing ' + n + ' player(s)');
        return [200, { ok: true }];
      }

      case 'create-world': {
        const w = hub.createPublic();
        act('Created ' + w.name);
        hub.refreshPortals(false);
        return [200, { ok: true, id: w.id, name: w.name }];
      }

      case 'broadcast': {
        const text = typeof body.message === 'string' ? body.message.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 140) : '';
        if (!text) return [400, { error: 'Write a message first.' }];
        let targets = [...hub.worlds.values()];
        if (body.world && body.world !== 'all') targets = targets.filter(w => w.id === body.world);
        if (!targets.length) return [404, { error: 'That world no longer exists.' }];
        for (const w of targets) w.pushEvent({ e: 'msg', n: text });
        act('Broadcast to ' + (targets.length === 1 ? targets[0].name : 'all worlds') + ': ' + text);
        return [200, { ok: true, worlds: targets.length }];
      }

      case 'kick-all': {
        let n = 0;
        for (const p of [...hub.byId.values()]) { hub.kick(p, 'kicked', false); n++; }
        act('Kicked everyone (' + n + ' players)');
        return [200, { ok: true, n }];
      }

      case 'maintenance': {
        this.maintenance.on = !!body.on;
        if (typeof body.message === 'string' && body.message.trim()) this.maintenance.message = body.message.trim().slice(0, 200);
        act('Maintenance mode ' + (this.maintenance.on ? 'ON' : 'OFF'));
        let n = 0;
        if (this.maintenance.on && body.kick) for (const p of [...hub.byId.values()]) { hub.kick(p, 'kicked', false); n++; }
        this.save(false);
        return [200, { ok: true, kicked: n }];
      }

      case 'settings': {
        const vals = body.values && typeof body.values === 'object' ? body.values : {};
        const next = Object.assign(this.currentValues(), {});
        for (const [k, v] of Object.entries(vals)) {
          if (!TUNABLE[k]) return [400, { error: 'Unknown setting ' + k + '.' }];
          if (!this.valid(k, v)) return [400, { error: TUNABLE[k][2] + ' must be between ' + TUNABLE[k][0] + ' and ' + TUNABLE[k][1] + '.' }];
          next[k] = Number(v);
        }
        if (next.PUBLIC_SPAWN_AT >= next.MAX_PLAYERS) return [400, { error: 'The spawn threshold must be lower than the max players per world.' }];
        const changed = [];
        for (const k of Object.keys(next)) if (this.C[k] !== next[k]) { changed.push(k + ' ' + this.C[k] + ' → ' + next[k]); this.C[k] = next[k]; }
        if (body.reset === true) { for (const k of Object.keys(this.defaults)) this.C[k] = this.defaults[k]; changed.push('reset to defaults'); }
        if (changed.length) act('Settings changed: ' + changed.join(', '));
        this.save(false);
        return [200, { ok: true, values: this.currentValues() }];
      }

      case 'shop-save': {
        const r = sanitizeShop(hub.shop, body.patch);
        if (r.error) return [400, { error: r.error }];
        const changes = [];
        for (const id of Object.keys(ITEMS)) for (const k of Object.keys(r.shop.items[id])) if (r.shop.items[id][k] !== hub.shop.items[id][k]) changes.push(ITEMS[id].name + ' ' + k + ' ' + hub.shop.items[id][k] + ' → ' + r.shop.items[id][k]);
        for (const k of Object.keys(r.shop.eco)) if (r.shop.eco[k] !== hub.shop.eco[k]) changes.push(k + ' ' + hub.shop.eco[k] + ' → ' + r.shop.eco[k]);
        if (JSON.stringify(r.shop.blockedHosts) !== JSON.stringify(hub.shop.blockedHosts)) changes.push('blocked image sites: ' + (r.shop.blockedHosts.join(', ') || 'none'));
        hub.shop = r.shop; hub.shopVersion++;
        if (changes.length) act('Shop changed: ' + changes.join(', '));
        this.save(false);
        return [200, { ok: true, shop: hub.shop }];
      }

      case 'shop-reset': {
        hub.shop = defaultShop(); hub.shopVersion++;
        act('Shop and economy reset to defaults');
        this.save(false);
        return [200, { ok: true, shop: hub.shop }];
      }

      case 'give-coins': {
        const p = hub.byId.get(Number(body.id));
        const n = Math.trunc(Number(body.amount));
        if (!p || !p.profile) return [404, { error: 'That player is no longer connected.' }];
        if (!Number.isFinite(n) || n === 0 || Math.abs(n) > 100000) return [400, { error: 'Enter an amount between -100000 and 100000.' }];
        hub.profiles.addCoins(p.profile, Math.max(n, -p.profile.coins));
        act((n > 0 ? 'Gave ' : 'Took ') + Math.abs(n) + ' coins ' + (n > 0 ? 'to ' : 'from ') + p.name, { ip: p.ip });
        this.save(false);
        return [200, { ok: true, coins: p.profile.coins }];
      }

      case 'purge-images': {
        const n = hub.images.purge();
        let live = 0;
        for (const w of hub.worlds.values()) { live += w.images.size; w.images.clear(); }
        act('Purged ' + n + ' stored picture(s) and removed ' + live + ' picture(s) from the arenas');
        return [200, { ok: true, purged: n, live }];
      }

      case 'clear-log': {
        const n = this.log.length;
        this.log = [];
        this.logDirty = true;
        act('Cleared the log (' + n + ' entries)');
        this.save(true);
        return [200, { ok: true }];
      }

      case 'unlock-admin': {
        const key = ipKey(normIp(String(body.ip || '')));
        const had = this.attempts.delete(key);
        act('Admin lockout ' + (had ? 'cleared for ' : 'requested (none) for ') + key);
        return [200, { ok: true, had }];
      }

      default: return [404, { error: 'not found' }];
    }
  }

  login(body, ip, ipk, secure) {
    const now = Date.now();
    let a = this.attempts.get(ipk);
    if (!a) { a = { fails: [], lockedUntil: 0 }; this.attempts.set(ipk, a); }
    if (a.lockedUntil > now) {
      return [423, { error: 'Too many wrong passwords. This network is locked out of the admin portal.', code: 'locked', retryAfter: Math.ceil((a.lockedUntil - now) / 1000) },
        { 'Retry-After': String(Math.ceil((a.lockedUntil - now) / 1000)) }];
    }
    // a global brake as well, so spreading guesses over many networks doesn't help
    this.globalLogin = this.globalLogin.filter(x => now - x < 60000);
    if (this.globalLogin.length >= 60) return [429, { error: 'Too many login attempts. Wait a minute.' }];
    this.globalLogin.push(now);

    a.fails = a.fails.filter(x => now - x < this.lockMs);
    if (!this.checkPassword(body.password)) {
      a.fails.push(now);
      if (a.fails.length >= this.maxAttempts) {
        a.lockedUntil = now + this.lockMs; a.fails = [];
        this.add('admin-lock', 'Admin login locked for ' + ipk + ' after ' + this.maxAttempts + ' wrong passwords', { ip: ipk });
        return [423, { error: 'Too many wrong passwords. This network is locked out of the admin portal for ' + Math.round(this.lockMs / 60000) + ' minutes.', code: 'locked', retryAfter: Math.round(this.lockMs / 1000) },
          { 'Retry-After': String(Math.round(this.lockMs / 1000)) }];
      }
      this.add('admin-fail', 'Wrong admin password from ' + ipk + ' (' + a.fails.length + '/' + this.maxAttempts + ')', { ip: ipk });
      const left = this.maxAttempts - a.fails.length;
      return [401, { error: 'Wrong password. ' + left + ' attempt' + (left === 1 ? '' : 's') + ' left before this network is locked.', code: 'bad', attemptsLeft: left }];
    }
    a.fails = [];
    const token = crypto.randomBytes(32).toString('base64url');
    const must = !this.creds.changed;
    this.sessions.set(token, { exp: now + SESSION_MS, ipk, mustChange: must });
    this.add('admin-login', 'Admin signed in from ' + ip + (must ? ' (default password — change required)' : ''), { ip: ipk });
    return [200, { ok: true, mustChange: must }, { 'Set-Cookie': this.cookie(token, secure, SESSION_MS / 1000) }];
  }

  changePassword(body, sess, ip) {
    const cur = body.current, nw = body.password;
    if (!this.checkPassword(cur)) return [401, { error: 'Your current password is wrong.', code: 'bad' }];
    if (typeof nw !== 'string' || nw.length < 8) return [400, { error: 'Use at least 8 characters.' }];
    if (nw.length > 200) return [400, { error: 'That password is too long.' }];
    if (nw === '2468' || nw === cur) return [400, { error: 'Pick a password that is different from the old one.' }];
    this.setPassword(nw, true);
    for (const [k, s] of this.sessions) if (k !== sess.token) this.sessions.delete(k);   // every other login is signed out
    sess.s.mustChange = false;
    this.saveCreds();
    this.add('admin-action', 'Admin password changed (by ' + ip + ')');
    return [200, { ok: true, persisted: !this.dir || this.persistOk }];
  }

  overview() {
    const hub = this.hub, now = Date.now(), t = hub.now();
    const worlds = [...hub.worlds.values()].filter(w => w.kind !== 'lobby').map(w => ({
      id: w.id, kind: w.kind, name: w.name, count: w.count(), max: w.capacity(),
      bots: [...w.players.values()].filter(o => o.bot).length, coins: w.coins ? w.coins.size : 0,
      soloFor: w.kind === 'private' && w.soloSince !== null ? Math.round(t - w.soloSince) : null,
      creator: w.creatorIpk || null
    })).sort((a, b) => (a.kind > b.kind ? 1 : a.kind < b.kind ? -1 : a.id.length - b.id.length || (a.id > b.id ? 1 : -1)));
    const players = [];
    for (const p of hub.byId.values()) {
      players.push({ id: p.id, name: p.name, world: p.world.id, worldName: p.world.name, kind: p.world.kind, ip: p.ip, color: p.color,
        kills: p.kills, deaths: p.deaths, hp: Math.round(p.hp), coins: p.profile ? p.profile.coins : 0, online: Math.round(t - (p.joinedAt || t)) });
    }
    const c = this.counts();
    const typeCounts = {};
    for (const e of this.log) typeCounts[e.type] = (typeCounts[e.type] || 0) + 1;
    const peak = this.stats.reduce((m, s) => Math.max(m, s.players), c.players);
    return {
      version: this.version, now, uptime: Math.round((now - this.startedAt) / 1000),
      counts: c, peak24h: peak, worlds, players,
      logSize: this.log.length, typeCounts,
      bans: this.sec.listBans(), strikes: this.sec.listStrikes(), locks: this.locks(),
      maintenance: this.maintenance,
      settings: Object.entries(TUNABLE).map(([k, r]) => ({ key: k, value: this.C[k], min: r[0], max: r[1], label: r[2], def: this.defaults[k] })),
      persist: { enabled: !!this.dir, ok: this.persistOk },
      shop: {
        values: hub.shop,
        items: Object.entries(ITEMS).map(([id, d]) => ({ id, name: d.name, icon: d.icon, desc: d.desc, props: Object.entries(d.props).map(([k, r]) => ({ key: k, min: r[0], max: r[1], def: r[2], label: r[3] })) })),
        eco: Object.entries(ECONOMY).map(([k, r]) => ({ key: k, min: r[0], max: r[1], def: r[2], label: r[3] })),
        profiles: hub.profiles.map.size, images: hub.images.stats()
      },
      turnstile: !!this.sec.turnstile, humanCheck: !!this.C.HUMAN_CHECK, rateLimits: !!this.C.RATE_LIMITS,
      mustChangeDefault: !this.creds.changed
    };
  }
}

module.exports = { Admin, TUNABLE };
