'use strict';
/*
 * Shop catalogue: every item, its editable properties (with limits and defaults) and the economy settings.
 * The admin portal edits these live; they are validated here so nothing out of range can ever be stored.
 *
 * Property tuple: [min, max, default, label]
 */
const ITEMS = {
  invis: {
    name: 'Invisibility', icon: '👻',
    desc: 'Other players can\'t see your cursor for a while. You can still fight.',
    props: {
      price: [1, 100000, 15, 'Price (coins)'],
      duration: [1, 600, 20, 'Invisible for (seconds)']
    }
  },
  tnt: {
    name: 'TNT', icon: '🧨',
    desc: 'Drops a TNT charge at your cursor. After the fuse it blasts everyone nearby (not you) away and hurts them.',
    props: {
      price: [1, 100000, 30, 'Price (coins)'],
      fuse: [0.5, 30, 3, 'Fuse (seconds)'],
      radius: [40, 900, 220, 'Blast radius (units)'],
      damage: [0, 100, 35, 'Damage to everyone in the blast (HP)'],
      push: [0, 1600, 420, 'Push distance (units)']
    }
  },
  image: {
    name: 'Image paster', icon: '🖼️',
    desc: 'Paste a picture of your choice into the arena, tinted in your colour. Drag to set its size — bigger costs more mana.',
    props: {
      price: [1, 100000, 40, 'Price (coins)'],
      life: [1, 300, 10, 'Stays for (seconds)'],
      manaPer1000: [0.01, 100, 0.9, 'Mana per 1000 square units'],
      minSize: [10, 400, 50, 'Smallest width (units)'],
      maxSize: [50, 1600, 520, 'Largest width (units)']
    }
  }
};

// coins and starter money
const ECONOMY = {
  starterCoins: [0, 1000000, 20, 'Coins a new player starts with'],
  coinValue: [1, 1000, 1, 'Value of one coin'],
  coinMax: [0, 40, 5, 'Most coins lying around in one world'],
  coinEvery: [1, 600, 10, 'Average seconds between coin spawns (per world)'],
  coinLife: [3, 300, 30, 'Seconds a coin stays before it vanishes']
};

const ITEM_IDS = Object.keys(ITEMS);
const TOOLS = ['fist', 'draw', 'block'];
const INV_MAX = 27;
const HOTBAR = 9;

function defaultShop() {
  const items = {};
  for (const [id, d] of Object.entries(ITEMS)) {
    items[id] = { enabled: true };
    for (const [k, r] of Object.entries(d.props)) items[id][k] = r[2];
  }
  const eco = {};
  for (const [k, r] of Object.entries(ECONOMY)) eco[k] = r[2];
  return { items, eco, blockedHosts: [] };
}

const okNum = (v, r) => typeof v === 'number' && Number.isFinite(v) && v >= r[0] && v <= r[1];

// Validates a partial update. Returns {error} or {shop} (a complete, merged copy). Nothing is applied here.
function sanitizeShop(current, patch) {
  const next = JSON.parse(JSON.stringify(current));
  if (!patch || typeof patch !== 'object') return { error: 'Nothing to save.' };
  if (patch.items) {
    if (typeof patch.items !== 'object') return { error: 'Bad items.' };
    for (const [id, vals] of Object.entries(patch.items)) {
      const def = ITEMS[id];
      if (!def) return { error: 'Unknown item ' + id + '.' };
      for (const [k, v] of Object.entries(vals || {})) {
        if (k === 'enabled') { next.items[id].enabled = !!v; continue; }
        const r = def.props[k];
        if (!r) return { error: 'Unknown property ' + k + ' on ' + def.name + '.' };
        const n = Number(v);
        if (!okNum(n, r)) return { error: def.name + ' — ' + r[3] + ' must be between ' + r[0] + ' and ' + r[1] + '.' };
        next.items[id][k] = n;
      }
    }
    const im = next.items.image;
    if (im.minSize >= im.maxSize) return { error: 'Image paster: the smallest width must be below the largest width.' };
  }
  if (patch.eco) {
    for (const [k, v] of Object.entries(patch.eco)) {
      const r = ECONOMY[k];
      if (!r) return { error: 'Unknown setting ' + k + '.' };
      const n = Number(v);
      if (!okNum(n, r)) return { error: r[3] + ' must be between ' + r[0] + ' and ' + r[1] + '.' };
      next.eco[k] = n;
    }
  }
  if (patch.blockedHosts !== undefined) {
    if (!Array.isArray(patch.blockedHosts)) return { error: 'Blocked sites must be a list.' };
    const out = [];
    for (const h of patch.blockedHosts.slice(0, 200)) {
      const s = String(h).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');
      if (s && /^[a-z0-9.-]{1,100}$/.test(s)) out.push(s);
    }
    next.blockedHosts = [...new Set(out)];
  }
  return { shop: next };
}

// Merge a stored object over the defaults, dropping anything invalid (used when loading from disk).
function loadShop(stored) {
  const base = defaultShop();
  if (!stored || typeof stored !== 'object') return base;
  const r = sanitizeShop(base, { items: stored.items, eco: stored.eco, blockedHosts: stored.blockedHosts });
  if (r.shop) return r.shop;
  // one bad field must not throw away the rest: apply field by field
  let cur = base;
  for (const [id, vals] of Object.entries(stored.items || {})) for (const [k, v] of Object.entries(vals || {})) {
    const t = sanitizeShop(cur, { items: { [id]: { [k]: v } } }); if (t.shop) cur = t.shop;
  }
  for (const [k, v] of Object.entries(stored.eco || {})) { const t = sanitizeShop(cur, { eco: { [k]: v } }); if (t.shop) cur = t.shop; }
  const t = sanitizeShop(cur, { blockedHosts: stored.blockedHosts || [] }); if (t.shop) cur = t.shop;
  return cur;
}

// What a player's client may know about the catalogue
function publicCatalog(shop) {
  return ITEM_IDS.map(id => {
    const d = ITEMS[id], v = shop.items[id];
    return { id, name: d.name, icon: d.icon, desc: d.desc, enabled: !!v.enabled, price: v.price, needsLink: id === 'image', props: Object.fromEntries(Object.keys(d.props).map(k => [k, v[k]])) };
  });
}

module.exports = { ITEMS, ECONOMY, ITEM_IDS, TOOLS, INV_MAX, HOTBAR, defaultShop, sanitizeShop, loadShop, publicCatalog };
