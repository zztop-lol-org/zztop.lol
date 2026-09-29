// ZZ (tokenfactory bank denom) balance gate via Injective LCD.
// by_denom avoids pagination; all math is BigInt; callers treat any throw as
// "fail closed" (reject the submit) — never fail open on an RPC hiccup.

export async function zzBalanceRaw(lcdUrl, injAddr, denom, fetchImpl = fetch) {
  const base = lcdUrl.replace(/\/+$/, "");
  const url = `${base}/cosmos/bank/v1beta1/balances/${injAddr}/by_denom?denom=${encodeURIComponent(denom)}`;
  const res = await fetchImpl(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error("LCD " + res.status);
  const j = await res.json();
  const amt = j && j.balance && j.balance.amount;
  if (amt == null || !/^\d+$/.test(String(amt))) throw new Error("bad LCD balance payload");
  return BigInt(amt);
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
  const res = await fetchImpl(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: contract, data }, "latest"] }),
  });
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
