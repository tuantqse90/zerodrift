// pnl.ts — full cost decomposition + weekly volume tally (the mPoints proxy).
// Every fill, funding accrual, and gas cost is appended to JSONL ledgers; a
// periodic snapshot row makes the running decomposition greppable:
//   net = spot PnL + perp PnL + funding − fees − gas

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import type { FillEvent } from "../lib/perpl-trade";
import { HEDGER_CONFIG } from "./config";

const DATA_DIR = HEDGER_CONFIG.dataDir;
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

/**
 * Edge captured by one fill vs the mid at fill time: a MAKER rests away from mid, so
 * a fill banks that distance (+); a TAKER crosses, paying it (−). Returns USD.
 */
export function fillSpreadUsd(px: number, sz: number, maker: boolean, midAtFill?: number): number {
  if (midAtFill == null || !(midAtFill > 0)) return 0;
  return (maker ? 1 : -1) * Math.abs(px - midAtFill) * sz;
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
  /**
   * Gross spread captured vs the mid at fill: Σ |fillPx − mid|·sz over MAKER fills
   * (a maker rests away from mid, so a fill banks that distance) minus the same for
   * TAKER fills (a taker crosses, paying it). Directional-move independent — the
   * clean measure of the quoting edge, unlike raw realized PnL.
   */
  spreadCaptureUsd = 0;
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
            this.spreadCaptureUsd += r.spreadUsd ?? 0;
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

  recordFill(f: FillEvent, mode: "paper" | "live", midAtFill?: number): void {
    const notionalUsd = f.px * f.sz;
    const week = isoWeek();
    const spreadUsd = fillSpreadUsd(f.px, f.sz, f.maker, midAtFill);
    this.perpVolumeUsd += notionalUsd;
    this.fillCount += 1;
    this.spreadCaptureUsd += spreadUsd;
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
      midAtFill,
      spreadUsd,
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
      spreadCaptureUsd: this.spreadCaptureUsd,
      perpVolumeUsd: this.perpVolumeUsd,
      fillCount: this.fillCount,
      week: isoWeek(),
      weekVolumeUsd: this.weekVolume(),
      ...extra,
    });
  }
}
