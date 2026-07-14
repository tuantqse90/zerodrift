// funding.ts — funding monitor with hysteresis. Convention (UNVERIFIED, env-flippable
// via HEDGER_FUNDING_SIGN): rate > 0 ⇒ longs pay shorts ⇒ our short EARNS.
// We pause churn when we'd be PAYING more than fundingPauseApr and resume below
// fundingResumeApr. Every funding event is also handed to the PnL ledger.

import type { PerplFundingEvent, PerplMarketInfo } from "../lib/perpl";
import { HEDGER_CONFIG } from "./config";

export function fundingAprPct(rateMicros: number, intervalSec: number): number {
  const perInterval = rateMicros / 1_000_000;
  return perInterval * ((365 * 24 * 3600) / intervalSec) * 100;
}

/**
 * Empirical funding sign for a SHORT, inferred from the realized funding credit at
 * a settlement. If the short's balance went UP it earned (+1); DOWN it paid (-1);
 * ~0 is ambiguous. Compared against HEDGER_FUNDING_SIGN to catch an inverted
 * convention BEFORE it flips the pause logic and bleeds funding.
 */
export function empiricalShortFundingSign(fundingCreditUsd: number, tolUsd = 1e-9): 1 | -1 | 0 {
  if (fundingCreditUsd > tolUsd) return 1;
  if (fundingCreditUsd < -tolUsd) return -1;
  return 0;
}

/**
 * Does a realized funding credit agree with the assumed sign for a given rate?
 * assumedEarn = sign * rate. If the short earned (credit>0) we expect assumedEarn>0.
 * Returns "ok" | "inverted" | "unknown".
 */
export function verifyFundingSign(
  fundingCreditUsd: number,
  rateMicros: number,
  assumedSign: 1 | -1,
): "ok" | "inverted" | "unknown" {
  const observed = empiricalShortFundingSign(fundingCreditUsd);
  if (observed === 0 || rateMicros === 0) return "unknown";
  const assumedEarn = assumedSign * Math.sign(rateMicros); // +1 if we think the short earns
  return assumedEarn === observed ? "ok" : "inverted";
}

export class FundingMonitor {
  private paused = false;
  private lastEvent: PerplFundingEvent | null = null;
  /** Empirical check of the sign convention against realized funding credits (live only). */
  signStatus: "ok" | "inverted" | "unknown" = "unknown";
  onInverted: (() => void) | null = null;

  constructor(private readonly market: PerplMarketInfo) {}

  update(ev: PerplFundingEvent): void {
    if (ev.marketId !== this.market.id) return;
    this.lastEvent = ev;
  }

  /**
   * Feed a REALIZED funding credit (from an on-chain funding settlement, live only)
   * to verify the assumed sign convention. Flips signStatus to "inverted" and fires
   * onInverted if the credit's direction contradicts what we assumed.
   */
  observeCredit(fundingCreditUsd: number): void {
    if (!this.lastEvent) return;
    const status = verifyFundingSign(fundingCreditUsd, this.lastEvent.rateMicros, HEDGER_CONFIG.fundingSign);
    if (status === "unknown") return;
    this.signStatus = status;
    if (status === "inverted") this.onInverted?.();
  }

  /** APR we EARN on the short (+) or PAY (−), under the configured sign convention. */
  earnAprPct(): number {
    if (!this.lastEvent) return 0;
    return HEDGER_CONFIG.fundingSign * fundingAprPct(this.lastEvent.rateMicros, this.market.fundingIntervalSec);
  }

  /** True while churn should be paused (hysteresis between pause/resume thresholds). */
  shouldPause(): boolean {
    const earn = this.earnAprPct();
    if (!this.paused && -earn > HEDGER_CONFIG.fundingPauseApr) this.paused = true;
    else if (this.paused && -earn < HEDGER_CONFIG.fundingResumeApr) this.paused = false;
    return this.paused;
  }

  /** USD accrued by our short position over one funding event. */
  accrualUsd(ev: PerplFundingEvent, positionMon: number, pxUsd: number): number {
    const notional = positionMon * pxUsd;
    return HEDGER_CONFIG.fundingSign * (ev.rateMicros / 1_000_000) * notional;
  }

  raw(): PerplFundingEvent | null {
    return this.lastEvent;
  }
}
