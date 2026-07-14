// config.ts — env-driven configuration. Everything has a safe default; secrets
// (private keys, API keys) are read ONLY from env and never persisted or logged.

import type { Address } from "viem";

export function envStr(name: string, def: string): string {
  const v = process.env[name];
  return v && v.length > 0 ? v : def;
}

export function envNum(name: string, def: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && process.env[name] ? v : def;
}

export function envBool(name: string, def: boolean): boolean {
  const v = (process.env[name] || "").toLowerCase();
  if (v === "true" || v === "1") return true;
  if (v === "false" || v === "0") return false;
  return def;
}

// ── Chain / RPC ──────────────────────────────────────────────────────────────
export const MONAD_RPC_URL = envStr("MONAD_RPC_URL", "");
export const PERPL_CHAIN_ID = envNum("PERPL_CHAIN_ID", 143); // 143 mainnet, 10143 testnet

// ── Perpl endpoints (mainnet defaults; override for testnet) ─────────────────
export const PERPL_API_URL = envStr(
  "PERPL_API_URL",
  PERPL_CHAIN_ID === 10143 ? "https://testnet.perpl.xyz/api" : "https://app.perpl.xyz/api",
);
export const PERPL_WS_URL = envStr(
  "PERPL_WS_URL",
  PERPL_CHAIN_ID === 10143 ? "wss://testnet.perpl.xyz" : "wss://app.perpl.xyz",
);

/** Perpl Exchange contract (collateral custody + createAccount). */
export const PERPL_EXCHANGE: Address = envStr(
  "PERPL_EXCHANGE_ADDRESS",
  "0x34B6552d57a35a1D042CcAe1951BD1C370112a6F", // mainnet — override on testnet
) as Address;

export const PERPL_MARKET_IDS: Record<string, number> = {
  BTC: 1,
  MON: 10,
  ETH: 20,
  SOL: 31,
  HYPE: 40,
  ZEC: 50,
};

// ── NullTerminal aggregator (spot leg) ───────────────────────────────────────
export const NT_API_BASE = envStr("NT_API_BASE", "https://api.nullterminal.xyz");

// ── Tokens (Monad mainnet) ───────────────────────────────────────────────────
export interface TokenInfo {
  address: Address;
  decimals: number;
}
export const TOKENS: Record<string, TokenInfo> = {
  NATIVE_MON: { address: "0x0000000000000000000000000000000000000000", decimals: 18 },
  WMON: { address: "0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A", decimals: 18 },
  USDC: { address: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603", decimals: 6 },
  AUSD: { address: "0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a", decimals: 6 },
};
