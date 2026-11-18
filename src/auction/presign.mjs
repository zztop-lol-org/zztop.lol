// Browser-owned signing. Valid signatures stay in memory until broadcast.
import {
  MsgExecuteContractCompat, MsgSend, PublicKey, getInjectiveAddress,
  getEip712TypedDataV2, createTransaction, createTxRawEIP712, createWeb3Extension,
  SIGN_EIP712_V2, recoverTypedSignaturePubKey, hexToBase64, hexToUint8Array,
  CosmosTxV1Beta1TxPb, uint8ArrayToBase64,
} from "@injectivelabs/sdk-ts";
import { hmac } from "@noble/hashes/hmac";
import { sha512, sha256 } from "@noble/hashes/sha2";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";

export const GAS_PRICE = 160000000n;
export const JOIN_GAS = 700000;
export const NOT_STARTED = /Round has not started yet/i;
export const fromBase64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const encodeTx = (raw) => uint8ArrayToBase64(CosmosTxV1Beta1TxPb.TxRaw.toBinary(raw));
export const txHash = (bytes) => bytesToHex(sha256(fromBase64(bytes))).toUpperCase();

export function injToWei(value) {
  if (!/^(0|[1-9]\d*)(\.\d{1,18})?$/.test(String(value))) throw new Error("Enter an INJ amount with at most 18 decimals.");
  const [whole, frac = ""] = String(value).split(".");
  return (BigInt(whole) * 10n ** 18n + BigInt(frac.padEnd(18, "0"))).toString();
}

export function joinTxId(key, sender, amountWei) {
  const k = utf8ToBytes(key);
  return uint8ArrayToBase64(hmac(sha512, k, utf8ToBytes("join_pool" + sender.slice(0, 8) + String(amountWei) + bytesToHex(k))));
}

// Only extract after verifying the reviewed WASM checksum.
export function extractJoinKey(code) {
  const lit = utf8ToBytes("join_pool"), found = [];
  outer: for (let i = 0; i + lit.length <= code.length; i++) {
    for (let j = 0; j < lit.length; j++) if (code[i + j] !== lit[j]) continue outer;
    let s = i;
    while (s > 0 && code[s - 1] >= 0x21 && code[s - 1] <= 0x7e) s--;
    const candidate = new TextDecoder().decode(code.subarray(s, i));
    if (/^\d\d-[\x21-\x7e]{8,}$/.test(candidate)) found.push(candidate);
  }
  const keys = [...new Set(found)];
  if (keys.length !== 1) throw new Error("The deployed contract's join key needs review.");
  return keys[0];
}

export function joinMsg({ sender, contract, key, amountWei }) {
  return MsgExecuteContractCompat.fromJSON({ sender, contractAddress: contract,
    msg: { join_pool: { tx_id: joinTxId(key, sender, amountWei) } },
    funds: [{ denom: "inj", amount: String(amountWei) }] });
}

export function selfSendMsg({ address, amountWei }) {
  return MsgSend.fromJSON({ srcInjectiveAddress: address, dstInjectiveAddress: address,
    amount: [{ denom: "inj", amount: String(amountWei) }] });
}

export function throwIfAborted(signal) {
  if (signal?.aborted) throw new DOMException("Stopped", "AbortError");
}

