import { getInjectiveAddress, MsgExecuteContractCompat } from "@injectivelabs/sdk-ts";
import { buildRevokeParts } from "./lib-entry.mjs";
import { MAINNET, TESTNET, CONTRACT, LEGACY_BOT, healthyEndpoints, loadSnapshot,
  loadDeployment, freshHeader, assertTarget, smart, readUserRound, terminal, weiToInj } from "./buyback.mjs";
import { GAS_PRICE, JOIN_GAS, injToWei, joinMsg, selfSendMsg, presign, simulateSigned,
  broadcastEverywhere, waitForTx, watchRoundOpen, fetchAccount, throwIfAborted, sleep, getJSON } from "./presign.mjs";

const $ = (id) => document.getElementById(id);
const say = (text, kind = "", scope = operation?.kind) => {
  $("msg").textContent = text; $("msg").className = "msg " + kind;
  if (scope === "probe") {
    $("probeStatus").textContent = text; $("probeStatus").className = "msg " + kind;
    $("probeStatus").scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
};
const stamp = (seconds) => new Date(Number(seconds) * 1000).toISOString().replace("T", " ").replace(".000Z", " UTC");
let provider, account, address, snapshot, endpoints = [], review, operation, walletEpoch = 0, refreshing = false;
const discovered = new Map();

function render() {
  $("panel").classList.toggle("hidden", !address);
  $("connect").classList.toggle("hidden", !!address);
  $("disconnect").classList.toggle("hidden", !address);
  $("who").textContent = address || "";
  $("amount").disabled = !!operation;
  $("join").disabled = !!operation || !snapshot || !address;
  $("join").textContent = review ? "SIGN & WAIT FOR OPENING" : "REVIEW DEPOSIT";
  $("stop").classList.toggle("hidden", !operation || operation.sent);
  $("probe").disabled = !!operation || !address;
  $("probeSend").classList.toggle("hidden", operation?.kind !== "probe" || !operation.tx || operation.sent);
  $("revoke").disabled = !!operation || !address;
  $("revokeFee").disabled = !!operation || !address;
  for (const button of $("claims").querySelectorAll("button")) button.disabled = !!operation;
}

function stop(message = "Stopped. The signed transaction was discarded from this tab.") {
  const old = operation;
  old?.ctrl.abort();
  operation = null;
  review = null;
  $("details").classList.add("hidden");
  $("recheck").classList.add("hidden");
  $("probeRecheck").classList.add("hidden");
  if (old?.sent) message = "The transaction was already sent. Check its hash below; stopping cannot undo it.";
  say(message, "", old?.kind);
  render();
}

function begin(kind, network) {
  if (operation || !provider || !address) throw new Error("Finish the current action first.");
  const op = { kind, network, ctrl: new AbortController(), owner: address, eth: account, provider, sent: false };
  operation = op;
  $("receipt").textContent = "";
  $("recheck").classList.add("hidden");
  $("probeRecheck").classList.add("hidden");
  if (kind === "probe") {
    $("probeReceipt").replaceChildren(); $("probeReceipt").classList.add("hidden");
    say("Preparing the testnet probe…");
  }
  render();
  return op;
}

function live(op) {
  throwIfAborted(op.ctrl.signal);
  if (operation !== op || address !== op.owner || provider !== op.provider) throw new DOMException("Wallet changed", "AbortError");
}

async function checkWallet(op) {
  live(op);
  const [accounts, chain] = await Promise.all([
    op.provider.request({ method: "eth_accounts" }), op.provider.request({ method: "eth_chainId" }),
  ]);
  live(op);
  if (accounts?.[0]?.toLowerCase() !== op.eth.toLowerCase() || Number(chain) !== op.network.evmChainId) throw terminal("Wallet account or network changed. Sign again.");
}

async function ensureNetwork(op) {
  const hex = "0x" + op.network.evmChainId.toString(16);
  if (Number(await op.provider.request({ method: "eth_chainId" })) !== op.network.evmChainId) {
    try { await op.provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] }); }
    catch (e) {
      if (e.code !== 4902) throw e;
      await op.provider.request({ method: "wallet_addEthereumChain", params: [{ chainId: hex, chainName: op.network.name,
        nativeCurrency: { name: "Injective", symbol: "INJ", decimals: 18 }, rpcUrls: [op.network.evmRpc] }] });
      await op.provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
    }
  }
  await checkWallet(op);
}

