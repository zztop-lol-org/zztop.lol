// Browser bundle for /auction.
//
// Composes the two grants a bidding bot needs and gets them signed by an EVM
// wallet. Injective accepts Cosmos messages from Ethereum wallets by converting
// the tx to EIP-712 typed data, which the wallet signs with eth_signTypedData_v4;
// the recovered pubkey then goes into a normal Cosmos tx carrying a Web3
// extension. Flow per Injective docs: prepare -> sign -> broadcast.
//
// Both grants share one expiration so the fee allowance can never outlive the
// authorization it exists to pay for.
import {
  MsgGrantWithAuthorization,
  MsgGrantAllowance,
  MsgRevokeAllowance,
  MsgRevoke,
  ContractExecutionAuthz,
  BaseAccount,
  ChainRestAuthApi,
  ChainRestTendermintApi,
  getEip712TypedDataV2,
  createTransaction,
  createTxRawEIP712,
  createWeb3Extension,
  TxRestApi,
  SIGN_EIP712_V2,
  recoverTypedSignaturePubKey,
  hexToBase64,
  hexToUint8Array,
  getInjectiveAddress,
  MsgExecuteContractCompat,
  CosmosTxV1Beta1TxPb,
  uint8ArrayToBase64,
} from "@injectivelabs/sdk-ts";
import { getDefaultStdFee, toBigNumber, DEFAULT_BLOCK_TIMEOUT_HEIGHT } from "@injectivelabs/utils";

export { getInjectiveAddress };

/** 0.1 INJ -> "100000000000000000" (18 decimals, no float drift) */
export function injToWei(amount) {
  const [whole, frac = ""] = String(amount).split(".");
  return (BigInt(whole || "0") * 10n ** 18n + BigInt((frac + "0".repeat(18)).slice(0, 18))).toString();
}

/**
 * Build the individual grant messages.
 *
 * They must be broadcast in SEPARATE transactions. Injective rebuilds the EIP-712
 * payload during signature verification using a single shared `MsgValue` type taken
 * from the first message, so a tx mixing MsgGrant with MsgGrantAllowance fails with
 *   provided data '<nil>' doesn't match type 'TypeGrant'
 * One message type per transaction, one signature each.
 */
export function buildGrantParts({ granter, grantee, contract, messageKey, maxFundsWei, feeWei, expirationUnix }) {
  const authorization = ContractExecutionAuthz.fromJSON({
    contract,
    filter: { acceptedMessagesKeys: [messageKey] },
    limit: { amounts: [{ denom: "inj", amount: maxFundsWei }] },
  });

  const authz = MsgGrantWithAuthorization.fromJSON({
    granter,
    grantee,
    authorization,
    expiration: expirationUnix,
  });

  const feegrant = MsgGrantAllowance.fromJSON({
    granter,
    grantee,
    allowance: {
      spendLimit: [{ denom: "inj", amount: feeWei }],
      expiration: expirationUnix,
    },
  });

  // x/feegrant has no upsert: GrantAllowance rejects a duplicate, so an existing allowance
  // must be revoked first. authz itself overwrites cleanly (SaveGrant keys on
  // granter/grantee/msgTypeURL), so it never needs a revoke.
  return { authz, feegrant, revoke: MsgRevokeAllowance.fromJSON({ granter, grantee }) };
}

/**
 * The two messages that undo a grant. Same rule as granting: different message
 * types, so they cannot share a transaction.
 *   - MsgRevoke removes the authz grant, keyed by the message type it authorized
 *   - MsgRevokeAllowance removes the fee allowance
 */
export function buildRevokeParts({ granter, grantee }) {
  return {
    authz: MsgRevoke.fromJSON({ granter, grantee, messageType: "/cosmwasm.wasm.v1.MsgExecuteContract" }),
    feegrant: MsgRevokeAllowance.fromJSON({ granter, grantee }),
  };
}

/**
 * Return the first endpoint that answers a cheap query, so one provider going
 * down doesn't take the page with it. Probed sequentially: the primary is
 * Injective's own sentry, the rest are community mirrors.
 */
export async function pickEndpoint(endpoints, timeoutMs = 4000) {
  let lastErr;
  for (const ep of endpoints) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      const r = await fetch(`${ep}/cosmos/base/tendermint/v1beta1/blocks/latest`, { signal: ctrl.signal });
      clearTimeout(t);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      if (j?.block?.header?.chain_id) return { endpoint: ep, height: j.block.header.height };
    } catch (e) { lastErr = e; }
  }
  throw new Error("no Injective endpoint reachable" + (lastErr ? `: ${lastErr.message}` : ""));
}