export async function getJSON(endpoint, path, { timeoutMs = 4000, signal, ...init } = {}) {
  throwIfAborted(signal);
  const ctrl = new AbortController(), abort = () => ctrl.abort();
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, timeoutMs);
  try {
    const response = await fetch(endpoint.replace(/\/+$/, "") + path, { cache: "no-store", ...init, signal: ctrl.signal });
    const json = await response.json();
    throwIfAborted(signal);
    if (!response.ok) throw Object.assign(new Error(json.message || `HTTP ${response.status}`), { response: json, status: response.status });
    return json;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

export async function anyLcd(lcds, path, options = {}) {
  try { return await Promise.any(lcds.map((ep) => getJSON(ep, path, options))); }
  catch (e) { throwIfAborted(options.signal); throw new Error("No endpoint answered: " + (e.errors?.[0]?.message || e.message)); }
}

export async function fetchAccount(lcds, address, signal) {
  const all = await Promise.allSettled(lcds.map(async (ep) => {
    const j = await getJSON(ep, "/cosmos/auth/v1beta1/accounts/" + address, { signal });
    const a = j.account?.base_account || j.account;
    if (a?.address !== address || !/^\d+$/.test(a.sequence) || !/^\d+$/.test(a.account_number)) throw new Error("Invalid account response");
    const sequence = Number(a.sequence), accountNumber = Number(a.account_number);
    if (!Number.isSafeInteger(sequence) || !Number.isSafeInteger(accountNumber)) throw new Error("Account counter is too large");
    return { sequence, accountNumber, pubKey: a.pub_key?.key || null };
  }));
  throwIfAborted(signal);
  const accounts = all.filter((r) => r.status === "fulfilled").map((r) => r.value);
  if (!accounts.length) throw new Error("Cannot read this account. It needs INJ on the selected network.");
  if (accounts.some((a) => a.accountNumber !== accounts[0].accountNumber)) throw new Error("Endpoints disagree about the account.");
  return accounts.reduce((best, a) => a.sequence > best.sequence ? a : best);
}

// Never disclose a valid signature to a public simulation service.
export function simulationBytes(txBytes) {
  const raw = CosmosTxV1Beta1TxPb.TxRaw.fromBinary(fromBase64(txBytes));
  raw.signatures = [new Uint8Array(65)];
  return encodeTx(raw);
}

export async function presign({ ethereumAddress, injectiveAddress, msgs, lcds, chainId,
  evmChainId, gas = JOIN_GAS, timeoutHeight = 0, signTypedData, signal }) {
  if (getInjectiveAddress(ethereumAddress) !== injectiveAddress) throw new Error("Wallet address mismatch");
  const account = await fetchAccount(lcds, injectiveAddress, signal);
  const fee = { amount: [{ denom: "inj", amount: (BigInt(gas) * GAS_PRICE).toString() }], gas: String(gas) };
  const list = Array.isArray(msgs) ? msgs : [msgs];
  const typed = getEip712TypedDataV2({ msgs: list,
    tx: { memo: "", accountNumber: String(account.accountNumber), sequence: String(account.sequence), timeoutHeight: String(timeoutHeight), chainId },
    fee, evmChainId });
  throwIfAborted(signal);
  let signature = await signTypedData(ethereumAddress, JSON.stringify(typed));
  throwIfAborted(signal);
  if (typeof signature === "object") signature = signature?.signature || signature?.result || signature?.sig;
  if (typeof signature !== "string") throw new Error("Unexpected wallet signature");
  if (!signature.startsWith("0x")) signature = "0x" + signature;
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) throw new Error("Malformed wallet signature");
  const pubHex = await recoverTypedSignaturePubKey(typed, signature);
  if (PublicKey.fromHex(pubHex).toAddress().toBech32() !== injectiveAddress) throw new Error("The signature came from another wallet.");
  throwIfAborted(signal);
  const { txRaw } = createTransaction({ message: list, memo: "", signMode: SIGN_EIP712_V2,
    fee, pubKey: hexToBase64(pubHex), sequence: account.sequence, accountNumber: account.accountNumber, timeoutHeight, chainId });
  const raw = createTxRawEIP712(txRaw, createWeb3Extension({ evmChainId }));
  raw.signatures = [hexToUint8Array(signature.slice(2))];
  const txBytes = encodeTx(raw);
  return { txBytes, txHash: txHash(txBytes), ...account, signedAt: Date.now(), gas };
}

export function contractReason(message) {
  return String(message || "").replace(/^.*?message index: \d+: /i, "")
    .replace(/: execute wasm contract failed[\s\S]*$/i, "").replace(/ With gas wanted[\s\S]*$/i, "").trim().slice(0, 300);
}

export async function simulateSigned(lcds, txBytes, { signal, timeoutMs = 3000 } = {}) {
  const body = JSON.stringify({ tx_bytes: simulationBytes(txBytes) }), failures = [];
  try {
    return await Promise.any(lcds.map(async (ep) => {
      try {
        const j = await getJSON(ep, "/cosmos/tx/v1beta1/simulate", { method: "POST", headers: { "content-type": "application/json" }, body, signal, timeoutMs });
        const gasUsed = Number(j.gas_info?.gas_used);
        if (!Number.isSafeInteger(gasUsed) || gasUsed <= 0) throw new Error("Invalid simulation result");
        return { ok: true, gasUsed, endpoint: ep };
      } catch (e) {
        if (e.response?.message && /message index|account sequence|insufficient funds|out of gas|signature verification/i.test(e.response.message)) {
          failures.push({ ok: false, reason: contractReason(e.response.message), endpoint: ep });
        }
        throw e;
      }
    }));
  } catch {
    throwIfAborted(signal);
    return failures.find((r) => NOT_STARTED.test(r.reason)) || failures[0] || { ok: false, unreachable: true, reason: "No endpoint could simulate the transaction." };
  }
}

