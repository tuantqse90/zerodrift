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

export class FundingMonitor {
  private paused = false;
  private lastEvent: PerplFundingEvent | null = null;

  constructor(private readonly market: PerplMarketInfo) {}

  update(ev: PerplFundingEvent): void {
    if (ev.marketId !== this.market.id) return;
    this.lastEvent = ev;
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
