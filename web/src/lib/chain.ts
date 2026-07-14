// chain.ts — Monad chain config, public client, injected-wallet connect, and the
// HedgeRegistry read/write surface. No wallet SDK: viem + window.ethereum only.
//
// NOTE: rpc.monad.xyz caps eth_getLogs at a 100-BLOCK range (-32614), so epoch
// history is read via contract views per owner (epochCount + getEpoch) instead of
// log scans, plus a rolling 100-block live watch that accumulates while the tab
// is open.

import {
  createPublicClient,
  createWalletClient,
  custom,
  defineChain,
  http,
  parseAbi,
  parseAbiItem,
  type Address,
  type WalletClient,
} from "viem";

export const MONAD_RPC = import.meta.env.VITE_MONAD_RPC || "https://rpc.monad.xyz";
export const REGISTRY_ADDRESS = (import.meta.env.VITE_HEDGE_REGISTRY_ADDRESS ||
  "0x24BD952B9BaD090Eab24A1a91948fA130c8D3A48") as Address;
/** Wallets always shown in the epoch feed (the ZeroDrift bot / demo farmer). */
export const FEATURED_FARMERS: Address[] = ["0x66449F79050828abb7A205434C0971dBA7a44C38"];

export const monad = defineChain({
  id: 143,
  name: "Monad",
  nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [MONAD_RPC] } },
  blockExplorers: { default: { name: "MonadScan", url: "https://monadscan.com" } },
  contracts: {
    multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" },
  },
});

export const publicClient = createPublicClient({ chain: monad, transport: http() });

export const REGISTRY_ABI = parseAbi([
  "function openEpoch(uint32 marketId, uint128 notionalUsd6, bytes32 spotTxRef, bytes32 perpRef) returns (uint256)",
  "function closeEpoch(uint256 epochId, uint128 closeNotionalUsd6, bytes32 closeSpotTxRef, bytes32 closePerpRef)",
  "function epochCount(address owner) view returns (uint256)",
  "function getEpoch(address owner, uint256 epochId) view returns ((uint64 openedAt, uint64 closedAt, uint32 marketId, uint128 notionalUsd6, uint128 closeNotionalUsd6, bytes32 spotTxRef, bytes32 perpRef, bytes32 closeSpotTxRef, bytes32 closePerpRef))",
]);

const EPOCH_OPENED = parseAbiItem(
  "event EpochOpened(address indexed owner, uint256 indexed epochId, uint32 indexed marketId, uint128 notionalUsd6, bytes32 spotTxRef, bytes32 perpRef)",
);

export interface EpochRow {
  owner: Address;
  epochId: number;
  marketId: number;
  notionalUsd: number;
  openedAt: number; // unix seconds
  closed: boolean;
  closeNotionalUsd?: number;
}

/** All epochs for one owner via contract views (newest first, capped). */
export async function fetchOwnerEpochs(owner: Address, cap = 20): Promise<EpochRow[]> {
  const count = Number(
    await publicClient.readContract({
      address: REGISTRY_ADDRESS,
      abi: REGISTRY_ABI,
      functionName: "epochCount",
      args: [owner],
    }),
  );
  if (count === 0) return [];
  const from = Math.max(0, count - cap);
  const ids = Array.from({ length: count - from }, (_, i) => from + i);
  const epochs = await Promise.all(
    ids.map((id) =>
      publicClient.readContract({
        address: REGISTRY_ADDRESS,
        abi: REGISTRY_ABI,
        functionName: "getEpoch",
        args: [owner, BigInt(id)],
      }),
    ),
  );
  return epochs
    .map((e, i) => ({
      owner,
      epochId: ids[i],
      marketId: Number(e.marketId),
      notionalUsd: Number(e.notionalUsd6) / 1e6,
      openedAt: Number(e.openedAt),
      closed: e.closedAt !== 0n && Number(e.closedAt) !== 0,
      closeNotionalUsd: Number(e.closeNotionalUsd6) / 1e6,
    }))
    .reverse();
}

/** Epochs for the featured farmers + any extra owners (deduped, newest first). */
export async function fetchEpochFeed(extraOwners: Address[] = []): Promise<EpochRow[]> {
  const owners = [...new Set([...extraOwners, ...FEATURED_FARMERS].map((a) => a.toLowerCase()))] as Address[];
  const all = await Promise.all(owners.map((o) => fetchOwnerEpochs(o).catch(() => [] as EpochRow[])));
  return all.flat().sort((a, b) => b.openedAt - a.openedAt);
}

/** Rolling live watch: new EpochOpened owners in the last ~100 blocks. */
export async function scanRecentOpeners(): Promise<Address[]> {
  try {
    const head = await publicClient.getBlockNumber();
    const logs = await publicClient.getLogs({
      address: REGISTRY_ADDRESS,
      event: EPOCH_OPENED,
      fromBlock: head - 99n,
      toBlock: head,
    });
    return [...new Set(logs.map((l) => l.args.owner as Address))];
  } catch {
    return [];
  }
}

// ── injected wallet ───────────────────────────────────────────────────────────

export async function connectWallet(): Promise<{ address: Address; wallet: WalletClient } | null> {
  const eth = (window as any).ethereum;
  if (!eth) return null;
  const wallet = createWalletClient({ chain: monad, transport: custom(eth) });
  const [address] = await wallet.requestAddresses();
  try {
    await wallet.switchChain({ id: monad.id });
  } catch {
    try {
      await wallet.addChain({ chain: monad });
    } catch {
      /* user can switch manually */
    }
  }
  return { address, wallet };
}
