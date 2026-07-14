// churn-policy.ts — the market-maker's brain for volume farming. Decides WHEN to
// churn and HOW BIG each clip is, to maximize boosted maker volume per unit cost.
//
// Principles (a hedge desk would recognize all four):
//  1. Funding-adaptive intensity. When shorts EARN funding, volume is nearly free
//     (0.9bps maker) AND we're paid to hold the short → churn aggressively (bigger
//     clip, shorter interval). When funding is neutral → normal. When it costs the
//     short → back off (lighter) and eventually pause.
//  2. Depth-aware clip sizing. Never post a clip larger than the touch can absorb
//     quickly — fill SPEED is volume throughput (we don't care about price; the leg
//     re-opens immediately). Cap the clip at a fraction of top-of-book size.
//  3. Funding-settlement guard. Don't leave the short reduced across a funding
//     settlement — keep the FULL short open at the boundary so it earns/pays funding
//     predictably. Skip starting a cycle inside the guard window.
//  4. Anti-sybil jitter. Randomize the clip ±15% so the flow isn't a robotic fixed
//     size (Perpl's wash-trade heuristics flag mechanical patterns).

import type { PerplBook } from "../lib/perpl";
import { HEDGER_CONFIG } from "./config";

export type ChurnIntensity =
  | "aggressive"
  | "normal"
  | "light"
  | "paused"
  | "guard"
  | "waiting"
  | "thin-book"
  | "trend";

export interface ChurnDecision {
  churn: boolean;
  clipMon: number;
  intensity: ChurnIntensity;
  reason: string;
  /** Multiplier applied to the base fraction/interval for this regime. */
  mult: number;
}

export class ChurnPolicy {
  private lastCycleAt = Date.now();

  constructor(private readonly fundingIntervalSec: number) {}

  markCycled(nowMs: number): void {
    this.lastCycleAt = nowMs;
  }

  /** Funding-regime intensity: churn hardest exactly when shorts earn the most. */
  private regime(earnApr: number): { mult: number; label: ChurnIntensity } {
    if (earnApr >= HEDGER_CONFIG.fundingBoostApr) return { mult: HEDGER_CONFIG.churnMaxFraction / HEDGER_CONFIG.churnFraction, label: "aggressive" };
    if (earnApr >= 0) return { mult: 1, label: "normal" };
    if (earnApr > -HEDGER_CONFIG.fundingPauseApr) return { mult: 0.5, label: "light" };
    return { mult: 0, label: "paused" };
  }

  /**
   * Seconds until the next funding settlement, using the funding interval as a
   * wall-clock cadence (heuristic — Perpl settles on a fixed interval). Good enough
   * to keep the full short open across the boundary.
   */
  private secToSettle(nowMs: number): number {
    const intMs = this.fundingIntervalSec * 1000;
    return (intMs - (nowMs % intMs)) / 1000;
  }

  decide(
    shortMon: number,
    book: PerplBook | null,
    earnApr: number,
    nowMs: number,
    rand: number,
    trendPaused = false,
    trendStrengthPct = 0,
  ): ChurnDecision {
    // Trend gate first: never open a fresh cycle into a fast move (adverse selection
    // would swamp the 0.9bps maker edge). An in-flight cycle still completes.
    if (trendPaused) {
      return {
        churn: false,
        clipMon: 0,
        intensity: "trend",
        reason: `market trending ${trendStrengthPct.toFixed(2)}% — sitting out adverse selection`,
        mult: 0,
      };
    }

    const { mult, label } = this.regime(earnApr);
    if (mult <= 0) {
      return { churn: false, clipMon: 0, intensity: "paused", reason: `funding costs shorts ${earnApr.toFixed(1)}% APR`, mult };
    }

    // Funding-settlement guard: keep the full short across the settlement boundary.
    if (this.secToSettle(nowMs) < HEDGER_CONFIG.fundingSettleGuardSec) {
      return { churn: false, clipMon: 0, intensity: "guard", reason: "holding full short across funding settlement", mult };
    }

    // Interval scales inversely with intensity: aggressive regime churns more often,
    // floored so we never sybil-spam. While waiting we still report the REGIME stance
    // (aggressive/normal/light) so the strategy state is always visible.
    const intervalMs = Math.max(HEDGER_CONFIG.churnMinIntervalMs, HEDGER_CONFIG.churnIntervalMs / mult);
    if (nowMs - this.lastCycleAt < intervalMs) {
      const wait = Math.ceil((intervalMs - (nowMs - this.lastCycleAt)) / 1000);
      return { churn: false, clipMon: 0, intensity: label, reason: `${label} · next clip in ${wait}s`, mult };
    }

    if (!book || shortMon <= 0) {
      return { churn: false, clipMon: 0, intensity: "thin-book", reason: "no book / no position", mult };
    }

    // Base clip from fraction × regime multiplier, jittered ±15% (anti-sybil).
    const jitter = 0.85 + rand * 0.3;
    let clip = shortMon * HEDGER_CONFIG.churnFraction * mult * jitter;
    // Hard cap as a fraction of the short (bounds delta risk during the cycle).
    clip = Math.min(clip, shortMon * HEDGER_CONFIG.churnMaxFraction);
    // Depth cap: don't post more than a fraction of the thinner touch side, so the
    // close (rests on bid) and reopen (rests on ask) both fill fast.
    const touch = Math.min(book.bids[0].sz, book.asks[0].sz);
    clip = Math.min(clip, touch * HEDGER_CONFIG.churnDepthCapPct);

    if (clip <= 0) {
      return { churn: false, clipMon: 0, intensity: "thin-book", reason: "touch too thin for a clip", mult };
    }
    return { churn: true, clipMon: clip, intensity: label, reason: `funding ${label} (${earnApr.toFixed(1)}% APR)`, mult };
  }
}
