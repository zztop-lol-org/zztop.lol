// Vanity search worker. One independent search stream per worker.
// Uses the Rust/WASM engine when it instantiates, else falls back to the JS engine.
// Security: the private key NEVER leaves this worker except on an explicit
// 'export' request; progress messages carry only counts + the public address.
import { Searcher, N } from "./engine.mjs";
import { injFromPriv } from "./inj.mjs";
import { WASM_B64 } from "./wasm-b64.js";

const BATCH = 512;
function randBytes32() { return crypto.getRandomValues(new Uint8Array(32)); }
function randSeed() { let x = 0n; for (const v of randBytes32()) x = (x << 8n) | BigInt(v); return (x % (N - 1n)) + 1n; }
function b64ToBytes(b64) { const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }
function hex(bytes) { let s = ""; for (const b of bytes) s += b.toString(16).padStart(2, "0"); return s; }

// ---- JS backend ----
function jsEngine() {
  let s = new Searcher(randSeed(), BATCH);
  return {
    reseed() { s = new Searcher(randSeed(), BATCH); },
    slice() { const t0 = performance.now(); while (performance.now() - t0 < 60) s.run(); },
    tries() { return s.tries; },
    bestInfo() { return s.bestInfo(); },
    exportKey() { return s.exportBestKey(); },
  };
}

// ---- WASM backend (private key re-derived + verified via the JS inj path) ----
function wasmEngine(ex) {
  const mem = () => new Uint8Array(ex.memory.buffer);
  const SEED = ex.seed_ptr(), OUT = ex.out_ptr();
  const seed = () => { mem().set(randBytes32(), SEED); ex.init(); };
  const out = () => mem().slice(OUT, OUT + 53);
  seed();
  const info = () => { const o = out(); const scalar = o.slice(1, 33); if (scalar.every((x) => x === 0)) return null; return { o, scalar }; };
  return {
    reseed() { seed(); },
    slice() { ex.run(8); },            // ~one time-slice of batches
    tries() { return ex.run(0); },     // run(0) publishes OUT + returns tries (BigInt i64)
    bestInfo() { const r = info(); if (!r) return null; return { count: r.o[0], inj: injFromPriv(r.scalar) }; },
    exportKey() { const r = info(); if (!r) return null; const inj = injFromPriv(r.scalar); return { privHex: hex(r.scalar), inj, count: r.o[0] }; },
  };
}

let engine = null, running = false, wantStart = false, backend = "js";

async function boot() {
  try {
    const { instance } = await WebAssembly.instantiate(b64ToBytes(WASM_B64), {});
    engine = wasmEngine(instance.exports); backend = "wasm";
  } catch (e) {
    engine = jsEngine(); backend = "js";
  }
  if (wantStart) { running = true; slice(); }
}
boot();

function progress() {
  const info = engine ? engine.bestInfo() : null;
  postMessage({ type: "progress", backend, tries: engine ? engine.tries() : 0n, count: info ? info.count : -1, inj: info ? info.inj : null });
}
function slice() {
  if (!running || !engine) return;
  engine.slice();
  progress();
  if (running) setTimeout(slice, 0);
}

onmessage = (e) => {
  const m = e.data || {};
  switch (m.type) {
    case "start": if (!engine) { wantStart = true; } else { running = true; slice(); } break;
    case "stop": running = false; progress(); break;
    case "reseed": if (engine) engine.reseed(); break;
    case "export": {
      const k = engine && engine.bestInfo() ? engine.exportKey() : null;
      postMessage({ type: "exported", key: k });
      if (engine) engine.reseed(); // related-key hygiene: new stream after any export
      break;
    }
  }
};
