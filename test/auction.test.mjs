import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { Wallet, TypedDataEncoder, keccak256, concat } from "ethers";
import { CosmosTxV1Beta1TxPb as Pb, getInjectiveAddress } from "@injectivelabs/sdk-ts";
import { injToWei, joinTxId, extractJoinKey, joinMsg, selfSendMsg, presign, simulationBytes,
  simulateSigned, watchRoundOpen, broadcastEverywhere, waitForTx, fromBase64, fetchAccount, sleep } from "../src/auction/presign.mjs";
import { validateHeader, assertTarget, MAINNET } from "../src/auction/buyback.mjs";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const wallet = Wallet.createRandom(), address = getInjectiveAddress(wallet.address);
const account = (sequence = "8") => ({ account: { base_account: { address, account_number: "7", sequence, pub_key: null } } });
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const decode = (bytes) => Pb.TxRaw.fromBinary(fromBase64(bytes));
function signTyped(wallet, typed) {
  // Injective's explicit EIP712Domain uses a STRING salt, unlike ethers'
  // default domain schema. Hash the supplied schema without substituting it.
  const domain = TypedDataEncoder.hashStruct("EIP712Domain", { EIP712Domain: typed.types.EIP712Domain }, typed.domain);
  const types = { ...typed.types }; delete types.EIP712Domain;
  const msg = TypedDataEncoder.hashStruct(typed.primaryType, types, typed.message);
  return wallet.signingKey.sign(keccak256(concat(["0x1901", domain, msg]))).serialized;
}
const signatureBytes = () => {
  const raw = Pb.TxRaw.create({ signatures: [new Uint8Array(65).fill(42)] });
  return Buffer.from(Pb.TxRaw.toBinary(raw)).toString("base64");
};

test("amounts remain exact and malformed decimals cannot be silently truncated", () => {
  assert.equal(injToWei("75.000000000000000001"), "75000000000000000001");
  for (const value of ["-1", "1e3", ".5", "0.0000000000000000001", "NaN", "1.2.3"]) assert.throws(() => injToWei(value));
});

test("join_pool uses the reviewed HMAC format and exact funds", () => {
  const key = "04-auctionerr-v06-1322", amount = "75000000000000000000";
  const expected = createHmac("sha512", key).update("join_pool" + address.slice(0, 8) + amount + Buffer.from(key).toString("hex")).digest("base64");
  assert.equal(joinTxId(key, address, amount), expected);
  assert.notEqual(joinTxId(key, address, "1"), expected);
  const msg = joinMsg({ sender: address, contract: address, key, amountWei: amount }).toAmino();
  assert.equal(msg.value.funds, amount + "inj");
  assert.equal(JSON.parse(msg.value.msg).join_pool.tx_id, expected);
  assert.equal(extractJoinKey(Buffer.from("\0" + key + "join_pool\0")), key);
  assert.throws(() => extractJoinKey(Buffer.from("\0" + key + "join_pool\0" + "05-other-keyjoin_pool\0")));
});

