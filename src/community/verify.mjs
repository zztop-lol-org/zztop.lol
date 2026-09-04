// EIP-191 personal_sign recovery -> eth address -> inj bech32.
// Used by functions/api/submit to prove the wallet controls the address whose
// ZZ balance we gate on. Bundled (with noble) into functions/_lib/crypto.js.
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { injFromEthAddress } from "../inj.mjs";

const enc = new TextEncoder();

function hexToBytes(hex) {
  hex = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (hex.length % 2) throw new Error("bad hex length");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
function toHex(bytes) { let s = ""; for (const b of bytes) s += b.toString(16).padStart(2, "0"); return s; }

// keccak256 of the EIP-191 personal_sign digest for a utf8 string message
function personalSignDigest(message) {
  const msg = enc.encode(message);
  const prefix = enc.encode("\x19Ethereum Signed Message:\n" + msg.length);
  const buf = new Uint8Array(prefix.length + msg.length);
  buf.set(prefix, 0);
  buf.set(msg, prefix.length);
  return keccak_256(buf);
}

// recover the 0x eth address (lowercase, 0x-prefixed) that produced `signature`
// over `message` via personal_sign. Returns null if the signature is malformed.
export function recoverEthAddress(message, signature) {
  try {
    const sig = hexToBytes(signature);
    if (sig.length !== 65) return null;
    const r = sig.slice(0, 32), s = sig.slice(32, 64);
    let v = sig[64];
    if (v === 27 || v === 28) v -= 27;
    if (v !== 0 && v !== 1) return null;
    const digest = personalSignDigest(message);
    const rs = new Uint8Array(64); rs.set(r, 0); rs.set(s, 32);
    const recovered = secp256k1.Signature.fromCompact(rs).addRecoveryBit(v).recoverPublicKey(digest);
    const pub = recovered.toRawBytes(false); // 65 bytes: 0x04 || X || Y
    const addr = keccak_256(pub.subarray(1)).subarray(12, 32); // 20 bytes
    return "0x" + toHex(addr);
  } catch {
    return null;
  }
}

// 0x eth address -> inj1... (direct 20-byte bech32; do NOT re-keccak)
export function ethToInj(eth0x) {
  const addr20 = hexToBytes(eth0x);
  if (addr20.length !== 20) throw new Error("eth address must be 20 bytes");
  return injFromEthAddress(addr20);
}
