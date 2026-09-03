// Differential + edge-case tests for the Injective derivation.
// Reference sources INDEPENDENT of our impl: ethers (eth address) and the
// bech32 npm lib (encoding), plus a hardcoded known eth vector (privkey=1).
import assert from "node:assert/strict";
import { computeAddress } from "ethers";
import { bech32, bech32m } from "bech32";
import { hexToBytes, bytesToHex } from "@noble/hashes/utils";
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { sha3_256 } from "@noble/hashes/sha3";
import { injFromPriv, injFromEthAddress, ethAddressFromPriv, convert8to5, bech32Encode } from "../src/inj.mjs";

let pass = 0;
const ok = (name) => { console.log("  ok -", name); pass++; };

// independent reference: eth addr via ethers, inj via bech32 lib
function refInj(privHex) {
  const eth = computeAddress("0x" + privHex); // ethers, checksummed 0x...
  const addr20 = hexToBytes(eth.slice(2).toLowerCase());
  const words = bech32.toWords(addr20);
  return { eth: eth.toLowerCase(), inj: bech32.encode("inj", words), addr20 };
}

// 1) hardcoded anchor: privkey=1 -> known eth address (public test vector)
{
  const priv = "0000000000000000000000000000000000000000000000000000000000000001";
  const eth = "0x" + bytesToHex(ethAddressFromPriv(hexToBytes(priv)));
  assert.equal(eth, "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf");
  ok("privkey=1 -> known eth address 0x7e5f...5bdf");
}

// 2) differential vs ethers+bech32 across many random keys
{
  for (let i = 0; i < 200; i++) {
    const priv = bytesToHex(secp256k1.utils.randomPrivateKey());
    const ref = refInj(priv);
    const mineEth = bytesToHex(ethAddressFromPriv(hexToBytes(priv)));
    const mineInj = injFromPriv(hexToBytes(priv));
    assert.equal(mineEth, ref.eth.slice(2), "eth mismatch " + priv);
    assert.equal(mineInj, ref.inj, "inj mismatch " + priv);
  }
  ok("200 random keys match ethers+bech32 (eth address AND inj bech32)");
}

// 3) round-trip: our inj decodes back to the same 20 bytes
{
  const priv = bytesToHex(secp256k1.utils.randomPrivateKey());
  const addr20 = ethAddressFromPriv(hexToBytes(priv));
  const inj = injFromEthAddress(addr20);
  const dec = bech32.decode(inj);
  assert.equal(dec.prefix, "inj");
  const back = new Uint8Array(bech32.fromWords(dec.words));
  assert.deepEqual([...back], [...addr20]);
  ok("inj address round-trips to the original 20 bytes");
}

// 4) it must be Bech32, NOT bech32m (cosmos uses original bech32)
{
  const addr20 = ethAddressFromPriv(hexToBytes("01".padStart(64, "0")));
  const inj = injFromEthAddress(addr20);
  assert.ok(bech32.decode(inj), "must decode as bech32");
  assert.throws(() => bech32m.decode(inj), /./, "must NOT decode as bech32m");
  ok("uses original Bech32, rejects as bech32m");
}

// 5) it must be Keccak-256, NOT SHA3-256
{
  const priv = hexToBytes("11".repeat(32));
  const pub = secp256k1.getPublicKey(priv, false).subarray(1);
  const keccakAddr = bytesToHex(keccak_256(pub).subarray(12, 32));
  const sha3Addr = bytesToHex(sha3_256(pub).subarray(12, 32));
  const mine = bytesToHex(ethAddressFromPriv(priv));
  assert.equal(mine, keccakAddr);
  assert.notEqual(mine, sha3Addr);
  ok("uses legacy Keccak-256, not SHA3-256");
}

// 6) fixed-width coord serialization: X and Y padded to 32 bytes each.
//    noble getPublicKey(false) already does this; assert the 64-byte length.
{
  // pick a key whose pubkey X has a leading zero byte to catch left-pad bugs
  let priv, xy;
  for (let i = 1; i < 100000; i++) {
    priv = hexToBytes(i.toString(16).padStart(64, "0"));
    xy = secp256k1.getPublicKey(priv, false).subarray(1);
    if (xy[0] === 0x00) break; // X starts with a zero byte
  }
  assert.equal(xy.length, 64);
  assert.equal(xy[0], 0x00, "found a key with zero-padded X");
  // derivation still matches ethers for this tricky key
  const ref = refInj(bytesToHex(priv));
  assert.equal(injFromPriv(priv), ref.inj);
  ok("fixed-width 32-byte X||Y (zero-padded X handled)");
}

// 7) convert8to5 produces exactly 32 groups for 20 bytes (no checksum bleakage)
{
  const groups = convert8to5(new Uint8Array(20).fill(0xff));
  assert.equal(groups.length, 32);
  ok("20 bytes -> exactly 32 five-bit groups");
}

// 8) prefix-bit matcher agrees with the actual encoded string (leading z count)
{
  const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
  const zVal = CHARSET.indexOf("z"); // 2
  for (let t = 0; t < 300; t++) {
    const addr20 = ethAddressFromPriv(secp256k1.utils.randomPrivateKey());
    const groups = convert8to5(addr20);
    // count leading z via groups
    let byGroup = 0;
    while (byGroup < 32 && groups[byGroup] === zVal) byGroup++;
    // count leading z via the actual string
    const inj = injFromEthAddress(addr20);
    const body = inj.slice(inj.indexOf("1") + 1); // after 'inj1'
    let byStr = 0;
    while (byStr < body.length && body[byStr] === "z") byStr++;
    assert.equal(byGroup, Math.min(byStr, 32));
  }
  ok("prefix-bit matcher (5-bit==2) equals leading-z count in the string");
}

console.log(`\nALL ${pass} derivation checks passed.`);
