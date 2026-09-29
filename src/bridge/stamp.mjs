// Stamp the bundle's content hash into bridge.html's import URL.
// The page is served max-age=0 but /lib/bridge.js is cached for 4h, so without a
// versioned URL a returning browser runs fresh HTML against a stale bundle.
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

const bundle = readFileSync("lib/bridge.js");
const hash = createHash("sha256").update(bundle).digest("hex").slice(0, 10);
const page = "bridge.html";
let html = readFileSync(page, "utf8");
const next = `/lib/bridge.js?v=${hash}`;
const re = /\/lib\/bridge\.js(\?v=[a-f0-9]+)?/g;
const found = html.match(re) || [];
if (!found.length) { console.error("no import of /lib/bridge.js found in " + page); process.exit(1); }
html = html.replace(re, next);
writeFileSync(page, html);
console.log(`stamped ${found.length} reference(s) -> ${next}`);
