// Browser bundle for /bridge — the Injective side of a withdrawal.
//
// A withdrawal is one Cosmos message, MsgSendToEth, signed from the EVM wallet through
// EIP-712. /auction already runs that exact path and already had its bugs shaken out of
// it (SIGN_EIP712_V2 rather than SIGN_AMINO, one message type per transaction, awaiting
// the public-key recovery), so this reuses its sender instead of keeping a second copy
// that could drift from it.
import { MsgSendToEth } from "@injectivelabs/sdk-ts";
import { keccak_256 } from "@noble/hashes/sha3.js";

export { sendGrantTxs as sendTxs, pickEndpoint } from "../auction/lib-entry.mjs";

// EIP-55: the mixed case of an Ethereum address is a checksum over its keccak hash.
// A destination someone pastes in is checked against it before anything is sent there,
// because a one-character typo in an address loses the funds for good. Verified
// against the spec's own test vector (0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed).
export function toChecksumAddress(address) {
  const a = String(address).toLowerCase().replace(/^0x/, "");
  const h = keccak_256(new TextEncoder().encode(a));
  let out = "0x";
  for (let i = 0; i < 40; i++) {
    const nibble = (h[i >> 1] >> (i % 2 ? 0 : 4)) & 0xf;
    out += nibble >= 8 ? a[i].toUpperCase() : a[i];
  }
  return out;
}

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
