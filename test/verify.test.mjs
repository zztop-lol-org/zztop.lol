// Validate EIP-191 recovery against ethers (independent reference).
import assert from "node:assert/strict";
import { Wallet, hashMessage, recoverAddress } from "ethers";
import { recoverEthAddress, ethToInj } from "../src/community/verify.mjs";
import { injFromEthAddress } from "../src/inj.mjs";
import { hexToBytes } from "@noble/hashes/utils";

let pass = 0;
const ok = (n) => { console.log("  ok -", n); pass++; };

// 1) recover matches ethers for many random wallets + messages
{
  for (let i = 0; i < 100; i++) {
    const w = Wallet.createRandom();
    const msg = "zzzz confirming it's you\n" + (1_700_000_000 + i);
    const sig = await w.signMessage(msg);
    const rec = recoverEthAddress(msg, sig);
    assert.equal(rec, w.address.toLowerCase(), "recovered != signer");
  }
  ok("recoverEthAddress matches ethers over 100 signed messages");
}

// 2) bad signatures return null (no throw)
{
  assert.equal(recoverEthAddress("hi", "0x1234"), null);
  assert.equal(recoverEthAddress("hi", "0x" + "00".repeat(65)), null); // v invalid
  ok("malformed signatures return null");
}

// 3) ethToInj matches injFromEthAddress and is stable
{
  const w = Wallet.createRandom();
  const addr20 = hexToBytes(w.address.slice(2).toLowerCase());
  assert.equal(ethToInj(w.address), injFromEthAddress(addr20));
  assert.ok(ethToInj(w.address).startsWith("inj1"));
  ok("ethToInj == injFromEthAddress (0x -> inj1, no re-keccak)");
}

// 4) end-to-end: sign -> recover -> inj address
{
  const w = Wallet.createRandom();
  const msg = "zzzz confirming it's you\n1730000000";
  const sig = await w.signMessage(msg);
  const eth = recoverEthAddress(msg, sig);
  const inj = ethToInj(eth);
  const expected = injFromEthAddress(hexToBytes(w.address.slice(2).toLowerCase()));
  assert.equal(inj, expected);
  ok(`end-to-end sign->recover->inj: ${inj.slice(0, 14)}...`);
}

console.log(`\nALL ${pass} verify checks passed.`);
