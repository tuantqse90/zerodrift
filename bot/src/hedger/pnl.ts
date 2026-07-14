// pnl.ts — full cost decomposition + weekly volume tally (the mPoints proxy).
// Every fill, funding accrual, and gas cost is appended to JSONL ledgers; a
// periodic snapshot row makes the running decomposition greppable:
//   net = spot PnL + perp PnL + funding − fees − gas

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import type { FillEvent } from "../lib/perpl-trade";

const DATA_DIR = new URL("../../data/", import.meta.url).pathname;
const FILLS = `${DATA_DIR}perpl-hedger-fills.jsonl`;
const EVENTS = `${DATA_DIR}perpl-hedger.jsonl`;
const WEEKLY = `${DATA_DIR}perpl-hedger-weekly.jsonl`;

function append(file: string, row: Record<string, unknown>): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...row }) + "\n");
  } catch {
    /* best-effort */
  }
}

export function isoWeek(d = new Date()): string {
  // ISO-8601 week: Thursday determines the year.
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export class PnlLedger {
  makerFeesUsd = 0;
  takerFeesUsd = 0;
  fundingUsd = 0;
  gasUsd = 0;
  perpVolumeUsd = 0;
  fillCount = 0;
  private weekly = new Map<string, number>();

  constructor() {
    // Rebuild running totals from the fills ledger so restarts stay honest.
    try {
      const lines = readFileSync(FILLS, "utf8").trim().split("\n");
      for (const line of lines) {
        try {
          const r = JSON.parse(line);
          if (typeof r.notionalUsd === "number") {
            this.perpVolumeUsd += r.notionalUsd;
            this.weekly.set(r.week, (this.weekly.get(r.week) ?? 0) + r.notionalUsd);
            this.fillCount += 1;
            if (r.maker) this.makerFeesUsd += r.feeUsd ?? 0;
            else this.takerFeesUsd += r.feeUsd ?? 0;
          }
        } catch {
          /* skip bad row */
        }
      }
    } catch {
      /* fresh ledger */
    }
  }

  recordFill(f: FillEvent, mode: "paper" | "live"): void {
    const notionalUsd = f.px * f.sz;
    const week = isoWeek();
    this.perpVolumeUsd += notionalUsd;
    this.fillCount += 1;
    this.weekly.set(week, (this.weekly.get(week) ?? 0) + notionalUsd);
    if (f.maker) this.makerFeesUsd += f.feeUsd;
    else this.takerFeesUsd += f.feeUsd;
    append(FILLS, {
      mode,
      week,
      intentId: f.intentId,
      oid: f.oid,
      px: f.px,
      sz: f.sz,
      notionalUsd,
      feeUsd: f.feeUsd,
      maker: f.maker,
    });
    append(WEEKLY, { week, weekVolumeUsd: this.weekly.get(week) });
  }

  recordFunding(usd: number, rateMicros: number): void {
    this.fundingUsd += usd;
    append(EVENTS, { kind: "funding", usd, rateMicros });
  }

  recordGas(usd: number): void {
    this.gasUsd += usd;
  }

  event(kind: string, data: Record<string, unknown>): void {
    append(EVENTS, { kind, ...data });
  }

  weekVolume(week = isoWeek()): number {
    return this.weekly.get(week) ?? 0;
  }

  /** Decomposition snapshot. Perp/spot PnL are computed by the engine (needs marks). */
  snapshot(extra: Record<string, unknown>): void {
    append(EVENTS, {
      kind: "snapshot",
      makerFeesUsd: this.makerFeesUsd,
      takerFeesUsd: this.takerFeesUsd,
      fundingUsd: this.fundingUsd,
      gasUsd: this.gasUsd,
      perpVolumeUsd: this.perpVolumeUsd,
      fillCount: this.fillCount,
      week: isoWeek(),
      weekVolumeUsd: this.weekVolume(),
      ...extra,
    });
  }
}
