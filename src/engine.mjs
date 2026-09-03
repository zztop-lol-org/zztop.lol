// Vanity search engine.
// Hot loop = affine batch addition: keep a batch base B = base*G, add the
// PRECOMPUTED constants 1G..mG to it (each an independent affine addition), and
// batch-invert all m denominators with one modular inverse (Montgomery's trick).
// Each resulting point (x,y) yields TWO addresses: key base+j (x,y) and key
// n-(base+j) via the free negation (x, p-y). Prefix-bit check counts leading z.
//
// Field arithmetic (modmul/modinv) is noble's audited Fp; only the standard
// affine point-add formula is ours. Validated end-to-end vs src/inj.mjs.
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { injFromPriv } from "./inj.mjs";

const Point = secp256k1.ProjectivePoint;
const Fp = secp256k1.CURVE.Fp;
export const N = secp256k1.CURVE.n; // group order
const P_PRIME = Fp.ORDER;           // field prime p

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const RANK = CHARSET.split("").map((c) => c.charCodeAt(0));
const Z_VAL = CHARSET.indexOf("z"); // 2

function be32(buf, off, x) { for (let i = off + 31; i >= off; i--) { buf[i] = Number(x & 0xffn); x >>= 8n; } }

export function leadingZ(a) {
  let c = 0;
  for (let g = 0; g < 32; g++) {
    const bit = g * 5, bp = bit >> 3, rem = bit & 7;
    const v = rem <= 3 ? (a[bp] >>> (3 - rem)) & 31 : ((a[bp] << (rem - 3)) | (a[bp + 1] >>> (11 - rem))) & 31;
    if (v === Z_VAL) c++; else break;
  }
  return c;
}
function group(a, g) {
  const bit = g * 5, bp = bit >> 3, rem = bit & 7;
  return rem <= 3 ? (a[bp] >>> (3 - rem)) & 31 : ((a[bp] << (rem - 3)) | (a[bp + 1] >>> (11 - rem))) & 31;
}
function betterLex(a, b) { for (let g = 0; g < 32; g++) { const d = RANK[group(a, g)] - RANK[group(b, g)]; if (d) return d; } return 0; }

function batchInvert(zs) {
  const n = zs.length, acc = new Array(n);
  let a = 1n;
  for (let i = 0; i < n; i++) { acc[i] = a; a = Fp.mul(a, zs[i]); }
  let inv = Fp.inv(a);
  const out = new Array(n);
  for (let i = n - 1; i >= 0; i--) { out[i] = Fp.mul(inv, acc[i]); inv = Fp.mul(inv, zs[i]); }
  return out;
}

// one-time table of affine multiples jG for j=1..m (per batch size, cached)
const tableCache = new Map();
function multiplesOfG(m) {
  let t = tableCache.get(m);
  if (t) return t;
  const xs = new Array(m + 1), ys = new Array(m + 1);
  for (let j = 1; j <= m; j++) { const a = Point.BASE.multiply(BigInt(j)).toAffine(); xs[j] = a.x; ys[j] = a.y; }
  t = { xs, ys };
  tableCache.set(m, t);
  return t;
}

export class Searcher {
  constructor(seed, batch = 512) {
    this.m = batch;
    this.base = ((seed % (N - 2n)) + 1n); // in [1, n-2], room for +m
    const B = Point.BASE.multiply(this.base).toAffine();
    this.bx = B.x; this.by = B.y;
    this.tbl = multiplesOfG(this.m);
    this.tries = 0n;
    this.best = null;              // { count, addr:Uint8Array(20), scalar:bigint }
    this._buf = new Uint8Array(64);
  }

  _consider(addr20, scalar) {
    const count = leadingZ(addr20), b = this.best;
    let take = !b || count > b.count || (count === b.count && count >= 1 && betterLex(addr20, b.addr) > 0);
    if (take) this.best = { count, addr: addr20.slice(), scalar };
  }

  run(onCandidate) {
    const m = this.m, { xs, ys } = this.tbl;
    // wrap guard (astronomically unlikely)
    if (this.base > N - BigInt(m) - 2n) { this.base = 1n; const B = Point.BASE.multiply(this.base).toAffine(); this.bx = B.x; this.by = B.y; }
    // denominators d_j = x_{jG} - x_B
    const d = new Array(m);
    let zeroHit = false;
    for (let j = 1; j <= m; j++) { const dj = Fp.sub(xs[j], this.bx); if (dj === 0n) { zeroHit = true; break; } d[j - 1] = dj; }
    if (zeroHit) { this.base = (this.base + 7n) % (N - 2n) + 1n; const B = Point.BASE.multiply(this.base).toAffine(); this.bx = B.x; this.by = B.y; return; }
    const dinv = batchInvert(d);
    const buf = this._buf;
    let lastX = this.bx, lastY = this.by;
    for (let j = 1; j <= m; j++) {
      const lam = Fp.mul(Fp.sub(ys[j], this.by), dinv[j - 1]);       // slope
      const xr = Fp.sub(Fp.sub(Fp.mul(lam, lam), this.bx), xs[j]);   // λ² - xB - xjG
      const yr = Fp.sub(Fp.mul(lam, Fp.sub(this.bx, xr)), this.by);  // λ(xB - xr) - yB
      const s1 = this.base + BigInt(j);
      be32(buf, 0, xr); be32(buf, 32, yr);
      const h1 = keccak_256(buf).subarray(12, 32);
      this._consider(h1, s1); if (onCandidate) onCandidate(h1, s1);
      be32(buf, 32, P_PRIME - yr);                                   // negation -> key n-s1
      const s2 = (N - (s1 % N)) % N;
      const h2 = keccak_256(buf).subarray(12, 32);
      this._consider(h2, s2); if (onCandidate) onCandidate(h2, s2);
      this.tries += 2n;
      lastX = xr; lastY = yr;
    }
    // advance base to B + mG (the last computed point)
    this.bx = lastX; this.by = lastY; this.base += BigInt(m);
  }

  bestInfo() {
    if (!this.best) return null;
    return { count: this.best.count, inj: injFromPriv(this._sb(this.best.scalar)), tries: this.tries };
  }
  _sb(s) { const out = new Uint8Array(32); be32(out, 0, s); return out; }

  exportBestKey() {
    if (!this.best) return null;
    const priv = this._sb(this.best.scalar);
    const inj = injFromPriv(priv);                       // independent slow-path re-verify
    return { privHex: [...priv].map((b) => b.toString(16).padStart(2, "0")).join(""), inj, count: this.best.count };
  }
}
