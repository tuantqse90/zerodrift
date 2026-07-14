// spot.ts — the spot leg via the NullTerminal aggregator (quote → build → sign →
// broadcast; pattern proven by nullterminal's null-buyer bot). We hold LONG MON
// spot against the perp short. Paper mode quotes for a real price but never sends.

import {
  createPublicClient,
  createWalletClient,
  erc20Abi,
  http,
  type Address,
  type WalletClient,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { NT_API_BASE, TOKENS } from "../lib/config";
import { monad } from "../lib/signer";
import { HEDGER_CONFIG } from "./config";

const NATIVE = TOKENS.NATIVE_MON.address;
const USDC = TOKENS.USDC.address;
const MAX_UINT256 = 2n ** 256n - 1n;

export interface SpotFill {
  mon: number;
  usd: number;
  px: number;
  txHash: string;
  gasUsd: number;
}

let clients: { account: ReturnType<typeof privateKeyToAccount>; wallet: WalletClient; pub: PublicClient } | null =
  null;

function liveClients() {
  if (!HEDGER_CONFIG.live) return null;
  if (!clients) {
    const account = privateKeyToAccount(process.env.HEDGER_PRIVATE_KEY as `0x${string}`);
    clients = {
      account,
      wallet: createWalletClient({ account, chain: monad, transport: http() }),
      pub: createPublicClient({ chain: monad, transport: http() }) as PublicClient,
    };
  }
  return clients;
}

export function spotWalletAddress(): Address | null {
  return liveClients()?.account.address ?? null;
}

async function quote(inputMint: Address, outputMint: Address, amountWei: bigint) {
  const url =
    `${NT_API_BASE}/v1/quote?inputMint=${inputMint}&outputMint=${outputMint}` +
    `&amount=${amountWei}&slippageBps=100`;
  const res = await fetch(url, { signal: AbortSignal.timeout(9000) });
  if (!res.ok) throw new Error(`nt quote ${res.status}`);
  const q = (await res.json()) as { outputAmount?: string; routePlan?: unknown[] };
  if (!q.routePlan?.length || !q.outputAmount || q.outputAmount === "0") return null;
  return q;
}

async function buildSwap(quoteResponse: unknown, from: Address) {
  const res = await fetch(`${NT_API_BASE}/v1/swap`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ quoteResponse, userPublicKey: from, wrapUnwrapMON: true }),
    signal: AbortSignal.timeout(9000),
  });
  if (!res.ok) throw new Error(`nt swap build ${res.status}`);
  const j = (await res.json()) as {
    transaction?: { to: string; data: string; value: string; gasLimit?: string };
  };
  if (!j.transaction?.to || !j.transaction?.data) throw new Error("nt swap: no tx");
  return j.transaction;
}

/** Spot MON price in USD via a small reference quote (1 MON → USDC). */
export async function spotPriceUsd(): Promise<number | null> {
  try {
    const q = await quote(NATIVE, USDC, 10n ** 18n);
    if (!q) return null;
    return Number(BigInt(q.outputAmount!)) / 10 ** TOKENS.USDC.decimals;
  } catch {
    return null;
  }
}

async function ensureAllowance(token: Address, spender: Address, amountWei: bigint): Promise<void> {
  const c = liveClients()!;
  const current = await c.pub.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "allowance",
    args: [c.account.address, spender],
  });
  if (current >= amountWei) return;
  const hash = await c.wallet.writeContract({
    address: token,
    abi: erc20Abi,
    functionName: "approve",
    args: [spender, MAX_UINT256],
    chain: monad,
    account: c.account,
  });
  await c.pub.waitForTransactionReceipt({ hash, timeout: 60_000 });
}

/**
 * Buy `usd` worth of MON with USDC. Paper: returns the quoted fill without sending.
 * Live: broadcasts through the NullTerminal router and returns the real fill.
 */
export async function buySpotMon(usd: number): Promise<SpotFill | null> {
  const usdcWei = BigInt(Math.round(usd * 10 ** TOKENS.USDC.decimals));
  const q = await quote(USDC, NATIVE, usdcWei);
  if (!q) return null;
  const mon = Number(BigInt(q.outputAmount!)) / 1e18;
  const px = usd / mon;

  if (!HEDGER_CONFIG.live) {
    return { mon, usd, px, txHash: "paper", gasUsd: 0 };
  }

  const c = liveClients()!;
  const tx = await buildSwap(q, c.account.address);
  await ensureAllowance(USDC, tx.to as Address, usdcWei);
  const hash = await c.wallet.sendTransaction({
    to: tx.to as Address,
    data: tx.data as `0x${string}`,
    value: BigInt(tx.value || "0"),
    gas: tx.gasLimit ? BigInt(tx.gasLimit) : undefined,
    chain: monad,
    account: c.account,
  });
  const rcpt = await c.pub.waitForTransactionReceipt({ hash, timeout: 90_000 });
  if (rcpt.status !== "success") throw new Error(`spot buy reverted ${hash}`);
  const gasUsd = 0; // MON gas is sub-cent at current prices; tracked as 0, refined in pnl if needed
  return { mon, usd, px, txHash: hash, gasUsd };
}

/** Sell `mon` MON back to USDC (unwind). */
export async function sellSpotMon(mon: number): Promise<SpotFill | null> {
  const monWei = BigInt(Math.round(mon * 1e6)) * 10n ** 12n; // avoid float precision at 18d
  const q = await quote(NATIVE, USDC, monWei);
  if (!q) return null;
  const usd = Number(BigInt(q.outputAmount!)) / 10 ** TOKENS.USDC.decimals;
  const px = usd / mon;

  if (!HEDGER_CONFIG.live) {
    return { mon, usd, px, txHash: "paper", gasUsd: 0 };
  }

  const c = liveClients()!;
  const tx = await buildSwap(q, c.account.address);
  const hash = await c.wallet.sendTransaction({
    to: tx.to as Address,
    data: tx.data as `0x${string}`,
    value: BigInt(tx.value || "0"),
    gas: tx.gasLimit ? BigInt(tx.gasLimit) : undefined,
    chain: monad,
    account: c.account,
  });
  const rcpt = await c.pub.waitForTransactionReceipt({ hash, timeout: 90_000 });
  if (rcpt.status !== "success") throw new Error(`spot sell reverted ${hash}`);
  return { mon, usd, px, txHash: hash, gasUsd: 0 };
}
