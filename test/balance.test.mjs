// The community gate counts ZZ held plus ZZ staked. Checks the staked read against the
// live contract and that malformed RPC answers throw (the gate fails closed on a throw).
import assert from "node:assert/strict";
import { zzBalanceRaw, zzStakedRaw, meetsThreshold, ZZ_STAKING, INJ_EVM_RPC, LCD_FALLBACKS } from "../src/community/balance.mjs";

let pass = 0;
const ok = (n) => { console.log("  ok -", n); pass++; };
const fakeRpc = (body, status = 200) => async () => ({ ok: status === 200, status, json: async () => body });

// 1) decodes a uint256 result; encodes the address into the call
{
  let sent;
  const f = async (url, init) => { sent = JSON.parse(init.body); return { ok: true, status: 200, json: async () => ({ result: "0x" + (123n * 10n ** 18n).toString(16).padStart(64, "0") }) }; };
  const v = await zzStakedRaw("http://x", ZZ_STAKING, "0x00000000000000000000000000000000000000Ab", f);
  assert.equal(v, 123n * 10n ** 18n);
  assert.equal(sent.params[0].data, "0x61e20a1c" + "ab".padStart(64, "0"));
  assert.equal(sent.params[0].to, ZZ_STAKING);
  ok("principalOf result decoded, address encoded");
}

// 2) anything malformed throws, so the gate never counts a stake it could not read
{
  const A = "0x" + "11".repeat(20);
  for (const [name, f] of [
    ["http 502", fakeRpc({}, 502)],
    ["rpc error", fakeRpc({ error: { code: -32000, message: "x" } })],
    ["short result", fakeRpc({ result: "0x01" })],
    ["empty result (no contract)", fakeRpc({ result: "0x" })],
  ]) await assert.rejects(zzStakedRaw("http://x", ZZ_STAKING, A, f), undefined, name);
  await assert.rejects(zzStakedRaw("http://x", ZZ_STAKING, "inj1abc", fakeRpc({ result: "0x" + "0".repeat(64) })));
  ok("RPC errors, short or empty results and bad addresses all throw");
}

// 3) held + staked meets the threshold where either alone does not
{
  const d = 18;
  assert.equal(meetsThreshold(60n * 10n ** 18n, 100, d), false);
  assert.equal(meetsThreshold(60n * 10n ** 18n + 40n * 10n ** 18n, 100, d), true);
  ok("held + staked is what the threshold sees");
}

// 4) the wallet balance fails over: a dead LCD (502, timeout, junk) falls through
//    to the next, and only all of them failing is an error
{
  const answer = (amt) => ({ ok: true, status: 200, json: async () => ({ balance: { denom: "x", amount: amt } }) });
  const seen = [];
  const f = async (url, init) => {
    seen.push(url.split("/cosmos")[0]);
    if (url.startsWith("https://dead.example")) return { ok: false, status: 502, json: async () => ({}) };
    if (url.startsWith(LCD_FALLBACKS[0])) return { ok: true, status: 200, json: async () => ({ nope: 1 }) };
    if (url.startsWith(LCD_FALLBACKS[1])) await new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(new Error("aborted"))));
    return answer("7000000000000000000000000");
  };
  const t0 = Date.now();
  const v = await zzBalanceRaw("https://dead.example/", "inj1x", "d", f);
  assert.equal(v, 7_000_000n * 10n ** 18n);
  assert.deepEqual(seen.sort(), ["https://dead.example", ...LCD_FALLBACKS].sort(), "every LCD is asked");
  assert.ok(Date.now() - t0 < 1000, "the good answer wins without waiting for the dead or hanging ones");
  ok("asked in parallel: dead / junk / hanging LCDs do not delay the one that answers");
  await assert.rejects(zzBalanceRaw("https://dead.example", "inj1x", "d", async () => ({ ok: false, status: 503, json: async () => ({}) })));
  ok("every LCD failing is still an error (the gate stays closed)");
  const zero = await zzBalanceRaw(undefined, "inj1x", "d", async () => answer("0"));
  assert.equal(zero, 0n);
  ok("a real zero balance is an answer, not a failure; no configured LCD is fine");
}

// 5) live: the deployed contract answers (0 for an address that never staked)
if (!process.env.OFFLINE) {
  const v = await zzStakedRaw(INJ_EVM_RPC, ZZ_STAKING, "0x" + "22".repeat(20));
  assert.equal(v, 0n);
  ok("live contract answers principalOf");
}

// 6) live: the configured LCD may be down, the read still answers
if (!process.env.OFFLINE) {
  const v = await zzBalanceRaw("https://lcd.injective.network", "inj1k0wzj0ch9fws4pt2tqwkecp67h8ptklwdneu58",
    "factory/inj13j2rpnlwl30c02d4pzukykwfeyyhelvry9cqte/shroom_157_99c09d972f9c1f79");
  assert.equal(typeof v, "bigint");
  ok("live: a balance comes back even with lcd.injective.network as the configured LCD");
}

console.log(`balance: ${pass} passed`);
