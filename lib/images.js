'use strict';
/*
 * Image store for the "Image paster" item.
 *
 * A player gives a link when buying the item. The SERVER downloads it once, checks that it really is a small
 * PNG/JPEG/GIF/WebP, and keeps it under its own address (/img/<sha256>). Other players' browsers never contact
 * the link, so their addresses can't be harvested through a tracking link, and the page's CSP stays strict.
 *
 * Safety: only http/https on ports 80/443/8080/8443, no credentials in the URL, the host is resolved and every
 * address must be public (no localhost / private networks / cloud metadata), the connection is pinned to the
 * address that was checked, redirects are followed (max 3) and re-checked, 6 s timeout, 1.5 MB limit, and
 * the picture's pixel size is read from its header and capped so nobody can send a "decompression bomb".
 */
const crypto = require('node:crypto');
const dns = require('node:dns');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const path = require('node:path');

const MAX_BYTES = 1.5 * 1024 * 1024;
const MAX_DIM = 4096;
const TIMEOUT_MS = 6000;
const MAX_STORED = 400;                       // pictures kept on disk / in memory

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19));
  }
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    if (l === '::' || l === '::1') return true;
    const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(l);
    if (m) return isPrivateIp(m[1]);
    return /^f[cd]/.test(l) || /^fe[89ab]/.test(l) || l.startsWith('ff') || l.startsWith('64:ff9b');
  }
  return true;
}

