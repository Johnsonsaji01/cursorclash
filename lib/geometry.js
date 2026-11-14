'use strict';
// Shared geometry for drawings and wall collision. The browser client carries an identical copy.

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const r1 = v => Math.round(v * 10) / 10;
const r2 = v => Math.round(v * 100) / 100;
const num = v => (typeof v === 'number' && Number.isFinite(v));

function polyPts(shape, pts, circleSegs) {
  if (shape === 'free') return pts;
  if (pts.length < 2) return [];
  const p0 = pts[0], p1 = pts[1];
  if (shape === 'line') return [p0, p1];
  if (shape === 'rect') return [[p0[0], p0[1]], [p1[0], p0[1]], [p1[0], p1[1]], [p0[0], p1[1]], [p0[0], p0[1]]];
  const r = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
  const out = [];
  for (let i = 0; i <= circleSegs; i++) {
    const a = (i / circleSegs) * Math.PI * 2;
    out.push([p0[0] + Math.cos(a) * r, p0[1] + Math.sin(a) * r]);
  }
  return out;
}

function polyLength(poly) {
  let L = 0;
  for (let i = 1; i < poly.length; i++) L += Math.hypot(poly[i][0] - poly[i - 1][0], poly[i][1] - poly[i - 1][1]);
  return L;
}

function segsFrom(poly, owner) {
  const out = [];
  for (let i = 1; i < poly.length; i++) out.push({ ax: poly[i - 1][0], ay: poly[i - 1][1], bx: poly[i][0], by: poly[i][1], o: owner });
  return out;
}

// keep only the first maxLen units of a polyline
function truncatePoly(pts, maxLen) {
  const out = [pts[0]];
  let used = 0;
  for (let i = 1; i < pts.length; i++) {
    const d = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    if (used + d <= maxLen) { out.push(pts[i]); used += d; continue; }
    const f = d > 0 ? (maxLen - used) / d : 0;
    if (f > 0) out.push([r1(pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * f), r1(pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * f)]);
    break;
  }
  return out;
}

// 0..1 = how far along (x,y)->(tx,ty) the wall segment s is crossed, or -1 for no crossing
function segHit(x, y, tx, ty, s) {
  const ex = s.bx - s.ax, ey = s.by - s.ay;
  const s0 = ex * (y - s.ay) - ey * (x - s.ax);
  const s1 = ex * (ty - s.ay) - ey * (tx - s.ax);
  if (!((s0 > 1e-9 && s1 < -1e-9) || (s0 < -1e-9 && s1 > 1e-9))) return -1;
  const t = s0 / (s0 - s1);
  const ix = x + (tx - x) * t, iy = y + (ty - y) * t;
  const u = ((ix - s.ax) * ex + (iy - s.ay) * ey) / (ex * ex + ey * ey || 1);
  return u < -0.002 || u > 1.002 ? -1 : t;
}

// Move from (fx,fy) towards (tx,ty); other players' walls stop the move and the cursor slides along them.
function resolveMove(fx, fy, tx, ty, segs, owner) {
  let x = fx, y = fy;
  for (let iter = 0; iter < 4; iter++) {
    const dx = tx - x, dy = ty - y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-4) break;
    let hitT = -1, hitSeg = null;
    for (const s of segs) {
      if (s.o === owner) continue;           // you can walk through your own walls
      const h = segHit(x, y, tx, ty, s);
      if (h >= 0 && (hitSeg === null || h < hitT)) { hitT = h; hitSeg = s; }
    }
    if (!hitSeg) { x = tx; y = ty; break; }
    const t = Math.max(0, hitT - 0.5 / len);  // stop half a unit short of the wall
    x += dx * t; y += dy * t;
    let wx = hitSeg.bx - hitSeg.ax, wy = hitSeg.by - hitSeg.ay;
    const wl = Math.hypot(wx, wy) || 1; wx /= wl; wy /= wl;
    const slide = (dx * wx + dy * wy) * (1 - hitT);
    tx = x + wx * slide; ty = y + wy * slide;
  }
  return [x, y];
}

module.exports = { clamp, r1, r2, num, polyPts, polyLength, segsFrom, truncatePoly, segHit, resolveMove };
