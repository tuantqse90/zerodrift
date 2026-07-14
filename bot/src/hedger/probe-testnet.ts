// probe-testnet.ts — Day-1/2 validation harness against Perpl TESTNET (chain 10143).
//
// Uses a THROWAWAY wallet (generated in-process, testnet-only, never funded on
// mainnet) to validate, without risking anything:
//   1. /v1/pub/context shape (order_ttl_blocks, points_boost_bps, instance/collateral)
//   2. API-key enrollment flow (payload → EIP-712 sign → enroll)
//   3. Trading WS sign-in (mt:29) → WalletSnapshot (mt:19) → heartbeat sn/h tracking
//
// Run: bun run probe:testnet
// All received frames are echoed so we can pin real-world message shapes.

import { ed25519 } from "@noble/curves/ed25519";
import { hashTypedData } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const API = process.env.PERPL_API_URL || "https://testnet.perpl.xyz/api";
const WS = process.env.PERPL_WS_URL || "wss://testnet.perpl.xyz";
const CHAIN_ID = Number(process.env.PERPL_CHAIN_ID) || 10143;
// No Origin header by default: unwhitelisted Origins are 400-rejected (verified).
const ORIGIN = process.env.PERPL_ORIGIN || "";

function jsonHeaders(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (ORIGIN) h.Origin = ORIGIN;
  return h;
}

async function probeContext(): Promise<void> {
  console.log("── 1. context ──");
  const res = await fetch(`${API}/v1/pub/context`);
  console.log(`GET /v1/pub/context → ${res.status}`);
  if (!res.ok) return;
  const ctx = (await res.json()) as any;
  const inst = ctx.instances?.[0];
  console.log(`instance: address=${inst?.address} collateral_token_id=${inst?.collateral_token_id}`);
  console.log(`min_account_open_amount=${inst?.min_account_open_amount}`);
  const collateral = ctx.tokens?.find((t: any) => t.id === inst?.collateral_token_id);
  console.log(`collateral: ${collateral?.symbol} ${collateral?.address} decimals=${collateral?.decimals}`);
  for (const m of ctx.markets ?? []) {
    console.log(
      `market ${m.id} ${m.name}: open=${m.config?.is_open} pd=${m.config?.price_decimals} sd=${m.config?.size_decimals}` +
        ` maker=${m.config?.maker_fee}µ taker=${m.config?.taker_fee}µ ttl=${m.order_ttl_blocks}blk` +
        ` retry=${m.order_retry_blocks} boost=${m.points_boost_bps}bps im=${m.config?.initial_margin}`,
    );
  }
}

async function enrollThrowaway(): Promise<{ apiKey: string; edPriv: Uint8Array } | null> {
  console.log("── 2. enroll (throwaway wallet) ──");
  const wallet = privateKeyToAccount(generatePrivateKey());
  console.log(`throwaway wallet: ${wallet.address}`);

  const edPriv = ed25519.utils.randomPrivateKey();
  const edPub = ed25519.getPublicKey(edPriv);

  const payloadRes = await fetch(`${API}/v1/api-key/payload`, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({
      chain_id: CHAIN_ID,
      address: wallet.address,
      public_key: `0x${Buffer.from(edPub).toString("hex")}`,
      scope_mask: 3,
      label: "zerodrift-probe",
    }),
  });
  console.log(`POST /v1/api-key/payload → ${payloadRes.status}`);
  const payloadBody = await payloadRes.text();
  if (!payloadRes.ok) {
    console.log(`payload response: ${payloadBody.slice(0, 500)}`);
    return null;
  }
  const { typed_data, mac } = JSON.parse(payloadBody);
  console.log(`typed_data.primaryType=${typed_data?.primaryType} domain=${JSON.stringify(typed_data?.domain)}`);
  console.log(`typed_data.message keys=${Object.keys(typed_data?.message ?? {}).join(",")}`);

  // Full types INCLUDING EIP712Domain — required for viem to match the server digest.
  const signature = await wallet.signTypedData({
    domain: typed_data.domain,
    types: typed_data.types,
    primaryType: typed_data.primaryType,
    message: typed_data.message,
  });
  const digest = hashTypedData({
    domain: typed_data.domain,
    types: typed_data.types,
    primaryType: typed_data.primaryType,
    message: typed_data.message,
  });
  const pop = ed25519.sign(Uint8Array.from(Buffer.from(digest.slice(2), "hex")), edPriv);

  const enrollRes = await fetch(`${API}/v1/api-key/enroll`, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({
      chain_id: CHAIN_ID,
      address: wallet.address,
      typed_data,
      mac,
      signature,
      pop_signature: `0x${Buffer.from(pop).toString("hex")}`,
    }),
  });
  const enrollBody = await enrollRes.text();
  console.log(`POST /v1/api-key/enroll → ${enrollRes.status}`);
  if (!enrollRes.ok) {
    console.log(`enroll response: ${enrollBody.slice(0, 500)}`);
    if (enrollRes.status === 404) {
      console.log(
        "404 = target profile not found: the wallet must have a Perpl profile first " +
          "(connect the wallet once at the Perpl web app). Signature path itself is OK.",
      );
    }
    return null;
  }
  const enrolled = JSON.parse(enrollBody);
  console.log(`enrolled: label=${enrolled.api_key?.label} scope=${enrolled.api_key?.scope_mask} origin=${enrolled.api_key?.origin}`);
  return { apiKey: enrolled.api_key.api_key, edPriv };
}

async function probeTradingWs(apiKey: string, edPriv: Uint8Array): Promise<void> {
  console.log("── 3. trading WS sign-in ──");
  await new Promise<void>((resolve) => {
    const ws = new WebSocket(`${WS}/ws/v1/trading`);
    const timeout = setTimeout(() => {
      console.log("(15s window over — closing)");
      ws.close();
      resolve();
    }, 15_000);

    ws.onopen = () => {
      const timestamp = Date.now().toString();
      const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url");
      const canonical = [CHAIN_ID, "trading-ws-signin", timestamp, nonce].join("\n");
      const signature = Buffer.from(ed25519.sign(new TextEncoder().encode(canonical), edPriv)).toString("base64url");
      ws.send(JSON.stringify({ mt: 29, chain_id: CHAIN_ID, api_key: apiKey, timestamp, nonce, signature }));
      console.log("sent ApiKeySignIn (mt:29)");
    };
    ws.onmessage = (ev) => {
      const raw = String(ev.data);
      let mt = "?";
      try {
        mt = String(JSON.parse(raw).mt);
      } catch {
        /* keep raw */
      }
      console.log(`← mt:${mt} ${raw.slice(0, 400)}`);
    };
    ws.onclose = (ev: any) => {
      console.log(`ws closed code=${ev.code} reason=${ev.reason || "(none)"}`);
      clearTimeout(timeout);
      resolve();
    };
    ws.onerror = () => console.log("ws error");
  });
}

async function main(): Promise<void> {
  console.log(`probe against ${API} (chain ${CHAIN_ID}) origin=${ORIGIN}`);
  await probeContext();
  const key = await enrollThrowaway();
  if (key) await probeTradingWs(key.apiKey, key.edPriv);
  else console.log("(skipping WS probe — enrollment failed; try web-UI key + PERPL_API_KEY/PERPL_ED25519_PRIVKEY env)");
}

main().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