// Reads the type and pixel size from the first bytes. Returns null when it isn't a supported picture.
function sniff(buf) {
  if (buf.length < 24) return null;
  if (buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG') return { type: 'image/png', ext: 'png', w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  if (buf.toString('latin1', 0, 3) === 'GIF') return { type: 'image/gif', ext: 'gif', w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const m = buf[i + 1];
      if (m === 0xff) { i++; continue; }
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
      const len = buf.readUInt16BE(i + 2);
      if ((m >= 0xc0 && m <= 0xcf) && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { type: 'image/jpeg', ext: 'jpg', h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
      i += 2 + len;
    }
    return null;
  }
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') {
    const c = buf.toString('latin1', 12, 16);
    if (c === 'VP8 ' && buf.length >= 30) return { type: 'image/webp', ext: 'webp', w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
    if (c === 'VP8L' && buf.length >= 25) { const b = buf.readUInt32LE(21); return { type: 'image/webp', ext: 'webp', w: (b & 0x3fff) + 1, h: ((b >> 14) & 0x3fff) + 1 }; }
    if (c === 'VP8X' && buf.length >= 30) return { type: 'image/webp', ext: 'webp', w: buf.readUIntLE(24, 3) + 1, h: buf.readUIntLE(27, 3) + 1 };
  }
  return null;
}

class ImageStore {
  constructor(opts = {}) {
    this.dir = opts.dataDir ? path.join(opts.dataDir, 'images') : null;
    this.allowPrivate = !!opts.allowPrivate;       // tests only
    this.mem = new Map();                          // hash -> {buf, type, w, h}
    this.blocked = () => [];                       // () => string[] of blocked host names (set by the hub)
    this.failures = new Map();
    if (this.dir) { try { fs.mkdirSync(this.dir, { recursive: true }); } catch (e) { this.dir = null; } }
  }

  hostBlocked(host) {
    const h = String(host).toLowerCase().replace(/^www\./, '');
    return this.blocked().some(b => h === b || h.endsWith('.' + b));
  }

  async checkUrl(u) {
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Use a link that starts with http:// or https://');
    if (u.username || u.password) throw new Error('That link contains a login — use a plain image link.');
    const port = u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80);
    if (![80, 443, 8080, 8443].includes(port) && !this.allowPrivate) throw new Error('That link uses an unsupported port.');
    if (this.hostBlocked(u.hostname)) throw new Error('Images from that website are not allowed.');
    const host = u.hostname.replace(/^\[|\]$/g, '');
    let addrs;
    if (net.isIP(host)) addrs = [{ address: host, family: net.isIPv6(host) ? 6 : 4 }];
    else {
      try { addrs = await dns.promises.lookup(host, { all: true }); } catch (e) { throw new Error('Could not find that website.'); }
    }
    if (!addrs.length) throw new Error('Could not find that website.');
    if (!this.allowPrivate && addrs.some(a => isPrivateIp(a.address))) throw new Error('That link points somewhere that isn\'t allowed.');
    return { addr: addrs[0], port };
  }

  download(urlStr, hops = 0) {
    return new Promise(async (resolve, reject) => {
      let u;
      try { u = new URL(urlStr); } catch (e) { return reject(new Error('That doesn\'t look like a web link.')); }
      let target;
      try { target = await this.checkUrl(u); } catch (e) { return reject(e); }
      const lib = u.protocol === 'https:' ? https : http;
      const req = lib.request({
        host: u.hostname.replace(/^\[|\]$/g, ''), port: target.port, path: u.pathname + u.search, method: 'GET', timeout: TIMEOUT_MS,
        servername: net.isIP(u.hostname) ? undefined : u.hostname,
        headers: { 'User-Agent': 'CursorClash-image-fetch/1', Accept: 'image/png,image/jpeg,image/gif,image/webp', 'Accept-Encoding': 'identity' },
        lookup: (h, o, cb) => (o && o.all ? cb(null, [{ address: target.addr.address, family: target.addr.family }]) : cb(null, target.addr.address, target.addr.family))   // pinned to the address we vetted
      }, res => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          if (hops >= 3) return reject(new Error('That link redirects too many times.'));
          let next; try { next = new URL(res.headers.location, u).href; } catch (e) { return reject(new Error('Bad redirect.')); }
          return this.download(next, hops + 1).then(resolve, reject);
        }
        if (res.statusCode !== 200) { res.resume(); return reject(new Error('The website answered with an error (' + res.statusCode + ').')); }
        const len = Number(res.headers['content-length']);
        if (len > MAX_BYTES) { res.resume(); return reject(new Error('That image is too big (limit 1.5 MB).')); }
        const chunks = []; let size = 0;
        res.on('data', c => { size += c.length; if (size > MAX_BYTES) { reject(new Error('That image is too big (limit 1.5 MB).')); req.destroy(); } else chunks.push(c); });
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', () => reject(new Error('The download was interrupted.')));
      });
      req.on('timeout', () => { reject(new Error('That website took too long to answer.')); req.destroy(); });
      req.on('error', () => reject(new Error('Could not download that image.')));
      req.end();
    });
  }

  // returns {hash, type, w, h}; throws an Error with a message that is safe to show to the player
  async fetchAndStore(urlStr) {
    if (typeof urlStr !== 'string' || urlStr.length > 500) throw new Error('That link is too long.');
    const buf = await this.download(urlStr.trim());
    return this.put(buf);
  }

  put(buf) {
    const info = sniff(buf);
    if (!info) throw new Error('That link isn\'t a PNG, JPEG, GIF or WebP picture.');
    if (!(info.w >= 8 && info.h >= 8)) throw new Error('That picture is too small.');
    if (info.w > MAX_DIM || info.h > MAX_DIM) throw new Error('That picture is too large (max ' + MAX_DIM + '×' + MAX_DIM + ' pixels).');
    const hash = crypto.createHash('sha256').update(buf).digest('hex');
    const rec = { buf, type: info.type, w: info.w, h: info.h };
    this.mem.set(hash, rec);
    if (this.mem.size > MAX_STORED) this.mem.delete(this.mem.keys().next().value);
    if (this.dir) {
      try {
        fs.writeFileSync(path.join(this.dir, hash + '.' + info.ext), buf);
        const files = fs.readdirSync(this.dir);
        if (files.length > MAX_STORED) {
          const old = files.map(f => [f, fs.statSync(path.join(this.dir, f)).mtimeMs]).sort((a, b) => a[1] - b[1]).slice(0, files.length - MAX_STORED);
          for (const [f] of old) fs.unlinkSync(path.join(this.dir, f));
        }
      } catch (e) { /* the memory copy still works */ }
    }
    return { hash, type: info.type, w: info.w, h: info.h };
  }

  get(hash) {
    if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) return null;
    let rec = this.mem.get(hash);
    if (!rec && this.dir) {
      for (const ext of ['png', 'jpg', 'gif', 'webp']) {
        try {
          const buf = fs.readFileSync(path.join(this.dir, hash + '.' + ext));
          const info = sniff(buf);
          if (info) { rec = { buf, type: info.type, w: info.w, h: info.h }; this.mem.set(hash, rec); break; }
        } catch (e) { /* try the next extension */ }
      }
    }
    return rec || null;
  }

  purge() {
    const n = this.mem.size;
    this.mem.clear();
    if (this.dir) { try { for (const f of fs.readdirSync(this.dir)) fs.unlinkSync(path.join(this.dir, f)); } catch (e) { /* ignore */ } }
    return n;
  }
  stats() { let bytes = 0; for (const r of this.mem.values()) bytes += r.buf.length; return { count: this.mem.size, bytes }; }
}

module.exports = { ImageStore, sniff, isPrivateIp };
