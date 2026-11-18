'use strict';
/*
 * Player profiles: coins, inventory and hotbar. There are no accounts; a browser keeps a random secret id
 * (localStorage) and the server keys the profile by it. Persisted to DATA_DIR/profiles.json when a data
 * folder is configured, otherwise kept in memory only.
 *
 *   items   owned item instances  [{u, t, img?, ar?, url?}]   (u = unique number, t = 'invis'|'tnt'|'image')
 *   hotbar  9 slots: 'fist' | 'draw' | 'block' | <item u> | null
 *           The three tools always stay on the hotbar (they can be moved around, never into the inventory).
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { ITEM_IDS, TOOLS, INV_MAX, HOTBAR } = require('./shop');

const MAX_PROFILES = 200000;
const STALE_MS = 90 * 24 * 3600 * 1000;

const defaultHotbar = () => ['fist', 'draw', 'block', null, null, null, null, null, null];

// Returns a valid hotbar for this profile, or null if the proposal is not allowed.
function checkHotbar(profile, proposal) {
  if (!Array.isArray(proposal) || proposal.length !== HOTBAR) return null;
  const owned = new Set(profile.items.map(i => i.u));
  const seen = new Set();
  for (const s of proposal) {
    if (s === null) continue;
    if (TOOLS.includes(s)) { if (seen.has(s)) return null; seen.add(s); continue; }
    if (!Number.isInteger(s) || !owned.has(s) || seen.has(s)) return null;
    seen.add(s);
  }
  for (const t of TOOLS) if (!seen.has(t)) return null;          // tools can never leave the hotbar
  return proposal.slice();
}

class Profiles {
  constructor(opts = {}) {
    this.dir = opts.dataDir || null;
    this.map = new Map();
    this.dirty = false;
    this.ok = true;
    this.load();
  }

  file() { return this.dir ? path.join(this.dir, 'profiles.json') : null; }

  load() {
    const f = this.file();
    if (!f) return;
    try {
      const arr = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (!Array.isArray(arr)) return;
      for (const p of arr) {
        if (!p || typeof p.id !== 'string' || !/^p_[0-9a-f]{32}$/.test(p.id)) continue;
        const items = (Array.isArray(p.items) ? p.items : []).filter(i => i && Number.isInteger(i.u) && ITEM_IDS.includes(i.t)).slice(0, INV_MAX + HOTBAR)
          .map(i => ({ u: i.u, t: i.t, img: typeof i.img === 'string' ? i.img : undefined, ar: Number(i.ar) || undefined, url: typeof i.url === 'string' ? i.url.slice(0, 200) : undefined }));
        const prof = { id: p.id, coins: Math.max(0, Math.floor(Number(p.coins) || 0)), items, nextU: Math.max(1, Number(p.nextU) || 1), hotbar: null, ver: 1, created: Number(p.created) || Date.now(), seen: Number(p.seen) || Date.now() };
        for (const i of items) if (i.u >= prof.nextU) prof.nextU = i.u + 1;
        prof.hotbar = checkHotbar(prof, p.hotbar) || this.freshHotbar(prof);
        this.map.set(p.id, prof);
      }
    } catch (e) { /* first run, or unreadable: start empty */ }
  }

  freshHotbar(prof) {
    const hb = defaultHotbar();
    let slot = 3;
    for (const i of prof.items) if (slot < HOTBAR) hb[slot++] = i.u;
    return hb;
  }

  save() {
    const f = this.file();
    if (!f || !this.dirty) return;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const tmp = f + '.' + process.pid + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify([...this.map.values()].map(p => ({ id: p.id, coins: p.coins, items: p.items, nextU: p.nextU, hotbar: p.hotbar, created: p.created, seen: p.seen }))), { mode: 0o600 });
      fs.renameSync(tmp, f);
      this.dirty = false; this.ok = true;
    } catch (e) { this.ok = false; }
  }

  // an existing profile for this secret id, or a brand-new one
  getOrCreate(id, starterCoins) {
    let p = typeof id === 'string' ? this.map.get(id) : null;
    if (p) { p.seen = Date.now(); return p; }
    if (this.map.size >= MAX_PROFILES) this.sweep(true);
    p = { id: 'p_' + crypto.randomBytes(16).toString('hex'), coins: starterCoins, items: [], nextU: 1, hotbar: defaultHotbar(), ver: 1, created: Date.now(), seen: Date.now() };
    this.map.set(p.id, p);
    this.dirty = true;
    return p;
  }

  touch(p) { p.ver++; p.seen = Date.now(); this.dirty = true; }

  addCoins(p, n) { p.coins += n; this.touch(p); }

  // adds an item to the inventory (and into the first free hotbar slot after the tools); null when the inventory is full
  addItem(p, item) {
    if (p.items.length >= INV_MAX + HOTBAR) return null;
    const rec = Object.assign({ u: p.nextU++ }, item);
    p.items.push(rec);
    const free = p.hotbar.indexOf(null, 3);
    if (free >= 0) p.hotbar[free] = rec.u;
    this.touch(p);
    return rec;
  }

  removeItem(p, u) {
    const i = p.items.findIndex(x => x.u === u);
    if (i < 0) return null;
    const [rec] = p.items.splice(i, 1);
    p.hotbar = p.hotbar.map(s => (s === u ? null : s));
    this.touch(p);
    return rec;
  }

  setHotbar(p, proposal) {
    const hb = checkHotbar(p, proposal);
    if (!hb) return false;
    p.hotbar = hb; this.touch(p);
    return true;
  }

  view(p) {
    return { coins: p.coins, ver: p.ver, hotbar: p.hotbar, items: p.items.map(i => ({ u: i.u, t: i.t, img: i.img, ar: i.ar, url: i.url })), invMax: INV_MAX };
  }

  sweep(force) {
    const cut = Date.now() - STALE_MS;
    for (const [k, p] of this.map) if (p.seen < cut && (force || !p.items.length)) { this.map.delete(k); this.dirty = true; }
  }
}

module.exports = { Profiles, checkHotbar, defaultHotbar };
