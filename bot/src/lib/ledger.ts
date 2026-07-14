// ledger.ts — append-only JSONL of every (paper|live) opportunity + running PnL.
//
// One file per bot at packages/bots/data/<botName>.jsonl. `logOpportunity` picks
// the file from entry.bot. Synchronous appends keep the call site simple (void).

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// import.meta.dir = .../packages/bots/src/lib  ->  data dir = .../packages/bots/data
const DATA_DIR = join(import.meta.dir, "..", "..", "data");

function ledgerPath(botName: string): string {
  return join(DATA_DIR, `${botName}.jsonl`);
}

function ensureDir(): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

/**
 * Append one opportunity as a JSON line. The target file is chosen from
 * `entry.bot` (a string), falling back to "unknown". A `ts` ISO timestamp is
 * added if the entry doesn't already carry one.
 */
export function logOpportunity(entry: Record<string, unknown>): void {
  ensureDir();
  const botName = typeof entry.bot === "string" && entry.bot.length > 0 ? entry.bot : "unknown";
  const withTs = "ts" in entry ? entry : { ts: new Date().toISOString(), ...entry };
  appendFileSync(ledgerPath(botName), JSON.stringify(withTs) + "\n");
}

export interface PnlSummary {
  count: number;
  grossUsd: number;
  feesUsd: number;
  netUsd: number;
}

function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Read a bot's ledger back and sum gross/fees/net across all logged opportunities. */
export function pnlSummary(botName: string): PnlSummary {
  const path = ledgerPath(botName);
  const acc: PnlSummary = { count: 0, grossUsd: 0, feesUsd: 0, netUsd: 0 };
  if (!existsSync(path)) return acc;

  const text = readFileSync(path, "utf8");
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const row = JSON.parse(trimmed) as Record<string, unknown>;
      // Skip non-opportunity records (e.g. grad-sniper's realized post-grad price
      // paths) — they carry no gross/fees/net and must not inflate the count.
      if (typeof row.kind === "string" && row.kind !== "opportunity") continue;
      acc.count += 1;
      acc.grossUsd += num(row.grossUsd);
      acc.feesUsd += num(row.feesUsd);
      acc.netUsd += num(row.netUsd);
    } catch {
      // Skip malformed lines rather than crash the summary.
    }
  }
  return acc;
}