async function healthy(network, signal) {
  const rows = await healthyEndpoints(network, signal);
  $("endpoints").textContent = rows.map((r) => `${new URL(r.endpoint).hostname}: ${r.ok ? r.ms + " ms · block " + r.header.height : r.reason}`).join("\n");
  const eps = rows.filter((r) => r.ok).map((r) => r.endpoint);
  if (!eps.length) throw new Error("No fresh public endpoint is available. Check your connection and device clock.");
  return eps;
}

async function refresh() {
  if (refreshing || operation) return;
  refreshing = true;
  try {
    endpoints = await healthy(MAINNET);
    const next = await Promise.any(endpoints.map((ep) => loadSnapshot(ep)));
    snapshot = next;
    const r = next.round, now = Date.parse(next.header.time) / 1000;
    const remaining = BigInt(r.round_cap) - BigInt(r.total_deposit);
    $("round").textContent = `round ${r.id} · ${Number(r.chain_round) !== next.chainRound ? "next round not created yet" : now < Number(r.start_date) ? "opens " + stamp(r.start_date) : now >= Number(r.end_date) ? "closed" : "deposit window open"} · ${weiToInj(remaining)} INJ remaining`;
    $("limits").textContent = `Deposit ${weiToInj(next.config.min_user_allocation)}–${weiToInj(r.wallet_cap)} INJ. Transaction fee: ${weiToInj(BigInt(JOIN_GAS) * GAS_PRICE)} INJ.`;
    $("timing").textContent = `Contract opening: ${stamp(r.start_date)}. InjHub's form opens 60 seconds later. This tab waits for the contract to accept your deposit.`;
    if (!$("amount").value) $("amount").value = weiToInj(next.config.min_user_allocation);
    if (review) {
      try { assertTarget(next, review.target, review.amount); }
      catch { review = null; $("details").classList.add("hidden"); }
    }
  } catch (e) {
    snapshot = null;
    $("round").textContent = "Could not read current buyback state. Retrying…";
  } finally { refreshing = false; render(); }
}

async function sign(op, msgs, gas = JOIN_GAS, timeoutHeight = 0) {
  await ensureNetwork(op);
  op.lcds = await healthy(op.network, op.ctrl.signal);
  live(op);
  say("Sign the transaction in your wallet. Nothing is sent yet.");
  op.tx = await presign({ ...op.network, ethereumAddress: op.eth, injectiveAddress: op.owner, msgs, lcds: op.lcds,
    gas, timeoutHeight, signal: op.ctrl.signal,
    signTypedData: (addr, json) => op.provider.request({ method: "eth_signTypedData_v4", params: [addr, json] }) });
  live(op);
}

async function sequenceCheck(op) {
  const a = await fetchAccount(op.lcds, op.owner, op.ctrl.signal);
  live(op);
  if (a.sequence !== op.tx.sequence || a.accountNumber !== op.tx.accountNumber) throw terminal("Your account sequence changed. The held signature is no longer usable; sign again.");
}

async function submit(op) {
  await checkWallet(op);
  live(op);
  op.sent = true; // Cancellation after this point cannot recall bytes sent to nodes.
  render();
  const hash = op.tx.txHash;
  const link = document.createElement("a");
  link.href = op.network.explorer + hash; link.target = "_blank"; link.rel = "noopener noreferrer";
  link.textContent = hash; $("receipt").replaceChildren(link);
  if (op.kind === "probe") {
    $("probeReceipt").replaceChildren("Transaction: ", link.cloneNode(true));
    $("probeReceipt").classList.remove("hidden");
  }
  say("Sending the signed transaction…");
  const sent = await broadcastEverywhere({ lcds: op.lcds, txBytes: op.tx.txBytes, signal: op.ctrl.signal });
  op.tx = null;
  live(op);
  say(sent.accepted ? "Accepted by a node; waiting for execution on chain…" : sent.log);
  const delivered = await waitForTx(op.lcds, hash, { signal: op.ctrl.signal });
  live(op);
  if (!delivered) {
    say("Confirmation is still pending. Check the linked transaction before signing again.", "err");
    $("recheck").classList.remove("hidden");
    $("probeRecheck").classList.toggle("hidden", op.kind !== "probe");
    op.pendingHash = hash;
    return false;
  }
  if (delivered.code !== 0) throw new Error(`Transaction failed on chain (code ${delivered.code}): ${delivered.log}`);
  say(op.kind === "join" ? "Your deposit joined the round." : op.kind === "probe" ? "Testnet probe confirmed: signed earlier, sent later, with an empty memo." : "Transaction confirmed.", "ok");
  return true;
}

