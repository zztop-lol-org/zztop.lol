// Read-only integration probe: download the deployed WASM, verify its checksum,
// then execute it LOCALLY with an isolated fixture based on the current round.
// This checks timing/ID mechanics, not live eligibility or chain inclusion.
// Run: node test/probe-buyback.mjs
import assert from "node:assert/strict";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex } from "@noble/hashes/utils";
import { MAINNET, CONTRACT, REVIEWED_CODE_HASH, loadSnapshot } from "../src/auction/buyback.mjs";
import { getJSON, fromBase64, extractJoinKey, joinTxId } from "../src/auction/presign.mjs";

const ep = MAINNET.lcds[0], snapshot = await loadSnapshot(ep);
const code = await getJSON(ep, "/cosmwasm/wasm/v1/code/" + snapshot.codeId, { timeoutMs: 15000 });
const wasm = fromBase64(code.data);
assert.equal(bytesToHex(sha256(wasm)), REVIEWED_CODE_HASH);
const joinKey = extractJoinKey(wasm);
const owner = "inj100000000d44wq9u6ls5r8ds46jdu95dg40pekr";
// Give the local fixture capacity and a whitelisted user. No live state is changed.
const round = { ...snapshot.round, total_deposit: "0", used_slots: 0 };
const config = { ...snapshot.config, bid_time_protection: snapshot.config.bid_protection_time };
delete config.bid_protection_time;
const amount = String(config.min_user_allocation);
const hex = (value) => Buffer.from(value).toString("hex");
const roundKey = Buffer.alloc(15);
roundKey.writeUInt16BE(5); roundKey.write("round", 2); roundKey.writeBigUInt64BE(BigInt(round.id), 7);
const fixture = new Map([
  [hex("config"), JSON.stringify(config)], [hex("last_round_cache_index"), String(round.id)],
  [roundKey.toString("hex"), JSON.stringify(round)],
]);
const state = new Map();
let ex;
function read(ptr) {
  const view = new DataView(ex.memory.buffer);
  return Buffer.from(new Uint8Array(ex.memory.buffer, view.getUint32(ptr, true), view.getUint32(ptr + 8, true)));
}
function write(value) {
  const bytes = Buffer.from(value), ptr = ex.allocate(bytes.length), view = new DataView(ex.memory.buffer);
  new Uint8Array(ex.memory.buffer, view.getUint32(ptr, true), bytes.length).set(bytes);
  view.setUint32(ptr + 8, bytes.length, true);
  return ptr;
}
const module = await WebAssembly.compile(wasm);
const imports = Object.fromEntries(WebAssembly.Module.imports(module).map(({ name }) => [name, () => { throw new Error("Unimplemented host call: " + name); }]));
Object.assign(imports, {
  abort: (ptr) => { throw new Error(read(ptr).toString()); }, addr_validate: () => 0,
  db_read: (ptr) => {
    const key = read(ptr), name = key.toString();
    let value = state.get(key.toString("hex"));
    if (value === undefined && name.includes("whitelisted_addresses") && name.endsWith(owner)) value = "true";
    if (value === undefined && !["blacklisted_addresses", "user_round_info", "round__id"].some((p) => name.includes(p))) throw new Error("Unknown fixture read: " + key.toString("hex"));
    return value === undefined ? 0 : write(value);
  },
  db_write: (key, value) => state.set(read(key).toString("hex"), read(value).toString()),
  db_remove: (key) => state.delete(read(key).toString("hex")),
});
ex = (await WebAssembly.instantiate(module, { env: imports })).exports;
function execute(offset, id) {
  state.clear(); for (const [key, value] of fixture) state.set(key, value);
  const env = { block: { height: Number(snapshot.header.height), time: String((BigInt(round.start_date) + BigInt(offset)) * 1000000000n), chain_id: MAINNET.chainId }, transaction: { index: 0 }, contract: { address: CONTRACT } };
  const info = { sender: owner, funds: [{ denom: "inj", amount }] };
  const ptr = ex.execute(write(JSON.stringify(env)), write(JSON.stringify(info)), write(JSON.stringify({ join_pool: { tx_id: id } })));
  return JSON.parse(read(ptr).toString());
}
const id = joinTxId(joinKey, owner, amount);
assert.match(execute(-1, id).error, /Round has not started yet/);
assert.ok(execute(0, id).ok);
assert.ok(execute(1, id).ok);
assert.match(execute(1, Buffer.alloc(64).toString("base64")).error, /error: id/);
assert.match(execute(1, joinTxId(joinKey, owner, (BigInt(amount) + 1n).toString())).error, /error: id/);
console.log(`Code ${snapshot.codeId}, round ${round.id}: rejects early; accepts at start_date; rejects invalid or wrong-amount IDs. Local WASM execution only; no broadcast.`);
