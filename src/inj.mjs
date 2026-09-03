// Injective (inj1...) address derivation from a secp256k1 (eth) private key.
// Ethermint scheme: keccak256(uncompressed_pubkey[1:])[12:] -> 20-byte eth address,
// then original Bech32 (NOT bech32m) with HRP "inj".
//
// Correctness-critical. Differential-tested in test/derive.test.mjs against
// ethers (eth address) + the bech32 npm lib + a hardcoded known vector.
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function polymod(values) {
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GEN[i];
  }
  return chk >>> 0;
}

function hrpExpand(hrp) {
  const out = [];
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) >>> 5);
  out.push(0);
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) & 31);
  return out;
}

// original Bech32 checksum constant is 1 (bech32m would be 0x2bc830a3)
function checksum(hrp, data) {
  const vals = hrpExpand(hrp).concat(data).concat([0, 0, 0, 0, 0, 0]);
  const mod = polymod(vals) ^ 1;
  const out = [];
  for (let i = 0; i < 6; i++) out.push((mod >>> (5 * (5 - i))) & 31);
  return out;
}

// convert 8-bit bytes -> 5-bit groups (pad=true). 20 bytes -> exactly 32 groups.
export function convert8to5(bytes) {
  let acc = 0, bits = 0;
  const out = [];
  for (const b of bytes) {
    acc = ((acc << 8) | b) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out.push((acc >>> bits) & 31);
    }
  }
  if (bits > 0) out.push((acc << (5 - bits)) & 31);
  return out;
}

export function bech32Encode(hrp, data5) {
  const combined = data5.concat(checksum(hrp, data5));
  let s = hrp + "1";
  for (const d of combined) s += CHARSET[d];
  return s;
}

// 20-byte eth account address from a 32-byte private key
export function ethAddressFromPriv(privBytes) {
  const pub = secp256k1.getPublicKey(privBytes, false); // 65 bytes: 0x04 || X || Y
  if (pub.length !== 65 || pub[0] !== 0x04) throw new Error("bad uncompressed pubkey");
  const hash = keccak_256(pub.subarray(1)); // keccak over 64-byte X||Y
  return hash.subarray(12, 32);
}

export function injFromEthAddress(addr20) {
  if (addr20.length !== 20) throw new Error("address must be 20 bytes");
  return bech32Encode("inj", convert8to5(addr20));
}

export function injFromPriv(privBytes) {
  return injFromEthAddress(ethAddressFromPriv(privBytes));
}