function finish(op) {
  if (operation !== op) return;
  op.ctrl.abort(); operation = null; review = null;
  $("details").classList.add("hidden");
  render();
  refresh(); checkClaims();
}

function fail(op, e) {
  if (operation !== op) return;
  say(e.code === 4001 ? "Cancelled in your wallet." : e.message || "Transaction failed.", "err");
  finish(op);
}

$("join").addEventListener("click", async () => {
  const op = begin("join", MAINNET);
  try {
    if (!review) {
      say("Checking this round and preparing the deposit…");
      op.lcds = await healthy(MAINNET, op.ctrl.signal);
      const target = await Promise.any(op.lcds.map((ep) => loadSnapshot(ep, op.ctrl.signal)));
      const amount = injToWei($("amount").value.trim());
      assertTarget(target, target, amount);
      const deployment = await loadDeployment(op.lcds, target.codeId, op.ctrl.signal);
      live(op);
      const msg = joinMsg({ sender: op.owner, contract: CONTRACT, key: deployment.key, amountWei: amount });
      review = { owner: op.owner, target, amount, msg };
      $("raw").textContent = JSON.stringify({ network: MAINNET.chainId, round: target.round.id,
        message: msg.toAmino(), fee: { inj: weiToInj(BigInt(JOIN_GAS) * GAS_PRICE), gas: JOIN_GAS }, memo: "" }, null, 2);
      $("details").classList.remove("hidden");
      say("Review the exact deposit. The next click signs it and starts waiting in this tab.");
      op.ctrl.abort(); operation = null; render();
      return;
    }
    const target = review.target, amount = review.amount;
    if (review.owner !== op.owner || amount !== injToWei($("amount").value.trim())) throw new Error("Review the new amount first.");
    assertTarget(await loadSnapshot(target.endpoint, op.ctrl.signal), target, amount);
    await sign(op, review.msg);
    const caches = new Map();
    let accountChecked = 0;
    const checkState = async (ep, signal) => {
      live(op);
      let cached = caches.get(ep);
      const near = Date.now() >= Number(target.round.start_date) * 1000 - 10000;
      if (!cached || Date.now() - cached.at > (near ? 2000 : 10000)) {
        const state = await loadSnapshot(ep, signal);
        assertTarget(state, target, amount);
        cached = { state, at: Date.now() }; caches.set(ep, cached);
      }
      const header = await freshHeader(ep, MAINNET.chainId, signal);
      assertTarget({ ...cached.state, header }, target, amount);
      if (Date.now() - accountChecked > 15000) { accountChecked = Date.now(); await sequenceCheck(op); }
      return { header };
    };
    say("Signed and waiting. Keep this tab open and the device awake; avoid other transactions from this wallet.");
    const ready = await watchRoundOpen({ startDate: Number(target.round.start_date), endDate: Number(target.round.end_date),
      lcds: op.lcds, txBytes: op.tx.txBytes, gas: op.tx.gas, checkState, signal: op.ctrl.signal,
      onEvent(kind, data) {
        if (operation !== op) return;
        if (kind === "header") $("watchStatus").textContent = `Latest checked block ${data.height} · ${data.time}`;
        if (kind === "simulate") $("watchStatus").textContent = data.ok ? "Contract simulation succeeded." : data.reason;
        if (kind === "unreachable") $("watchStatus").textContent = "Endpoint unavailable; checking other public nodes…";
      } });
    // join_pool carries no round_id. Recheck the target immediately before send.
    await Promise.all([sequenceCheck(op), loadSnapshot(ready.endpoint, op.ctrl.signal).then((s) => assertTarget(s, target, amount))]);
    live(op);
    if (await submit(op)) finish(op);
  } catch (e) { fail(op, e); }
});