export async function broadcastEverywhere({ lcds, txBytes, signal }) {
  throwIfAborted(signal);
  const hash = txHash(txBytes), errors = [];
  const body = JSON.stringify({ tx_bytes: txBytes, mode: "BROADCAST_MODE_SYNC" });
  try {
    return await Promise.any(lcds.map(async (ep) => {
      const j = await getJSON(ep, "/cosmos/tx/v1beta1/txs", { method: "POST", headers: { "content-type": "application/json" }, body, timeoutMs: 8000, signal });
      const tr = j.tx_response;
      if (tr?.txhash?.toUpperCase() !== hash) throw new Error("Mismatched transaction hash");
      if (Number(tr.code) !== 0) { errors.push(tr.raw_log || `CheckTx code ${tr.code}`); throw new Error(errors.at(-1)); }
      return { txHash: hash, accepted: true, endpoint: ep };
    }));
  } catch {
    // A timeout, duplicate, or sequence error can follow acceptance elsewhere.
    // Only an indexed DeliverTx result proves the outcome.
    return { txHash: hash, accepted: false, log: errors[0] || "Broadcast result unknown; checking the transaction hash." };
  }
}

export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    throwIfAborted(signal);
    const abort = () => { clearTimeout(timer); reject(new DOMException("Stopped", "AbortError")); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export async function waitForTx(lcds, hash, { timeoutMs = 45000, signal } = {}) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    throwIfAborted(signal);
    try {
      const tr = await Promise.any(lcds.map(async (ep) => {
        const j = await getJSON(ep, "/cosmos/tx/v1beta1/txs/" + hash, { timeoutMs: 3000, signal });
        const tr = j.tx_response;
        if (tr?.txhash?.toUpperCase() !== hash || !(Number(tr.height) > 0) || !Number.isInteger(Number(tr.code))) throw new Error("Not committed");
        return tr;
      }));
      return { code: Number(tr.code), height: Number(tr.height), log: tr.raw_log || "", gasUsed: Number(tr.gas_used) };
    } catch { throwIfAborted(signal); }
    await sleep(700, signal);
  }
  return null;
}

// Independent endpoint workers. A block timestamp merely starts simulation;
// ONLY successful execution unlocks sending. checkState validates the target.
export async function watchRoundOpen({ startDate, endDate, lcds, txBytes, gas = JOIN_GAS,
  checkState, onEvent = () => {}, signal }) {
  throwIfAborted(signal);
  if (!txBytes || !lcds.length || typeof checkState !== "function" || !(endDate > startDate)) throw new Error("Incomplete round watch");
  const ctrl = new AbortController(), abort = () => ctrl.abort();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    return await Promise.race(lcds.map(async (ep) => {
      while (true) {
        throwIfAborted(ctrl.signal);
        let left = startDate * 1000 - Date.now();
        try {
          const { header } = await checkState(ep, ctrl.signal);
          throwIfAborted(ctrl.signal);
          const chainSeconds = Math.floor(Date.parse(header.time) / 1000);
          if (chainSeconds >= endDate) throw Object.assign(new Error("The round has ended."), { terminal: true });
          left = (startDate - chainSeconds) * 1000;
          onEvent("header", { ...header, endpoint: ep });
          if (left <= 1000) {
            const r = await simulateSigned([ep], txBytes, { signal: ctrl.signal });
            onEvent("simulate", r);
            if (r.ok) {
              if (Math.ceil(r.gasUsed * 1.2) > gas) throw Object.assign(new Error("The signed gas limit is too low. Sign again after review."), { terminal: true });
              return { endpoint: ep, result: r };
            }
            if (!r.unreachable && !NOT_STARTED.test(r.reason)) throw Object.assign(new Error(r.reason), { terminal: true });
          }
        } catch (e) {
          throwIfAborted(ctrl.signal);
          if (e.terminal) throw e;
          onEvent("unreachable", { endpoint: ep, reason: e.message });
        }
        await sleep(left > 60000 ? 10000 : left > 5000 ? 1000 : 250, ctrl.signal);
      }
    }));
  } finally {
    ctrl.abort();
    signal?.removeEventListener("abort", abort);
  }
}
