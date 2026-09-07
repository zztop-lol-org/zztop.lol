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
    fee: getDefaultStdFee(),
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
