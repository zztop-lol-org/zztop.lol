import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex } from "@noble/hashes/utils";
import { getJSON, anyLcd, fromBase64, extractJoinKey, throwIfAborted } from "./presign.mjs";

export const CONTRACT = "inj10n78w79xhxmytnuhjcck633nj4e7hrqaglgnfz";
export const LEGACY_BOT = "inj1zzzzzzzzzzd6alqdkdk8qtzzqksa59v0hr5xk6";
export const MAINNET = {
  chainId: "injective-1", evmChainId: 1776, name: "Injective",
  lcds: ["https://sentry.lcd.injective.network", "https://injective-rest.publicnode.com"],
  evmRpc: "https://sentry.evm-rpc.injective.network",
  explorer: "https://explorer.injective.network/transaction/",
};
export const TESTNET = {
  chainId: "injective-888", evmChainId: 1439, name: "Injective Testnet",
  lcds: ["https://sentry.lcd.testnet.injective.network", "https://testnet.sentry.lcd.injective.network"],
  evmRpc: "https://k8s.testnet.json-rpc.injective.network",
  explorer: "https://testnet.explorer.injective.network/transaction/",
};
export const REVIEWED_CODE_HASH = "eb4366718a3b3f196a223b4eb036ac603de2090d6e688cfd47511a1d8c373a83";
const base = "/cosmwasm/wasm/v1/contract/" + CONTRACT;
const latestPath = "/cosmos/base/tendermint/v1beta1/blocks/latest";
export const terminal = (message) => Object.assign(new Error(message), { terminal: true });

export function validateHeader(json, chainId, now = Date.now()) {
  const h = (json.block || json.sdk_block)?.header;
  const time = Date.parse(h?.time), height = Number(h?.height);
  if (h?.chain_id !== chainId) throw new Error("Endpoint is on the wrong network.");
  if (!Number.isSafeInteger(height) || height <= 0 || !Number.isFinite(time) || now - time > 20000 || time - now > 10000) {
    throw new Error("Endpoint block is stale, or the device clock is incorrect.");
  }
  return h;
}

export async function freshHeader(ep, chainId, signal) {
  return validateHeader(await getJSON(ep, latestPath, { signal, timeoutMs: 2500 }), chainId);
}

export async function healthyEndpoints(network, signal) {
  const results = await Promise.all(network.lcds.map(async (endpoint) => {
    const started = performance.now();
    try {
      const header = await freshHeader(endpoint, network.chainId, signal);
      return { endpoint, header, ms: Math.round(performance.now() - started), ok: true };
    } catch (e) { return { endpoint, ok: false, reason: e.message }; }
  }));
  throwIfAborted(signal);
  const max = Math.max(0, ...results.filter((r) => r.ok).map((r) => Number(r.header.height)));
  for (const r of results) if (r.ok && max - Number(r.header.height) > 20) Object.assign(r, { ok: false, reason: "Behind the other endpoints" });
  return results.sort((a, b) => (a.ok ? a.ms : Infinity) - (b.ok ? b.ms : Infinity));
}

export async function smart(ep, query, signal) {
  return (await getJSON(ep, base + "/smart/" + encodeURIComponent(btoa(JSON.stringify(query))), { signal })).data;
}

// v0.0.6 uses Map<(u64, Addr), UserRoundInfo>. Its smart query deliberately
// throws for a missing participant, surfaced by LCDs as HTTP 500. Reading the
// same public storage key returns HTTP 200 with data:null for that normal case.
export async function readUserRound(ep, roundId, address, signal) {
  if (!Number.isSafeInteger(roundId) || roundId < 1 || !/^inj1[0-9a-z]{38}$/.test(address)) throw new Error("Invalid participation lookup");
  const encode = new TextEncoder();
  const prefix = new Uint8Array([0, 15, ...encode.encode("user_round_info"), 0, 8]);
  const key = new Uint8Array(prefix.length + 8 + address.length);
  key.set(prefix);
  new DataView(key.buffer).setBigUint64(prefix.length, BigInt(roundId));
  key.set(encode.encode(address), prefix.length + 8);
  const path = base + "/raw/" + encodeURIComponent(btoa(String.fromCharCode(...key)));
  const j = await getJSON(ep, path, { signal });
  if (j.data === null || j.data === "") return null;
  if (typeof j.data !== "string") throw new Error("Invalid participation response");
  const user = JSON.parse(new TextDecoder().decode(fromBase64(j.data)));
  if (user.wallet !== address || Number(user.round_id) !== roundId || !/^\d+$/.test(user.deposit) || typeof user.has_withdrawn !== "boolean") {
    throw new Error("Unrecognized participation record");
  }
  return user;
}