$("amount").addEventListener("input", () => { review = null; $("details").classList.add("hidden"); render(); });
$("stop").addEventListener("click", () => stop());
$("probe").addEventListener("click", async () => {
  const op = begin("probe", TESTNET);
  try {
    op.lcds = await healthy(TESTNET, op.ctrl.signal);
    const header = await freshHeader(op.lcds[0], TESTNET.chainId, op.ctrl.signal);
    await sign(op, selfSendMsg({ address: op.owner, amountWei: "1000000000000" }), 200000, Number(header.height) + 2000);
    $("probeReceipt").textContent = "Signed transaction (not sent yet): " + op.tx.txHash;
    $("probeReceipt").classList.remove("hidden");
    say("Testnet transaction signed and held. Wait at least 10 seconds, then send it with the button below. Keep this tab open.");
    $("probeSend").disabled = true; render();
    await sleep(10000, op.ctrl.signal); live(op);
    $("probeSend").disabled = false;
    say("Ready to send. The testnet transaction is signed and has not been broadcast yet.");
  } catch (e) { fail(op, e); }
});
$("probeSend").addEventListener("click", async () => {
  const op = operation;
  if (op?.kind !== "probe" || !op.tx || op.sent) return;
  $("probeSend").disabled = true;
  say("Checking the held testnet transaction before sending…");
  try {
    await sequenceCheck(op);
    await Promise.any(op.lcds.map((ep) => freshHeader(ep, TESTNET.chainId, op.ctrl.signal)));
    const result = await simulateSigned(op.lcds, op.tx.txBytes, { signal: op.ctrl.signal });
    if (!result.ok) throw new Error(result.reason);
    if (Math.ceil(result.gasUsed * 1.2) > op.tx.gas) throw new Error("The testnet probe needs more gas; review required.");
    if (await submit(op)) finish(op);
  } catch (e) { fail(op, e); }
});
async function recheckConfirmation() {
  const op = operation;
  if (!op?.pendingHash) return;
  $("recheck").disabled = true;
  $("probeRecheck").disabled = true;
  say("Checking transaction confirmation…");
  try {
    const result = await waitForTx(op.lcds, op.pendingHash, { signal: op.ctrl.signal });
    live(op);
    if (!result) { say("Still not indexed. Check the explorer and retry confirmation.", "err"); return; }
    say(result.code === 0 ? "Transaction confirmed on chain." : `Transaction failed: ${result.log}`, result.code === 0 ? "ok" : "err");
    $("recheck").classList.add("hidden"); $("probeRecheck").classList.add("hidden"); finish(op);
  } catch (e) { fail(op, e); }
  finally { $("recheck").disabled = false; $("probeRecheck").disabled = false; }
}
$("recheck").addEventListener("click", recheckConfirmation);
$("probeRecheck").addEventListener("click", recheckConfirmation);

async function checkClaims() {
  const owner = address, epoch = walletEpoch;
  $("claims").replaceChildren();
  $("claimStatus").classList.add("hidden");
  if (!owner || !snapshot || !endpoints.length || operation) return;
  const cards = await Promise.allSettled(Array.from({ length: Math.min(3, Number(snapshot.round.id)) }, async (_, i) => {
    const id = Number(snapshot.round.id) - i;
    const round = await Promise.any(endpoints.map((ep) => smart(ep, { get_round_info: { round_id: id } })));
    if (Date.parse(snapshot.header.time) / 1000 < Number(round.end_date) || !round.basket?.length) return null;
    const records = await Promise.allSettled(endpoints.map((ep) => readUserRound(ep, id, owner)));
    const user = records.find((r) => r.status === "fulfilled" && r.value)?.value;
    if (!user) {
      if (records.every((r) => r.status === "rejected")) throw new Error("Cannot check past participation");
      return null;
    }
    if (BigInt(user.deposit || 0) <= 0n || user.has_withdrawn) return null;
    return id;
  }));
  if (address !== owner || epoch !== walletEpoch || operation) return;
  if (cards.some((r) => r.status === "rejected")) {
    $("claimStatus").textContent = "Some previous-round claims could not be checked. Try reconnecting in a moment.";
    $("claimStatus").classList.remove("hidden");
  }
  for (const r of cards) if (r.status === "fulfilled" && r.value) {
    const button = document.createElement("button"); button.className = "authorize";
    button.textContent = `CLAIM ROUND #${r.value}`;
    button.addEventListener("click", () => runImmediate("claim", MsgExecuteContractCompat.fromJSON({ sender: owner, contractAddress: CONTRACT, msg: { claim: { round_id: r.value } } }), 2000000));
    $("claims").appendChild(button);
  }
}

