'use strict';
/*
 * Bot / macro protection. Zero dependencies.
 *
 *  1. Human check (once per ~2 h, per network): the page fetches a signed challenge, solves a small
 *     proof-of-work in the background and asks the visitor to press-and-hold a button. The server checks
 *     the proof, a minimum elapsed time, the hold length and that real (trusted) pointer/keyboard events
 *     were involved, then hands out a signed "ticket" bound to the visitor's network. No ticket, no joining.
 *  2. Optional Cloudflare Turnstile on top (set TURNSTILE_SITEKEY and TURNSTILE_SECRET).
 *  3. Per-network limits: joins, simultaneous players, request rate, private-world creation.
 *  4. In-game: a cursor speed cap and an auto-clicker detector (many attacks without moving the cursor).
 *     A flagged player is sent back through the human check; repeat offenders get a temporary ban.
 *
 * None of this can stop a determined human-driven or fully browser-automated attacker on its own; Turnstile
 * is the strongest layer and is meant to be switched on for a public deployment.
 */
const crypto = require('node:crypto');
const net = require('node:net');

function normIp(raw) {
  let ip = String(raw || 'unknown').trim().slice(0, 64);
  if (ip.startsWith('::ffff:') && ip.includes('.')) ip = ip.slice(7);
  return ip || 'unknown';
}

function expandV6(ip) {
  const [h, t] = ip.split('::');
  const hs = h ? h.split(':') : [];
  if (t === undefined) return hs;
  const ts = t ? t.split(':') : [];
  return [...hs, ...Array(Math.max(0, 8 - hs.length - ts.length)).fill('0'), ...ts];
}

// What counts as "one network": an IPv4 address, or an IPv6 /64
function ipKey(ip) {
  if (net.isIPv6(ip)) return expandV6(ip).slice(0, 4).map(g => g.toLowerCase().replace(/^0+(?=.)/, '')).join(':');
  return ip;
}

function clientIp(req, trustProxy) {
  if (trustProxy) {
    const cf = req.headers['cf-connecting-ip'];
    if (typeof cf === 'string' && cf) return normIp(cf);
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff) return normIp(xff.split(',')[0]);
    const xr = req.headers['x-real-ip'];
    if (typeof xr === 'string' && xr) return normIp(xr);
  }
  return normIp(req.socket && req.socket.remoteAddress);
}

function leadingZeroBitsOk(digest, bits) {
  let n = bits;
  for (let i = 0; n > 0 && i < digest.length; i++) {
    if (n >= 8) { if (digest[i] !== 0) return false; n -= 8; }
    else { if ((digest[i] >> (8 - n)) !== 0) return false; n = 0; }
  }
  return n === 0;
}

function powOk(salt, nonce, bits) {
  if (!Number.isSafeInteger(nonce) || nonce < 0) return false;
  return leadingZeroBitsOk(crypto.createHash('sha256').update(salt + ':' + nonce).digest(), bits);
}

async function cloudflareTurnstile(token, secret, ip) {
  try {
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST', body: new URLSearchParams({ secret, response: String(token || ''), remoteip: ip }),
      signal: AbortSignal.timeout(5000)
    });
    const j = await r.json();
    return !!(j && j.success);
  } catch (e) { return false; }
}

class Security {
  constructor(C, opts = {}) {
    this.C = C;
    this.secret = C.SECRET ? crypto.createHash('sha256').update(String(C.SECRET)).digest() : crypto.randomBytes(32);
    this.buckets = new Map();      // rate limiter state
    this.usedChallenges = new Map();
    this.revoked = new Map();      // ticket id -> expiry (ms)
    this.strikes = new Map();      // ipKey -> [timestamps]
    this.bans = new Map();         // ipKey -> expiry (ms)
    this.turnstile = C.TURNSTILE_SITEKEY && C.TURNSTILE_SECRET
      ? (opts.turnstileVerify || ((tok, ip) => cloudflareTurnstile(tok, C.TURNSTILE_SECRET, ip)))
      : null;
  }

  // ----- signed tokens -----
  mac(s) { return crypto.createHmac('sha256', this.secret).update(s).digest('base64url'); }
  pack(obj) { const b = Buffer.from(JSON.stringify(obj)).toString('base64url'); return b + '.' + this.mac(b); }
  unpack(tok) {
    if (typeof tok !== 'string' || tok.length > 700) return null;
    const i = tok.indexOf('.');
    if (i < 1) return null;
    const b = tok.slice(0, i), m = tok.slice(i + 1), want = this.mac(b);
    if (m.length !== want.length || !crypto.timingSafeEqual(Buffer.from(m), Buffer.from(want))) return null;
    try { return JSON.parse(Buffer.from(b, 'base64url').toString('utf8')); } catch (e) { return null; }
  }