export async function loadSnapshot(ep, signal) {
  const [header, contract, module, latest, config] = await Promise.all([
    freshHeader(ep, MAINNET.chainId, signal), getJSON(ep, base, { signal }),
    getJSON(ep, "/injective/auction/v1beta1/module_state", { signal }),
    getJSON(ep, base + "/raw/" + btoa("last_round_cache_index"), { signal }),
    smart(ep, { config: {} }, signal),
  ]);
  const id = Number(latest.data ? new TextDecoder().decode(fromBase64(latest.data)) : 0);
  if (!Number.isSafeInteger(id) || id < 1) throw new Error("Cannot read the latest contract round.");
  const round = await smart(ep, { get_round_info: { round_id: id } }, signal);
  const chainRound = Number(module.state?.auction_round), codeId = contract.contract_info?.code_id;
  if (Number(round?.id) !== id || !Number.isSafeInteger(chainRound) || !codeId || config?.deposit_denom !== "inj" || config.version !== "0.0.6") {
    throw new Error("Unrecognized buyback state; contract review required.");
  }
  for (const key of ["wallet_cap", "round_cap", "total_deposit"]) if (!/^\d+$/.test(round[key])) throw new Error("Invalid round amount");
  if (!/^\d+$/.test(config.min_user_allocation) || !(Number(round.end_date) > Number(round.start_date))) throw new Error("Invalid round limits");
  return { header, codeId, chainRound, round, config, endpoint: ep };
}

export async function loadDeployment(lcds, codeId, signal) {
  const j = await anyLcd(lcds, "/cosmwasm/wasm/v1/code/" + encodeURIComponent(codeId), { signal, timeoutMs: 10000 });
  const bytes = fromBase64(j.data), hash = bytesToHex(sha256(bytes));
  if (hash !== REVIEWED_CODE_HASH || j.code_info?.data_hash?.toLowerCase() !== hash) throw terminal("Contract code changed. Joining is disabled until its mechanics are reviewed.");
  return { codeId, hash, key: extractJoinKey(bytes) };
}

export function assertTarget(snapshot, target, amountWei) {
  if (snapshot.codeId !== target.codeId || snapshot.chainRound !== target.chainRound ||
      Number(snapshot.round.id) !== Number(target.round.id) || Number(snapshot.round.chain_round) !== snapshot.chainRound ||
      ["start_date", "end_date", "wallet_cap"].some((k) => String(snapshot.round[k]) !== String(target.round[k]))) {
    throw terminal("The round or contract changed. Review the new round and sign again.");
  }
  if (Math.floor(Date.parse(snapshot.header.time) / 1000) >= Number(snapshot.round.end_date)) throw terminal("This round has ended.");
  const amount = BigInt(amountWei);
  if (amount < BigInt(snapshot.config.min_user_allocation) || amount > BigInt(snapshot.round.wallet_cap)) throw terminal("The deposit is outside this round's per-wallet limits.");
  if (amount > BigInt(snapshot.round.round_cap) - BigInt(snapshot.round.total_deposit)) throw terminal("This round has insufficient remaining capacity for your deposit.");
}

export function weiToInj(wei) {
  const amount = BigInt(wei), frac = (amount % 10n ** 18n).toString().padStart(18, "0").replace(/0+$/, "");
  return (amount / 10n ** 18n).toString() + (frac ? "." + frac : "");
}