/** Accept whatever shape the wallet hands back and return 0x-prefixed hex. */
function normalizeSignature(sig) {
  if (typeof sig === "string") return sig.startsWith("0x") ? sig : `0x${sig}`;
  if (sig && typeof sig === "object") {
    for (const k of ["signature", "result", "sig"]) {
      if (typeof sig[k] === "string") return normalizeSignature(sig[k]);
    }
    if (sig instanceof Uint8Array || Array.isArray(sig))
      return "0x" + Array.from(sig).map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  throw new Error(`wallet returned an unexpected signature type: ${Object.prototype.toString.call(sig)}`);
}

/**
 * Sign and broadcast a list of transactions in order, one wallet signature each.
 * `groups` is [{ label, msgs }] where every msgs array holds ONE message type.
 * The account is refetched between transactions because the previous one advances
 * the sequence.
 */
export async function sendGrantTxs({
  ethereumAddress,
  injectiveAddress,
  groups,
  restEndpoint,
  chainId,
  evmChainId,
  memo = "zzauction grant",
  signTypedData,
  onStep,
}) {
  const results = [];
  for (let i = 0; i < groups.length; i++) {
    if (onStep) onStep(i, groups.length, groups[i].label);
    results.push(await sendOne({
      ethereumAddress, injectiveAddress, msgs: groups[i].msgs,
      restEndpoint, chainId, evmChainId, memo, signTypedData,
    }));
  }
  return results;
}

async function sendOne({
  ethereumAddress,
  injectiveAddress,
  msgs,
  restEndpoint,
  chainId,
  evmChainId,
  memo,
  signTypedData,
  fee = getDefaultStdFee(),
}) {
  const accountResponse = await new ChainRestAuthApi(restEndpoint).fetchAccount(injectiveAddress);
  const baseAccount = BaseAccount.fromRestApi(accountResponse);
  const latestBlock = await new ChainRestTendermintApi(restEndpoint).fetchLatestBlock();
  const timeoutHeight = toBigNumber(latestBlock.header.height).plus(DEFAULT_BLOCK_TIMEOUT_HEIGHT);

  const eip712TypedData = getEip712TypedDataV2({
    msgs,
    tx: {
      memo,
      accountNumber: baseAccount.accountNumber.toString(),
      sequence: baseAccount.sequence.toString(),
      timeoutHeight: timeoutHeight.toFixed(),
      chainId,
    },
    fee,
    evmChainId,
  });

  const raw = await signTypedData(ethereumAddress, JSON.stringify(eip712TypedData));

  // Wallets are not consistent here: most return a hex string, some wrap it.
  const signature = normalizeSignature(raw);
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature))
    throw new Error(`wallet returned a malformed signature (${(signature.length - 2) / 2} bytes)`);

  // NOTE: recoverTypedSignaturePubKey is async. Without the await this hands a
  // Promise to hexToBase64, which fails with "n.startsWith is not a function".
  const publicKeyHex = await recoverTypedSignaturePubKey(eip712TypedData, signature);
  if (typeof publicKeyHex !== "string")
    throw new Error("could not recover the public key from that signature");
  const publicKeyBase64 = hexToBase64(publicKeyHex);

  const { txRaw } = createTransaction({
    message: msgs,
    memo,
    // MUST match the typed data we signed. getEip712TypedDataV2 produces the V2 payload
    // (msgs as a JSON string); SIGN_AMINO/SIGN_EIP712 are both 127, which makes the chain
    // rebuild the LEGACY payload instead and the signature then fails to verify with
    // "unable to verify signer signature of EIP712 typed data". V2 is 128.
    signMode: SIGN_EIP712_V2,
    fee,
    pubKey: publicKeyBase64,
    sequence: baseAccount.sequence,
    timeoutHeight: timeoutHeight.toNumber(),
    accountNumber: baseAccount.accountNumber,
    chainId,
  });

  const txRawEip712 = createTxRawEIP712(txRaw, createWeb3Extension({ evmChainId }));
  txRawEip712.signatures = [hexToUint8Array(signature.replace(/^0x/, ""))];

  const txRestApi = new TxRestApi(restEndpoint);
  const txHash = await txRestApi.broadcast(txRawEip712);
  const response = await txRestApi.fetchTxPoll(txHash);
  return { txHash: response.txHash || txHash, code: response.code };
}

