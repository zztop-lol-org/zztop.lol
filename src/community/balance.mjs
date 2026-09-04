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

// raw >= N * 10^decimals
export function meetsThreshold(raw, n, decimals) {
  return raw >= BigInt(n) * 10n ** BigInt(decimals);
}
