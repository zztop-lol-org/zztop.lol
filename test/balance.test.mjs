// The community gate counts ZZ held plus ZZ staked. Checks the staked read against the
// live contract and that malformed RPC answers throw (the gate fails closed on a throw).
import assert from "node:assert/strict";
import { zzStakedRaw, meetsThreshold, ZZ_STAKING, INJ_EVM_RPC } from "../src/community/balance.mjs";

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

// 4) live: the deployed contract answers (0 for an address that never staked)
if (!process.env.OFFLINE) {
  const v = await zzStakedRaw(INJ_EVM_RPC, ZZ_STAKING, "0x" + "22".repeat(20));
  assert.equal(v, 0n);
  ok("live contract answers principalOf");
}

console.log(`balance: ${pass} passed`);
