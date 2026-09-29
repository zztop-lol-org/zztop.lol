// GET /api/bridge-fee
// What relaying one Peggy withdrawal to Ethereum actually costs right now, and that
// cost expressed in each token a withdrawal can pay its fee in.
//
// The official bridge charges a flat ~$5. Across the 1,506 batches relayed between
// March and September 2026 the relayer's real gas bill had a median of $0.26, and
// withdrawals paying 1.00-1.07x that bill were picked up as fast as the $5 ones (a
// median of about a minute). So the fee is computed rather than fixed:
//
//   cost in ETH = GAS_UNITS x (base fee x BASE_BUFFER + tip)
//   token fee   = cost in ETH x ETH price / token price
//
// The ETH amount is the fact. Every token figure is a conversion of it at prices
// fetched on the same call, so a page load always converts at a fresh rate.
const GAS_UNITS = 475000;          // p90 gas of those 1,506 batches (median 411k)
const BASE_BUFFER = 1.25;          // the base fee can rise 12.5% a block before a relayer lands
const MIN_TIP_WEI = 10000000n;     // 0.01 gwei floor, in case every recent block tipped nothing
const CACHE_SECONDS = 20;
const OFFICIAL_USD = 5;            // what the official bridge charges, for comparison

const ETH_RPCS = ["https://ethereum-rpc.publicnode.com", "https://eth.drpc.org"];

// Peggy requires the fee in the same denom as the amount, so every token a user can
// withdraw needs its own figure.
const TOKENS = {
  inj:  { denom: "inj", decimals: 18, symbol: "INJ", cb: "INJ", cg: "injective-protocol" },
  eth:  { denom: "peggy0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", decimals: 18, symbol: "ETH", cb: "ETH", cg: "ethereum" },
  usdt: { denom: "peggy0xdAC17F958D2ee523a2206206994597C13D831ec7", decimals: 6, symbol: "USDT", cb: "USDT", cg: "tether" },
  usdc: { denom: "peggy0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6, symbol: "USDC", cb: "USDC", cg: "usd-coin" },
};

const json = (o, s = 200, maxAge = 0) =>
  new Response(JSON.stringify(o), {
    status: s,
    headers: { "content-type": "application/json", "cache-control": `public, max-age=${maxAge}` },
  });

async function ethRpc(method, params) {
  let lastErr;
  for (const url of ETH_RPCS) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      const j = await r.json();
      if (j && j.result !== undefined) return j.result;
      lastErr = new Error(j?.error?.message || `HTTP ${r.status}`);
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error("no ethereum rpc answered");
}

// The next block's base fee, and the median of what the last 20 blocks tipped at
// their 50th percentile — what a relayer submitting now would plausibly pay.
async function gasNow() {
  const h = await ethRpc("eth_feeHistory", ["0x14", "latest", [50]]);
  const base = BigInt(h.baseFeePerGas[h.baseFeePerGas.length - 1]);
  const tips = (h.reward || []).map((r) => BigInt(r[0])).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  let tip = tips.length ? tips[Math.floor(tips.length / 2)] : MIN_TIP_WEI;
  if (tip < MIN_TIP_WEI) tip = MIN_TIP_WEI;
  const price = (base * BigInt(Math.round(BASE_BUFFER * 100))) / 100n + tip;
  return { base, tip, price };
}

// USD prices. Coinbase first: one call, fresh, no key. CoinGecko as the fallback.
// (Injective's on-chain Pyth feed was checked and rejected: its prices were three
// weeks stale, because the feed only moves when someone pushes an update.)
async function pricesNow() {
  try {
    const r = await fetch("https://api.coinbase.com/v2/exchange-rates?currency=USD");
    const rates = (await r.json())?.data?.rates || {};
    const out = {};
    for (const [k, t] of Object.entries(TOKENS)) {
      const rate = Number(rates[t.cb]);
      if (!(rate > 0)) throw new Error("coinbase missing " + t.cb);
      out[k] = 1 / rate;
    }
    return { usd: out, source: "coinbase" };
  } catch (e) {
    const ids = Object.values(TOKENS).map((t) => t.cg).join(",");
    const r = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`);
    const j = await r.json();
    const out = {};
    for (const [k, t] of Object.entries(TOKENS)) {
      const p = Number(j?.[t.cg]?.usd);
      if (!(p > 0)) throw new Error("no price for " + t.symbol);
      out[k] = p;
    }
    return { usd: out, source: "coingecko" };
  }
}

// Scale a float price to an 8-decimal integer so the conversion stays in BigInt.
const scaled = (p) => BigInt(Math.round(p * 1e8));
const ceilDiv = (a, b) => (a + b - 1n) / b;

function format(raw, decimals, shown = 6) {
  const s = raw.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, -decimals) || "0";
  const frac = s.slice(-decimals).slice(0, shown).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

export async function onRequestGet({ request, waitUntil }) {
  const cache = caches.default;
  const key = new Request(new URL("/__bridge-fee?v=1", request.url).toString());
  const hit = await cache.match(key);
  if (hit) return hit;

  let gas, px;
  try { [gas, px] = await Promise.all([gasNow(), pricesNow()]); }
  catch (e) { return json({ error: "fee unavailable: " + (e.message || "upstream failed") }, 503); }

  const feeWei = BigInt(GAS_UNITS) * gas.price;
  const eth8 = scaled(px.usd.eth);
  const fees = {};
  for (const [k, t] of Object.entries(TOKENS)) {
    // ETH is paid in WETH, the same asset the relayer spends, so it needs no conversion.
    // Everything else: wei x ETH price / token price, rescaled to the token's decimals.
    const raw = k === "eth"
      ? feeWei
      : ceilDiv(feeWei * eth8 * 10n ** BigInt(t.decimals), scaled(px.usd[k]) * 10n ** 18n);
    fees[k] = { denom: t.denom, symbol: t.symbol, decimals: t.decimals, raw: raw.toString(), amount: format(raw, t.decimals) };
  }

  const gwei = (w) => Number(w) / 1e9;
  const feeEth = Number(feeWei) / 1e18;
  const body = {
    gas_units: GAS_UNITS,
    base_fee_gwei: +gwei(gas.base).toFixed(4),
    tip_gwei: +gwei(gas.tip).toFixed(4),
    gas_price_gwei: +gwei(gas.price).toFixed(4),
    fee_wei: feeWei.toString(),
    fee_eth: format(feeWei, 18, 8),
    fee_usd: +(feeEth * px.usd.eth).toFixed(4),
    official_usd: OFFICIAL_USD,
    usd: Object.fromEntries(Object.entries(px.usd).map(([k, v]) => [k, +v.toFixed(6)])),
    price_source: px.source,
    fees,
    updated: Math.floor(Date.now() / 1000),
  };
  const res = json(body, 200, CACHE_SECONDS);
  waitUntil(cache.put(key, res.clone()));
  return res;
}