// ---- claiming a round's basket ------------------------------------------------

const GAS_PRICE = 160000000n;         // inj per gas: the chain's minimum, as getDefaultStdFee uses
const CLAIM_GAS_FALLBACK = 2000000;   // a 17-asset claim measured 1,144,601 on mainnet

// The contract's own words, without the chain's wrapping around them:
// "failed to execute message; message index: 0: User inj1… has not participated
// on round 12: execute wasm contract failed [path] With gas wanted …"
export function contractReason(m) {
  let s = String(m || "");
  s = s.replace(/^.*?message index: \d+: /i, "");
  const i = s.search(/: execute wasm contract failed/i);
  if (i >= 0) s = s.slice(0, i);
  return s.trim().slice(0, 200);
}

// Ask the chain what the claim would do before the wallet is asked to sign it: a
// claim that would fail (already claimed, not in that round) is refused here with
// the contract's reason, and one that works gets the gas it really needs — paying
// out a whole basket takes about three times the default fee's gas.
//
// Endpoints differ on a failing simulation: the sentry drops the connection, one
// mirror answers 503, another returns the contract's error. So ask each in turn
// until one gives a real answer, success or reason.
async function simulateGas(endpoints, injectiveAddress, msgs, chainId) {
  const accountResponse = await new ChainRestAuthApi(endpoints[0]).fetchAccount(injectiveAddress);
  const account = BaseAccount.fromRestApi(accountResponse);
  const key = accountResponse && accountResponse.account && accountResponse.account.base_account &&
              accountResponse.account.base_account.pub_key && accountResponse.account.base_account.pub_key.key;
  if (!key) return null;   // never signed on Injective yet: no key to simulate with
  const { txRaw } = createTransaction({
    message: msgs, memo: "", signMode: SIGN_EIP712_V2,
    fee: { amount: [{ denom: "inj", amount: "0" }], gas: "5000000" },
    pubKey: key, sequence: account.sequence, accountNumber: account.accountNumber, chainId,
  });
  txRaw.signatures = [new Uint8Array(65)];   // simulation checks the key, not the signature
  const body = JSON.stringify({ tx_bytes: uint8ArrayToBase64(CosmosTxV1Beta1TxPb.TxRaw.toBinary(txRaw)) });
  for (const ep of endpoints) {
    let r, j;
    try {
      r = await fetch(ep.replace(/\/+$/, "") + "/cosmos/tx/v1beta1/simulate",
        { method: "POST", headers: { "content-type": "application/json" }, body });
      j = await r.json();
    } catch (e) { continue; }                       // dropped or not JSON: ask the next one
    if (r.ok && j && j.gas_info) return Number(j.gas_info.gas_used) || null;
    if (j && typeof j.message === "string" && /wasm contract failed|message index/i.test(j.message)) {
      const e = new Error(contractReason(j.message)); e.contract = true; throw e;
    }
  }
  throw new Error("could not check the claim with any Injective endpoint — try again in a moment");
}

/**
 * Claim a finished round's basket: {"claim":{"round_id":N}}, sent by the depositor
 * themselves (the bot's grant covers join_pool only). One wallet signature.
 */
export async function sendClaim({
  ethereumAddress, injectiveAddress, contract, roundId, restEndpoint, endpoints, chainId, evmChainId, signTypedData,
}) {
  const msgs = [MsgExecuteContractCompat.fromJSON({
    sender: injectiveAddress, contractAddress: contract, msg: { claim: { round_id: Number(roundId) } },
  })];
  const eps = [restEndpoint].concat((endpoints || []).filter((e) => e !== restEndpoint));
  const used = await simulateGas(eps, injectiveAddress, msgs, chainId);
  const gas = Math.ceil((used || CLAIM_GAS_FALLBACK) * 1.3);
  const fee = { amount: [{ denom: "inj", amount: (BigInt(gas) * GAS_PRICE).toString() }], gas: String(gas) };
  return sendOne({
    ethereumAddress, injectiveAddress, msgs, restEndpoint, chainId, evmChainId,
    memo: "zzauction claim", signTypedData, fee,
  });
}
