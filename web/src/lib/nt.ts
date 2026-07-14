// nt.ts — NullTerminal aggregator client for the spot leg (quote → unsigned tx →
// user's wallet signs). Native MON is the zero address; the API handles wrapping.

import type { Address } from "viem";

const NT_API = import.meta.env.VITE_NT_API_URL || "https://api.nullterminal.xyz";
export const NATIVE: Address = "0x0000000000000000000000000000000000000000";
export const USDC: Address = "0x754704Bc059F8C67012fEd69BC8A327a5aafb603";
export const USDC_DECIMALS = 6;

export interface NtQuote {
  outputAmount: string;
  routePlan: unknown[];
  [k: string]: unknown;
}

export async function ntQuote(
  inputMint: Address,
  outputMint: Address,
  amountWei: bigint,
  slippageBps = 100,
): Promise<NtQuote | null> {
  const url = `${NT_API}/v1/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountWei}&slippageBps=${slippageBps}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(9000) });
  if (!res.ok) return null;
  const q = (await res.json()) as NtQuote;
  if (!q.routePlan?.length || !q.outputAmount || q.outputAmount === "0") return null;
  return q;
}

export async function ntBuildSwap(
  quoteResponse: NtQuote,
  from: Address,
): Promise<{ to: Address; data: `0x${string}`; value: bigint; gas?: bigint } | null> {
  const res = await fetch(`${NT_API}/v1/swap`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ quoteResponse, userPublicKey: from, wrapUnwrapMON: true }),
    signal: AbortSignal.timeout(9000),
  });
  if (!res.ok) return null;
  const j = (await res.json()) as { transaction?: { to: string; data: string; value: string; gasLimit?: string } };
  const t = j.transaction;
  if (!t?.to || !t?.data) return null;
  return {
    to: t.to as Address,
    data: t.data as `0x${string}`,
    value: BigInt(t.value || "0"),
    gas: t.gasLimit ? BigInt(t.gasLimit) : undefined,
  };
}

/** Spot MON/USD reference price (1 MON → USDC). */
export async function spotPriceUsd(): Promise<number | null> {
  const q = await ntQuote(NATIVE, USDC, 10n ** 18n);
  if (!q) return null;
  return Number(BigInt(q.outputAmount)) / 10 ** USDC_DECIMALS;
}
