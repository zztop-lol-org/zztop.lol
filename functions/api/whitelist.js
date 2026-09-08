// GET /api/whitelist?addr=inj1...
// Is this wallet on the auction contract's eligibility list?
//
// join_pool rejects "Address not whitelisted", and the grant does NOT bypass that —
// so a wallet that is not on the list can sign a perfect authorization and still
// deposit nothing. Checking before someone pays gas is the whole point.
//
// The list is ~14k addresses over 29 pages (~7s to walk), far too slow to do in the
// browser on connect, so it is walked here once and cached at the edge. It is also
// per-round and the admins churn it — round 11 and 12 differ by ~700 entries — so the
// answer is "on the latest round's list", not a guarantee about the next one.
const LCDS = [
  "https://sentry.lcd.injective.network",
  "https://injective-rest.publicnode.com",
  "https://injective-api.polkachu.com",
];
const CONTRACT = "inj10n78w79xhxmytnuhjcck633nj4e7hrqaglgnfz";
const ROUND_OFFSET = 221;          // contract round_id = auction chain round - 221
const CACHE_TTL = 600;             // seconds
const CACHE_VERSION = "1";

const json = (o, s = 200) =>
  new Response(JSON.stringify(o), {
    status: s,
    headers: { "content-type": "application/json", "cache-control": "public, max-age=60" },
  });

async function lcdGet(path) {
  for (const ep of LCDS) {
    try {
      const r = await fetch(ep + path);
      const j = await r.json().catch(() => null);
      if (r.ok && j) return j;
      if (j && typeof j.message === "string") return null;  // the node answered; it just said no
    } catch (e) { /* try the next mirror */ }
  }
  return null;
}
const smart = (obj) =>
  lcdGet(`/cosmwasm/wasm/v1/contract/${CONTRACT}/smart/${encodeURIComponent(btoa(JSON.stringify(obj)))}`);

async function latestRoundId() {
  const st = await lcdGet("/injective/auction/v1beta1/module_state");
  const chainRound = Number(st?.state?.auction_round || 0);
  if (!chainRound) return null;
  const guess = chainRound - ROUND_OFFSET;
  // the round for the live auction may not be created yet; fall back to the last one
  for (const id of [guess, guess - 1]) {
    const r = await smart({ get_round_info: { round_id: id } });
    if (r?.data) return id;
  }
  return null;
}

async function fetchList(roundId) {
  const out = [];
  let after;
  for (let page = 0; page < 60; page++) {          // 29 pages today, bounded for safety
    const arg = { round_id: roundId, limit: 500 };
    if (after) arg.start_after = after;
    const r = await smart({ get_unused_whitelisted_addresses: arg });
    const got = r?.data;
    if (!Array.isArray(got) || !got.length) break;
    out.push(...got);
    after = got[got.length - 1];
    if (got.length < 500) break;
  }
  return out;
}

export async function onRequestGet({ request, waitUntil }) {
  const addr = new URL(request.url).searchParams.get("addr") || "";
  if (!/^inj1[a-z0-9]{38}$/.test(addr)) return json({ error: "bad address" }, 400);

  const cache = caches.default;
  const key = new Request(`https://zztop.lol/__whitelist?v=${CACHE_VERSION}`);
  let listed = null, roundId = null, size = 0;

  const hit = await cache.match(key);
  let payload = hit ? await hit.json().catch(() => null) : null;

  if (!payload) {
    roundId = await latestRoundId();
    if (roundId === null) return json({ error: "chain unavailable" }, 503);
    const list = await fetchList(roundId);
    if (!list.length) return json({ error: "chain unavailable" }, 503);
    payload = { roundId, list };
    waitUntil(cache.put(key, new Response(JSON.stringify(payload), {
      headers: { "content-type": "application/json", "cache-control": `max-age=${CACHE_TTL}` },
    })));
  }

  roundId = payload.roundId;
  size = payload.list.length;
  listed = payload.list.includes(addr);
  return json({ addr, listed, round_id: roundId, list_size: size });
}
