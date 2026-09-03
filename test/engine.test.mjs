// End-to-end correctness of the search engine against the P0 derivation.
import assert from "node:assert/strict";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { Searcher, leadingZ, N } from "../src/engine.mjs";
import { injFromPriv, convert8to5, ethAddressFromPriv } from "../src/inj.mjs";

let pass = 0;
const ok = (n) => { console.log("  ok -", n); pass++; };
const scalarBytes = (s) => hexToBytes(s.toString(16).padStart(64, "0"));
const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

// 1) leadingZ matches the string-derived count over random addresses
{
  for (let t = 0; t < 500; t++) {
    const priv = crypto.getRandomValues(new Uint8Array(32));
    const inj = injFromPriv(priv);
    const body = inj.slice(inj.indexOf("1") + 1);
    let strCount = 0; while (body[strCount] === "z") strCount++;
    assert.equal(leadingZ(ethAddressFromPriv(priv)), Math.min(strCount, 32));
  }
  ok("leadingZ() equals the string leading-z count (500 addresses)");
}

// 2) EVERY candidate the engine emits maps to injFromPriv(scalar) exactly.
{
  const seed = BigInt("0x" + bytesToHex(crypto.getRandomValues(new Uint8Array(32))));
  const s = new Searcher(seed, 64);
  let checked = 0, mismatches = 0;
  for (let b = 0; b < 8; b++) {
    s.run((addr20, scalar) => {
      const inj = injFromPriv(scalarBytes(scalar));
      const asStr = convert8to5(addr20).map((g) => CHARSET[g]).join("");
      if (!inj.startsWith("inj1" + asStr)) mismatches++;
      checked++;
    });
  }
  assert.equal(mismatches, 0, `${mismatches}/${checked} candidate mismatches`);
  ok(`all ${checked} engine candidates match injFromPriv(scalar) exactly`);
}

// 3) each point emits both a key and its negation (n-k)
{
  const s = new Searcher(12345n, 4);
  const scalars = new Set();
  s.run((_a, sc) => scalars.add(sc.toString()));
  let pairs = 0;
  for (const scStr of scalars) {
    const sc = BigInt(scStr), neg = ((N - (sc % N)) % N).toString();
    if (scalars.has(neg)) pairs++;
  }
  assert.ok(pairs >= 2, "negation pairs must be present");
  ok("each point emits both k and n-k (negation trick)");
}

// 4) best pick is real: its recorded scalar derives an address with exactly its count.
{
  const s = new Searcher(BigInt("0x" + bytesToHex(crypto.getRandomValues(new Uint8Array(32)))), 512);
  for (let b = 0; b < 40; b++) s.run(); // ~40k addresses, expect a few leading z
  const info = s.bestInfo();
  assert.ok(info && info.count >= 1, "should find >= 1 leading z in ~40k tries");
  const body = info.inj.slice(info.inj.indexOf("1") + 1);
  let strCount = 0; while (body[strCount] === "z") strCount++;
  assert.equal(strCount, info.count, "displayed inj leading-z must equal best.count");
  ok(`best pick verified: ${info.count} leading z -> ${info.inj.slice(0, 14)}... (tries=${info.tries})`);
}

// 5) exportBestKey re-verifies and returns a key that derives the same address
{
  const s = new Searcher(999n, 256);
  for (let b = 0; b < 20; b++) s.run();
  const exp = s.exportBestKey();
  assert.equal(injFromPriv(hexToBytes(exp.privHex)), exp.inj);
  assert.equal(exp.privHex.length, 64);
  ok("exportBestKey() returns a private key that re-derives the same inj address");
}

console.log(`\nALL ${pass} engine checks passed.`);
