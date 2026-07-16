// registry.ts — on-chain HedgeRegistry attestations. No-op in paper mode or when
// no registry address is configured; failures alert but never break the hedge.

import { createPublicClient, createWalletClient, http, parseAbi, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { monad } from "../lib/signer";
import { alertOnce } from "../lib/telegram";
import { HEDGER_CONFIG } from "./config";

const REGISTRY_ABI = parseAbi([
  "function openEpoch(uint32 marketId, uint128 notionalUsd6, bytes32 spotTxRef, bytes32 perpRef) returns (uint256)",
  "function closeEpoch(uint256 epochId, uint128 closeNotionalUsd6, bytes32 closeSpotTxRef, bytes32 closePerpRef)",
  "function epochCount(address owner) view returns (uint256)",
]);

function toBytes32(ref: string): `0x${string}` {
  // Real tx hashes pass through; synthetic refs ("owner-held", "perp-7") are
  // UTF-8-encoded — padding raw text produced invalid hex and made every
  // openEpoch/closeEpoch revert before reaching the chain.
  let clean = ref.startsWith("0x") ? ref.slice(2) : ref;
  if (!/^[0-9a-fA-F]*$/.test(clean)) clean = Buffer.from(ref, "utf8").toString("hex");
  clean = clean.slice(0, 64);
  return `0x${clean.padStart(64, "0")}` as `0x${string}`;
}

function enabled(): boolean {
  return HEDGER_CONFIG.live && !!HEDGER_CONFIG.registryAddress && !!process.env.HEDGER_PRIVATE_KEY;
}

export async function openEpochOnChain(
  marketId: number,
  notionalUsd: number,
  spotTxRef: string,
  perpRef: string,
): Promise<number> {
  if (!enabled()) return -1;
  try {
    const account = privateKeyToAccount(process.env.HEDGER_PRIVATE_KEY as `0x${string}`);
    const wallet = createWalletClient({ account, chain: monad, transport: http() });
    const pub = createPublicClient({ chain: monad, transport: http() });
    const registry = HEDGER_CONFIG.registryAddress as Address;

    const before = await pub.readContract({
      address: registry,
      abi: REGISTRY_ABI,
      functionName: "epochCount",
      args: [account.address],
    });
    const hash = await wallet.writeContract({
      address: registry,
      abi: REGISTRY_ABI,
      functionName: "openEpoch",
      args: [marketId, BigInt(Math.round(notionalUsd * 1e6)), toBytes32(spotTxRef), toBytes32(perpRef)],
      chain: monad,
      account,
    });
    await pub.waitForTransactionReceipt({ hash, timeout: 90_000 });
    void alertOnce("ph:epoch-open", 60_000, `📗 ZeroDrift epoch #${before} opened on-chain\n${hash}`);
    return Number(before);
  } catch (e) {
    void alertOnce("ph:epoch-open-fail", 3600_000, `⚠️ openEpoch failed: ${(e as Error).message}`);
    return -1;
  }
}

export async function closeEpochOnChain(
  epochId: number,
  closeNotionalUsd: number,
  closeSpotTxRef: string,
  closePerpRef: string,
): Promise<boolean> {
  if (!enabled() || epochId < 0) return false;
  try {
    const account = privateKeyToAccount(process.env.HEDGER_PRIVATE_KEY as `0x${string}`);
    const wallet = createWalletClient({ account, chain: monad, transport: http() });
    const pub = createPublicClient({ chain: monad, transport: http() });
    const hash = await wallet.writeContract({
      address: HEDGER_CONFIG.registryAddress as Address,
      abi: REGISTRY_ABI,
      functionName: "closeEpoch",
      args: [BigInt(epochId), BigInt(Math.round(closeNotionalUsd * 1e6)), toBytes32(closeSpotTxRef), toBytes32(closePerpRef)],
      chain: monad,
      account,
    });
    await pub.waitForTransactionReceipt({ hash, timeout: 90_000 });
    void alertOnce("ph:epoch-close", 60_000, `📕 ZeroDrift epoch #${epochId} closed on-chain\n${hash}`);
    return true;
  } catch (e) {
    void alertOnce("ph:epoch-close-fail", 3600_000, `⚠️ closeEpoch failed: ${(e as Error).message}`);
    return false;
  }
}
