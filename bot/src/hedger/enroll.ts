// enroll.ts — one-shot CLI: enroll a fresh Ed25519 API key for the bot's wallet.
//
// Usage (testnet):
//   PERPL_CHAIN_ID=10143 ENROLL_PRIVATE_KEY=0x... bun run hedger:enroll
// Usage (mainnet):
//   ENROLL_PRIVATE_KEY=0x... bun run hedger:enroll
//
// The wallet key signs ONE EIP-712 message authorizing the new API key, then is no
// longer needed here. Secrets are printed to stdout ONLY — never written to disk.
// If the payload/enroll endpoints reject the Origin (not whitelisted by Perpl),
// fall back to the web UI: https://app.perpl.xyz/apikeys (or testnet.perpl.xyz).

import { ed25519 } from "@noble/curves/ed25519";
import { hashTypedData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { PERPL_API_URL, PERPL_CHAIN_ID, envStr } from "../lib/config";
import { b64url } from "../lib/perpl-trade";

const SCOPE_MASK = 3; // read + trade (withdrawals are never possible via API key)
// Server-side enrollment must NOT send an Origin header — Perpl 400s any Origin
// that isn't whitelisted (verified on testnet 2026-07-14). Browsers always send
// one, which is why the web app uses paste-key as the primary flow.
const ORIGIN = envStr("PERPL_ORIGIN", "");
const LABEL = envStr("ENROLL_LABEL", "zerodrift-hedger");

function enrollHeaders(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (ORIGIN) h.Origin = ORIGIN;
  return h;
}

async function main(): Promise<void> {
  const walletKey = process.env.ENROLL_PRIVATE_KEY;
  if (!walletKey) {
    console.error("ENROLL_PRIVATE_KEY not set — refusing to run.");
    process.exit(1);
  }
  const account = privateKeyToAccount(walletKey as `0x${string}`);
  console.log(`enrolling API key · chain=${PERPL_CHAIN_ID} api=${PERPL_API_URL}`);
  console.log(`wallet=${account.address} scope=${SCOPE_MASK} label="${LABEL}" origin=${ORIGIN}`);

  // 1. Fresh Ed25519 key pair — private key never leaves this process.
  const edPriv = ed25519.utils.randomPrivateKey();
  const edPub = ed25519.getPublicKey(edPriv);
  const publicKeyHex = `0x${Buffer.from(edPub).toString("hex")}`;

  // 2. Request the EIP-712 enrollment payload.
  const payloadRes = await fetch(`${PERPL_API_URL}/v1/api-key/payload`, {
    method: "POST",
    headers: enrollHeaders(),
    body: JSON.stringify({
      chain_id: PERPL_CHAIN_ID,
      address: account.address,
      public_key: publicKeyHex,
      scope_mask: SCOPE_MASK,
      label: LABEL,
    }),
  });
  if (!payloadRes.ok) {
    console.error(`payload request failed: HTTP ${payloadRes.status}`);
    console.error(await payloadRes.text());
    console.error("If this is an Origin whitelist rejection, create the key in the web UI instead.");
    process.exit(1);
  }
  const { typed_data, mac } = (await payloadRes.json()) as { typed_data: any; mac: string };

  // 3. Wallet EIP-712 signature. CRITICAL: pass the FULL types INCLUDING
  // EIP712Domain — Perpl's domain has a hex-string chainId + salt, and viem only
  // reproduces the server's digest when the domain type is passed through
  // verbatim (verified against ethers.TypedDataEncoder on testnet 2026-07-14;
  // stripping EIP712Domain yields a different digest → enroll 400).
  const signature = await account.signTypedData({
    domain: typed_data.domain,
    types: typed_data.types,
    primaryType: typed_data.primaryType,
    message: typed_data.message,
  });

  // 4. Ed25519 proof-of-possession over the same EIP-712 digest.
  const digest = hashTypedData({
    domain: typed_data.domain,
    types: typed_data.types,
    primaryType: typed_data.primaryType,
    message: typed_data.message,
  });
  const pop = ed25519.sign(Uint8Array.from(Buffer.from(digest.slice(2), "hex")), edPriv);
  const popSignature = `0x${Buffer.from(pop).toString("hex")}`;

  // 5. Submit both signatures.
  const enrollRes = await fetch(`${PERPL_API_URL}/v1/api-key/enroll`, {
    method: "POST",
    headers: enrollHeaders(),
    body: JSON.stringify({
      chain_id: PERPL_CHAIN_ID,
      address: account.address,
      typed_data,
      mac,
      signature,
      pop_signature: popSignature,
    }),
  });
  if (!enrollRes.ok) {
    console.error(`enroll failed: HTTP ${enrollRes.status}`);
    console.error(await enrollRes.text());
    process.exit(1);
  }
  const enrolled = (await enrollRes.json()) as { api_key: { api_key: string } };

  console.log("");
  console.log("Enrolled. Add these to the VPS .env (NEVER commit them):");
  console.log("");
  console.log(`PERPL_API_KEY=${enrolled.api_key.api_key}`);
  console.log(`PERPL_ED25519_PRIVKEY=0x${Buffer.from(edPriv).toString("hex")}`);
  console.log("");
  console.log(`sanity: b64url(pub)=${b64url(edPub).slice(0, 12)}… scope=${SCOPE_MASK}`);
}

main().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