  // ----- rate limiting (token buckets) -----
  allow(key, cap, perSec) {
    if (!this.C.RATE_LIMITS) return true;
    const t = Date.now() / 1000;
    let b = this.buckets.get(key);
    if (!b) { b = { t, tok: cap }; this.buckets.set(key, b); }
    b.tok = Math.min(cap, b.tok + (t - b.t) * perSec);
    b.t = t;
    if (b.tok < 1) return false;
    b.tok -= 1;
    return true;
  }

  // ----- strikes and bans -----
  banned(ipk) {
    const x = this.bans.get(ipk);
    if (!x) return false;
    if (Date.now() > x) { this.bans.delete(ipk); return false; }
    return true;
  }
  strike(ipk) {
    const t = Date.now();
    const list = (this.strikes.get(ipk) || []).filter(x => t - x < this.C.STRIKE_WINDOW_SEC * 1000);
    list.push(t);
    this.strikes.set(ipk, list);
    if (list.length >= this.C.STRIKES_TO_BAN) { this.bans.set(ipk, t + this.C.BAN_SEC * 1000); this.strikes.delete(ipk); return true; }
    return false;
  }

  // ----- human check -----
  newChallenge(ipk) {
    const now = Date.now();
    const o = { c: crypto.randomBytes(9).toString('base64url'), s: crypto.randomBytes(12).toString('hex'),
      b: this.C.POW_BITS, i: now, x: now + this.C.CHALLENGE_TTL * 1000, p: ipk };
    return { ch: this.pack(o), salt: o.s, bits: o.b, ts: this.C.TURNSTILE_SITEKEY || null };
  }

  // returns null when the visitor passes, otherwise [status, {error}]
  async verify(body, ipk, ip) {
    const C = this.C;
    const fail = (status, error) => [status, { error }];
    if (!body || typeof body !== 'object') return fail(400, 'bad request');
    if (body.hp) return fail(400, 'bad request');                                 // honeypot field was filled
    const o = this.unpack(body.ch);
    if (!o || o.p !== ipk) return fail(400, 'Verification expired — please try again.');
    const now = Date.now();
    if (now > o.x) return fail(400, 'Verification expired — please try again.');
    if (this.usedChallenges.has(o.c)) return fail(400, 'Verification expired — please try again.');
    this.usedChallenges.set(o.c, o.x);                                            // single use, even if the rest fails
    if (!powOk(o.s, body.nonce, o.b)) return fail(400, 'Verification failed — please try again.');
    if (C.HUMAN_CHECK) {
      if (now - o.i < C.MIN_VERIFY_MS) return fail(400, 'That was a bit fast — please hold the button again.');
      const t = body;
      const holdOk = typeof t.hold === 'number' && t.hold >= C.MIN_HOLD_MS && t.hold <= 120000;
      const inputOk = t.kind === 'key' || t.pt === 'touch' || (Number.isInteger(t.moves) && t.moves >= C.MIN_MOVES);
      if (!holdOk || t.trusted !== true || !inputOk) return fail(400, 'Please press and hold the button to continue.');
    }
    if (this.turnstile) {
      const tok = body.tsToken;
      if (typeof tok !== 'string' || !tok || tok.length > 2100 || !(await this.turnstile(tok, ip))) {
        return fail(400, 'The security check failed — please try again.');
      }
    }
    return null;
  }

  issueTicket(ipk) {
    const tid = crypto.randomBytes(9).toString('base64url');
    return { ticket: this.pack({ t: tid, p: ipk, x: Date.now() + this.C.TICKET_TTL * 1000 }), tid };
  }
  checkTicket(tok, ipk) {
    const o = this.unpack(tok);
    if (!o || typeof o.t !== 'string' || o.p !== ipk || Date.now() > o.x) return null;
    if (this.revoked.has(o.t)) return null;
    return { tid: o.t, exp: o.x };
  }
  revoke(tid, exp) { this.revoked.set(tid, exp); }

  sweep() {
    const now = Date.now(), t = now / 1000;
    for (const [k, b] of this.buckets) if (t - b.t > 120) this.buckets.delete(k);
    for (const [k, x] of this.usedChallenges) if (now > x) this.usedChallenges.delete(k);
    for (const [k, x] of this.revoked) if (now > x) this.revoked.delete(k);
    for (const [k, x] of this.bans) if (now > x) this.bans.delete(k);
    for (const [k, l] of this.strikes) if (!l.some(x => now - x < this.C.STRIKE_WINDOW_SEC * 1000)) this.strikes.delete(k);
  }
}

module.exports = { Security, clientIp, ipKey, normIp, powOk };
