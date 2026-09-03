// Vanity search worker. One independent search stream per worker.
// Security: the private key NEVER leaves this worker except on an explicit
// 'export' request; progress messages carry only counts + the public address.
import { Searcher, N } from "./engine.mjs";

let searcher = null;
let running = false;
const BATCH = 512;

function randSeed() {
  const b = crypto.getRandomValues(new Uint8Array(32));
  let x = 0n;
  for (const v of b) x = (x << 8n) | BigInt(v);
  // rejection: keep it in [1, n-1]
  x = (x % (N - 1n)) + 1n;
  return x;
}

function fresh() { searcher = new Searcher(randSeed(), BATCH); }

function progress() {
  const info = searcher ? searcher.bestInfo() : null;
  postMessage({
    type: "progress",
    tries: searcher ? searcher.tries : 0n,
    count: info ? info.count : -1,
    inj: info ? info.inj : null,
  });
}

function slice() {
  if (!running || !searcher) return;
  const t0 = performance.now();
  while (running && performance.now() - t0 < 60) searcher.run(); // ~60ms slices keep 'stop' responsive
  progress();
  if (running) setTimeout(slice, 0);
}

onmessage = (e) => {
  const m = e.data || {};
  switch (m.type) {
    case "start":
      if (!searcher) fresh();
      running = true;
      slice();
      break;
    case "stop":
      running = false;
      progress();
      break;
    case "reseed": // new stream (main keeps the displayed best, monotonic)
      fresh();
      break;
    case "export": {
      const k = searcher && searcher.best ? searcher.exportBestKey() : null;
      postMessage({ type: "exported", key: k }); // key = {privHex, inj, count} or null
      fresh(); // re-seed this stream after any export (related-key hygiene)
      break;
    }
  }
};