test("presigning creates a verifiable EIP-712 v2 transaction, never broadcasts, and forces an empty memo", async () => {
  let typed, urls = [];
  globalThis.fetch = async (url) => { urls.push(url); return json(account()); };
  const signed = await presign({ ethereumAddress: wallet.address, injectiveAddress: address,
    msgs: selfSendMsg({ address, amountWei: "1" }), lcds: ["https://one"],
    chainId: "injective-888", evmChainId: 1439, memo: "must never appear", timeoutHeight: 123456,
    signTypedData: async (_, data) => {
      typed = JSON.parse(data);
      return signTyped(wallet, typed);
    } });
  assert.equal(urls.length, 1); assert.match(urls[0], /\/accounts\//);
  const raw = decode(signed.txBytes), body = Pb.TxBody.fromBinary(raw.bodyBytes), auth = Pb.AuthInfo.fromBinary(raw.authInfoBytes);
  assert.equal(body.memo, ""); assert.equal(JSON.parse(typed.message.context).memo, "");
  assert.equal(Number(body.timeoutHeight), 123456);
  assert.equal(auth.signerInfos[0].modeInfo.sum.single.mode, 128);
  assert.equal(Number(auth.signerInfos[0].sequence), 8);
  assert.equal(raw.signatures[0].length, 65);
  assert.ok(raw.signatures[0].some((n) => n !== 0));
  assert.deepEqual([...decode(simulationBytes(signed.txBytes)).signatures[0]], Array(65).fill(0));
  assert.deepEqual(decode(simulationBytes(signed.txBytes)).bodyBytes, raw.bodyBytes);
});

test("a cancelled wallet prompt cannot later arm a transaction", async () => {
  globalThis.fetch = async () => json(account());
  const controller = new AbortController();
  await assert.rejects(presign({ ethereumAddress: wallet.address, injectiveAddress: address,
    msgs: selfSendMsg({ address, amountWei: "1" }), lcds: ["https://one"], chainId: "injective-1", evmChainId: 1776,
    signal: controller.signal, signTypedData: async () => { controller.abort(); return "0x" + "00".repeat(65); } }), { name: "AbortError" });
});

test("a signature from a different wallet is rejected", async () => {
  globalThis.fetch = async () => json(account()); const other = Wallet.createRandom();
  await assert.rejects(presign({ ethereumAddress: wallet.address, injectiveAddress: address,
    msgs: selfSendMsg({ address, amountWei: "1" }), lcds: ["https://one"], chainId: "injective-1", evmChainId: 1776,
    signTypedData: async (_, data) => signTyped(other, JSON.parse(data)) }), /another wallet/);
});

test("account lookup takes the highest sequence, including valid replies after malformed ones", async () => {
  globalThis.fetch = async (url) => json(url.startsWith("https://bad") ? {} : account(url.startsWith("https://new") ? "10" : "9"));
  assert.equal((await fetchAccount(["https://old", "https://bad", "https://new"], address)).sequence, 10);
});

test("simulation masks signatures and a fast failure cannot hide a slower success", async () => {
  globalThis.fetch = async (url, init) => {
    assert.ok(decode(JSON.parse(init.body).tx_bytes).signatures[0].every((n) => n === 0));
    if (url.startsWith("https://old")) return json({ message: "message index: 0: Round has not started yet" }, 500);
    await sleep(10); return json({ gas_info: { gas_used: "250000" } });
  };
  assert.equal((await simulateSigned(["https://old", "https://new"], signatureBytes())).ok, true);
});

test("simulation and endpoint failures never become permission to send", async () => {
  const header = { height: "100", time: new Date().toISOString() };
  for (const reason of ["account sequence mismatch", "message index: 0: Address not whitelisted", "message index: 0: Invalid tx id", "message index: 0: round cap overflow"]) {
    globalThis.fetch = async () => json({ message: reason }, 500);
    await assert.rejects(watchRoundOpen({ startDate: Date.now() / 1000 - 1, endDate: Date.now() / 1000 + 30,
      lcds: ["https://one"], txBytes: signatureBytes(), checkState: async () => ({ header }) }), { terminal: true });
  }
  const ctrl = new AbortController(); let calls = 0;
  globalThis.fetch = async () => { calls++; return json({ message: "unavailable" }, 503); };
  const pending = watchRoundOpen({ startDate: Date.now() / 1000 - 1, endDate: Date.now() / 1000 + 30,
    lcds: ["https://one"], txBytes: signatureBytes(), signal: ctrl.signal, checkState: async () => ({ header }) });
  setTimeout(() => ctrl.abort(), 30);
  await assert.rejects(pending, { name: "AbortError" });
  await sleep(300); assert.equal(calls, 1);
});

test("watch waits for actual success, rejects underfunded gas, and checks pre-aborted signals", async () => {
  const options = { startDate: Date.now() / 1000 - 1, endDate: Date.now() / 1000 + 30,
    lcds: ["https://one"], txBytes: signatureBytes(), checkState: async () => ({ header: { time: new Date().toISOString() } }) };
  let calls = 0;
  globalThis.fetch = async () => ++calls === 1 ? json({ message: "message index: 0: Round has not started yet" }, 500) : json({ gas_info: { gas_used: "200000" } });
  assert.equal((await watchRoundOpen(options)).result.ok, true); assert.equal(calls, 2);
  globalThis.fetch = async () => json({ gas_info: { gas_used: "699999" } });
  await assert.rejects(watchRoundOpen(options), /gas limit/);
  const ctrl = new AbortController(); ctrl.abort();
  await assert.rejects(watchRoundOpen({ ...options, signal: ctrl.signal }), { name: "AbortError" });
});

test("freshness and target checks reject wrong chains, stale blocks, migration and rollover", () => {
  const h = { chain_id: MAINNET.chainId, height: "100", time: new Date().toISOString() };
  assert.equal(validateHeader({ block: { header: h } }, MAINNET.chainId), h);
  assert.throws(() => validateHeader({ block: { header: h } }, "injective-888"), /wrong network/);
  assert.throws(() => validateHeader({ block: { header: h } }, MAINNET.chainId, Date.now() + 60000), /stale/);
  const target = { codeId: "2095", chainRound: 236, header: h, config: { min_user_allocation: "1" }, round: { id: 15, chain_round: 236, wallet_cap: "75", round_cap: "100", total_deposit: "0", start_date: 1, end_date: Date.now() / 1000 + 60 } };
  assert.doesNotThrow(() => assertTarget(target, target, "50"));
  assert.throws(() => assertTarget({ ...target, codeId: "2096" }, target, "50"), /changed/);
  assert.throws(() => assertTarget({ ...target, chainRound: 237 }, target, "50"), /changed/);
  assert.throws(() => assertTarget({ ...target, round: { ...target.round, id: 16 } }, target, "50"), /changed/);
  assert.throws(() => assertTarget({ ...target, round: { ...target.round, total_deposit: "60" } }, target, "50"), /capacity/);
});

test("CheckTx acceptance is distinct from committed success, and hash mismatches are ignored", async () => {
  const bytes = signatureBytes();
  const { txHash } = await import("../src/auction/presign.mjs"); const hash = txHash(bytes);
  globalThis.fetch = async (url, init) => {
    if (init?.method === "POST") {
      assert.equal(JSON.parse(init.body).tx_bytes, bytes);
      return json({ tx_response: { txhash: hash, code: 0 } });
    }
    return json({ tx_response: { txhash: hash, code: 5, height: "100", raw_log: "contract rejected", gas_used: "200000" } });
  };
  assert.equal((await broadcastEverywhere({ lcds: ["https://one"], txBytes: bytes })).accepted, true);
  assert.equal((await waitForTx(["https://one"], hash)).code, 5);
  globalThis.fetch = async () => json({ tx_response: { txhash: "wrong", code: 0 } });
  assert.equal((await broadcastEverywhere({ lcds: ["https://one"], txBytes: bytes })).accepted, false);
});
