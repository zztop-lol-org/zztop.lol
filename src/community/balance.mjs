// ZZ (tokenfactory bank denom) balance gate via Injective LCD.
// by_denom avoids pagination; all math is BigInt; callers treat any throw as
// "fail closed" (reject the submit) — never fail open on an RPC hiccup.
//
// Several LCDs, tried in order with a timeout each: one going down (it happened —
// lcd.injective.network answered 502 after ~6.5 s for every request) must not
// turn every submission into "balance check unavailable".

export const LCD_FALLBACKS = [
  "https://sentry.lcd.injective.network",
  "https://injective-rest.publicnode.com",
  "https://injective-api.polkachu.com",
];
const LCD_TIMEOUT_MS = 4000;

async function withTimeout(fetchImpl, url, init, ms) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try { return await fetchImpl(url, { ...init, signal: ctl.signal }); }
  finally { clearTimeout(t); }
}

// lcdUrls: one URL or a list; the configured one first, then the fallbacks.
export async function zzBalanceRaw(lcdUrls, injAddr, denom, fetchImpl = fetch) {
  const list = [...new Set([].concat(lcdUrls || [], LCD_FALLBACKS).filter(Boolean).map((u) => u.replace(/\/+$/, "")))];
  let last = null;
  for (const base of list) {
    try {
      const url = `${base}/cosmos/bank/v1beta1/balances/${injAddr}/by_denom?denom=${encodeURIComponent(denom)}`;
      const res = await withTimeout(fetchImpl, url, { headers: { accept: "application/json" } }, LCD_TIMEOUT_MS);
      if (!res.ok) { last = new Error(`LCD ${base} ${res.status}`); continue; }
      const j = await res.json();
      const amt = j && j.balance && j.balance.amount;
      if (amt == null || !/^\d+$/.test(String(amt))) { last = new Error(`bad LCD balance payload from ${base}`); continue; }
      return BigInt(amt);
    } catch (e) { last = e; }
  }
  throw last || new Error("no LCD answered");
}

// ZZ locked in ZZStaking on Injective EVM: the stake sits in the contract, so it is no
// longer in the wallet's bank balance, but it is still the holder's. principalOf is the
// amount staked (not the boosted weight). Throws on any RPC problem, like the above.
export const ZZ_STAKING = "0xfba18A6f1234c014DDc6DA32163843B70D1dBF30";
export const INJ_EVM_RPC = "https://sentry.evm-rpc.injective.network/";
const PRINCIPAL_OF = "0x61e20a1c"; // principalOf(address)

export async function zzStakedRaw(rpcUrl, contract, ethAddr, fetchImpl = fetch) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(ethAddr)) throw new Error("bad eth address");
  const data = PRINCIPAL_OF + ethAddr.slice(2).toLowerCase().padStart(64, "0");
  const res = await withTimeout(fetchImpl, rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: contract, data }, "latest"] }),
  }, LCD_TIMEOUT_MS);
  if (!res.ok) throw new Error("EVM RPC " + res.status);
  const j = await res.json();
  const r = j && j.result;
  if (typeof r !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(r)) throw new Error("bad eth_call payload");
  return BigInt(r);
}

// raw >= N * 10^decimals
export function meetsThreshold(raw, n, decimals) {
  return raw >= BigInt(n) * 10n ** BigInt(decimals);
}