async function runImmediate(kind, message, gas) {
  const op = begin(kind, MAINNET);
  try {
    op.lcds = await healthy(MAINNET, op.ctrl.signal);
    const h = await freshHeader(op.lcds[0], MAINNET.chainId, op.ctrl.signal);
    await sign(op, message, gas, Number(h.height) + 300);
    const simulation = await simulateSigned(op.lcds, op.tx.txBytes, { signal: op.ctrl.signal });
    if (!simulation.ok) throw new Error(simulation.reason);
    if (Math.ceil(simulation.gasUsed * 1.2) > gas) throw new Error("This transaction needs more gas; review required.");
    await sequenceCheck(op);
    if (await submit(op)) finish(op);
  } catch (e) { fail(op, e); }
}

// Legacy authorization is never created or topped up. Existing users can revoke.
$("revoke").addEventListener("click", async () => {
  if (operation || !address) return;
  const parts = buildRevokeParts({ granter: address, grantee: LEGACY_BOT });
  await runImmediate("revoke", parts.authz, 200000);
});
$("revokeFee").addEventListener("click", async () => {
  if (operation || !address) return;
  const parts = buildRevokeParts({ granter: address, grantee: LEGACY_BOT });
  await runImmediate("revoke", parts.feegrant, 200000);
});

function connected(next, selected) {
  stop("Wallet connected.");
  provider = selected; account = next; address = getInjectiveAddress(next); walletEpoch++;
  $("picker").classList.add("hidden"); render();
  checkClaims();
}
const bound = new WeakSet();
function bind(selected) {
  if (bound.has(selected) || !selected.on) return;
  bound.add(selected);
  selected.on("accountsChanged", (accounts) => {
    if (provider !== selected) return;
    if (accounts?.length) connected(accounts[0], selected);
    else disconnect();
  });
  selected.on("chainChanged", (chain) => {
    if (provider === selected && operation && Number(chain) !== operation.network.evmChainId) stop("Network changed. The held transaction was discarded.");
  });
}
function disconnect() {
  stop("Wallet disconnected."); provider = null; account = null; address = null; walletEpoch++;
  $("claims").replaceChildren(); render();
}
window.addEventListener("eip6963:announceProvider", (event) => {
  const d = event.detail;
  if (d?.provider && d?.info) discovered.set(d.info.rdns || d.info.uuid || d.info.name, d);
});
window.dispatchEvent(new Event("eip6963:requestProvider"));
$("connect").addEventListener("click", async () => {
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  await sleep(250);
  const list = [...discovered.values()];
  if (!list.length && window.ethereum) list.push({ provider: window.ethereum, info: { name: "Browser wallet" } });
  if (!list.length) { say("Open this page in an EVM wallet browser, or enable MetaMask, Rabby, or Keplr EVM.", "err"); return; }
  $("picker").replaceChildren(); $("picker").classList.remove("hidden");
  for (const entry of list) {
    const button = document.createElement("button"); button.textContent = entry.info.name || "Wallet";
    button.addEventListener("click", async () => {
      try {
        const accounts = await entry.provider.request({ method: "eth_requestAccounts" });
        if (!accounts?.length) throw new Error("No account selected");
        connected(accounts[0], entry.provider); bind(entry.provider);
      } catch (e) { say(e.message || "Connection cancelled", "err"); }
    });
    $("picker").appendChild(button);
  }
});
$("disconnect").addEventListener("click", disconnect);
window.addEventListener("beforeunload", (event) => {
  if (operation && !operation.sent) { event.preventDefault(); event.returnValue = ""; }
});
window.addEventListener("pagehide", () => { operation?.ctrl.abort(); operation = null; review = null; });
window.addEventListener("pageshow", (event) => {
  if (event.persisted) { stop("Waiting stopped when you left this page. Review and sign again to resume."); refresh(); }
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden && operation && !operation.sent) $("watchStatus").textContent = "Background tabs can be throttled. Keep this page visible and the device awake.";
});
refresh().then(checkClaims);
setInterval(() => refresh(), 30000);
render();
