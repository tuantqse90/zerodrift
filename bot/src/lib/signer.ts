// signer.ts — viem chain definitions + read-only public client. Wallet clients are
// built by callers ONLY when the operator has supplied a key via env (never here).

import { createPublicClient, defineChain, http, type Chain } from "viem";
import { MONAD_RPC_URL, PERPL_CHAIN_ID } from "./config";

export const monad: Chain = defineChain({
  id: 143,
  name: "Monad",
  nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: MONAD_RPC_URL ? [MONAD_RPC_URL] : ["https://rpc.monad.xyz"] } },
});

export const monadTestnet: Chain = defineChain({
  id: 10143,
  name: "Monad Testnet",
  nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
  rpcUrls: {
    default: { http: [process.env.MONAD_TESTNET_RPC_URL || "https://testnet-rpc.monad.xyz"] },
  },
});

/** Chain matching PERPL_CHAIN_ID (143 mainnet / 10143 testnet). */
export const activeChain: Chain = PERPL_CHAIN_ID === 10143 ? monadTestnet : monad;

export const publicClient = createPublicClient({ chain: activeChain, transport: http() });
