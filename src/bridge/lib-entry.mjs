// Browser bundle for /bridge — the Injective side of a withdrawal.
//
// A withdrawal is one Cosmos message, MsgSendToEth, signed from the EVM wallet through
// EIP-712. /auction already runs that exact path and already had its bugs shaken out of
// it (SIGN_EIP712_V2 rather than SIGN_AMINO, one message type per transaction, awaiting
// the public-key recovery), so this reuses its sender instead of keeping a second copy
// that could drift from it.
import { MsgSendToEth } from "@injectivelabs/sdk-ts";

export { sendGrantTxs as sendTxs, pickEndpoint } from "../auction/lib-entry.mjs";

// The sender is `injectiveAddress` and the Ethereum destination is `address` — read off
// the SDK's toProto(), because swapping the two sends the funds somewhere else. The fee
// is always passed explicitly: left out, the SDK substitutes a default of its own.
export function buildWithdraw({ injectiveAddress, ethDest, denom, amountRaw, feeRaw }) {
  return MsgSendToEth.fromJSON({
    injectiveAddress,
    address: ethDest,
    amount: { denom, amount: String(amountRaw) },
    bridgeFee: { denom, amount: String(feeRaw) },
  });
}
