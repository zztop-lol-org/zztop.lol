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
  ContractExecutionAuthz,
  BaseAccount,
  ChainRestAuthApi,
  ChainRestTendermintApi,
  getEip712TypedDataV2,
  createTransaction,
  createTxRawEIP712,
  createWeb3Extension,
  TxRestApi,
  SIGN_AMINO,
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
 * Build the two grant messages. Kept separate from signing so the page can show
 * the user exactly what they are about to authorize.
 */
export function buildGrantMsgs({ granter, grantee, contract, messageKey, maxFundsWei, feeWei, expirationUnix }) {
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

  return [authz, feegrant];
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

/**
 * Prepare -> sign -> broadcast. `signTypedData(addressHex, jsonString)` is
 * supplied by the page so wallet plumbing stays where the rest of it lives.
 */
export async function sendGrants({
  ethereumAddress,
  injectiveAddress,
  msgs,
  restEndpoint,
  chainId,
  evmChainId,
  memo = "zzauction grant",
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

  const signature = await signTypedData(ethereumAddress, JSON.stringify(eip712TypedData));

  const publicKeyBase64 = hexToBase64(recoverTypedSignaturePubKey(eip712TypedData, signature));

  const { txRaw } = createTransaction({
    message: msgs,
    memo,
    signMode: SIGN_AMINO,
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
