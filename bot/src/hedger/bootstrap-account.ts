// bootstrap-account.ts — one-shot CLI: create the on-chain Perpl exchange account.
//
// Usage:
//   HEDGER_PRIVATE_KEY=0x... MONAD_RPC_URL=... bun run hedger:bootstrap [--deposit 50]
//
// Idempotent: if getAccountByAddr() already returns a non-zero id it just prints it.
// Exchange address, collateral token, and minimum deposit all come from the public
// context (no hardcoding). The deposit amount is in human collateral units (AUSD).

import { createPublicClient, createWalletClient, erc20Abi, http, parseAbi, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { PERPL_API_URL } from "../lib/config";
import { activeChain } from "../lib/signer";

const EXCHANGE_ABI = parseAbi([
  "function createAccount(uint256 amountCNS) returns (uint256)",
  "function getAccountByAddr(address addr) view returns (uint256)",
]);

async function main(): Promise<void> {
  const pk = process.env.HEDGER_PRIVATE_KEY;
  if (!pk) {
    console.error("HEDGER_PRIVATE_KEY not set — refusing to run.");
    process.exit(1);
  }
  const depositArgIdx = process.argv.indexOf("--deposit");
  const depositHuman = depositArgIdx > 0 ? Number(process.argv[depositArgIdx + 1]) : 0;

  const account = privateKeyToAccount(pk as `0x${string}`);
  const publicClient = createPublicClient({ chain: activeChain, transport: http() });
  const walletClient = createWalletClient({ account, chain: activeChain, transport: http() });

  // Discover exchange + collateral from the public context.
  const ctxRes = await fetch(`${PERPL_API_URL}/v1/pub/context`);
  if (!ctxRes.ok) throw new Error(`context HTTP ${ctxRes.status}`);
  const ctx = (await ctxRes.json()) as {
    instances: Array<{ address: string; collateral_token_id: number; min_account_open_amount: string }>;
    tokens: Array<{ id?: number; address?: string; symbol: string; decimals: number }>;
  };
  const instance = ctx.instances[0];
  const exchange = instance.address as Address;
  const collateral = ctx.tokens.find((t) => t.id === instance.collateral_token_id);
  if (!collateral?.address) throw new Error("collateral token not found in context");
  const collateralAddr = collateral.address as Address;
  const minOpen = BigInt(instance.min_account_open_amount);
  console.log(
    `exchange=${exchange} collateral=${collateral.symbol}@${collateralAddr} (${collateral.decimals}d) ` +
      `minOpen=${Number(minOpen) / 10 ** collateral.decimals} ${collateral.symbol}`,
  );

  // Idempotency: existing account?
  const existing = await publicClient.readContract({
    address: exchange,
    abi: EXCHANGE_ABI,
    functionName: "getAccountByAddr",
    args: [account.address],
  });
  if (existing !== 0n) {
    console.log(`account already exists · PERPL_ACCOUNT_ID=${existing}`);
    return;
  }

  const amount = depositHuman > 0 ? BigInt(Math.round(depositHuman * 10 ** collateral.decimals)) : minOpen;
  if (amount < minOpen) throw new Error(`deposit below minimum (${minOpen} raw units)`);

  const balance = await publicClient.readContract({
    address: collateralAddr,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [account.address],
  });
  if (balance < amount) {
    throw new Error(
      `insufficient ${collateral.symbol}: have ${Number(balance) / 10 ** collateral.decimals}, ` +
        `need ${Number(amount) / 10 ** collateral.decimals}`,
    );
  }

  // Approve exact amount, then createAccount.
  const allowance = await publicClient.readContract({
    address: collateralAddr,
    abi: erc20Abi,
    functionName: "allowance",
    args: [account.address, exchange],
  });
  if (allowance < amount) {
    const approveHash = await walletClient.writeContract({
      address: collateralAddr,
      abi: erc20Abi,
      functionName: "approve",
      args: [exchange, amount],
    });
    await publicClient.waitForTransactionReceipt({ hash: approveHash, timeout: 60_000 });
    console.log(`approved ${Number(amount) / 10 ** collateral.decimals} ${collateral.symbol} · ${approveHash}`);
  }

  const hash = await walletClient.writeContract({
    address: exchange,
    abi: EXCHANGE_ABI,
    functionName: "createAccount",
    args: [amount],
  });
  const rcpt = await publicClient.waitForTransactionReceipt({ hash, timeout: 60_000 });
  console.log(`createAccount ${rcpt.status} · ${hash}`);

  const id = await publicClient.readContract({
    address: exchange,
    abi: EXCHANGE_ABI,
    functionName: "getAccountByAddr",
    args: [account.address],
  });
  console.log("");
  console.log(`Add to the VPS .env:`);
  console.log(`PERPL_ACCOUNT_ID=${id}`);
}

main().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
