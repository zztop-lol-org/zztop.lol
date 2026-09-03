// Validate the Rust/WASM search against the P0 derivation (src/inj.mjs).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { injFromPriv, injFromEthAddress } from "../src/inj.mjs";
import { leadingZ } from "../src/engine.mjs";

const WASM = "wasm/target/wasm32-unknown-unknown/release/zzsearch.wasm";
const { instance } = await WebAssembly.instantiate(readFileSync(WASM), {});
const ex = instance.exports;
const mem = () => new Uint8Array(ex.memory.buffer);
const SEED = ex.seed_ptr();
const OUT = ex.out_ptr();
const writeSeed = (b) => mem().set(b, SEED);
const readOut = () => mem().slice(OUT, OUT + 53);

let pass = 0;
const ok = (n) => { console.log("  ok -", n); pass++; };

// 1) addr_for_seed derivation matches injFromPriv over many random scalars
{
  let n = 0;
  for (let t = 0; t < 400; t++) {
    const seed = crypto.getRandomValues(new Uint8Array(32));
    writeSeed(seed);
    ex.addr_for_seed();
    const out = readOut();
    const scalar = out.slice(1, 33);   // reduced scalar (the private key)
    const addr = out.slice(33, 53);    // 20-byte eth address
    if (scalar.every((x) => x === 0)) continue; // skip degenerate
    assert.equal(injFromEthAddress(addr), injFromPriv(scalar), "wasm addr != injFromPriv(scalar)");
    n++;
  }
  ok(`WASM derivation matches injFromPriv over ${n} scalars`);
}

// 2) search: best is self-consistent with the P0 derivation
{
  const seed = crypto.getRandomValues(new Uint8Array(32));
  writeSeed(seed);
  ex.init();
  const tries = ex.run(80); // 80 batches * 512 * 2 ~ 82k addresses
  const out = readOut();
  const count = out[0], scalar = out.slice(1, 33), addr = out.slice(33, 53);
  assert.ok(count >= 1, "should find >= 1 leading z in ~82k tries");
  // the recorded scalar must derive the recorded address with that leading-z count
  assert.equal(injFromEthAddress(addr), injFromPriv(scalar));
  assert.equal(leadingZ(addr), count);
  const inj = injFromPriv(scalar);
  const body = inj.slice(4); let sc = 0; while (body[sc] === "z") sc++;
  assert.equal(sc, count);
  ok(`search best verified: ${count}z -> ${inj.slice(0, 14)}... (tries=${tries})`);
}

// 3) throughput (single WASM instance)
{
  const seed = crypto.getRandomValues(new Uint8Array(32));
  writeSeed(seed); ex.init();
  ex.run(20); // warm
  const t0 = performance.now(); const base = ex.run(0); // run(0) just returns tries snapshot
  const before = Number(base);
  const deadline = t0 + 1500;
  while (performance.now() < deadline) ex.run(20);
  const after = Number(readOutTries());
  const dt = (performance.now() - t0) / 1000;
  console.log(`  WASM throughput: ${((after - before) / dt / 1000).toFixed(0)}k addr/s (single instance)`);
  ok("throughput measured");
  function readOutTries() { return ex.run(0); }
}

console.log(`\nALL ${pass} wasm checks passed.`);
