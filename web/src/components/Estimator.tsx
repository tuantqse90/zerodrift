// Estimator — "what does farming actually cost?" All parameters are live: maker
// fee + points boost from Perpl's context, funding from the WS feed. mPoints
// formula is Perpl's own — boosted maker volume is the public signal we optimize.

import { useState } from "react";
import type { PerplMarketInfo } from "../lib/perplFeed";

const CYCLES: Record<number, string> = { 5: "5 min", 15: "15 min", 30: "30 min", 60: "60 min" };

export function Estimator({ market, fundingApr }: { market: PerplMarketInfo | null; fundingApr: number | null }) {
  const [notional, setNotional] = useState("1000");
  const [cycleMin, setCycleMin] = useState(15);
  const [fraction, setFraction] = useState(25);

  const n = Math.max(0, Number(notional) || 0);
  const makerBps = market ? market.makerFeeMicros / 100 : 0.9;
  const boost = market ? market.pointsBoostBps / 10_000 : 2;
  const cyclesPerWeek = (7 * 24 * 60) / cycleMin;
  // Each churn cycle closes and re-opens `fraction` of the short: two maker fills.
  const weeklyVol = n * (fraction / 100) * 2 * cyclesPerWeek;
  const boostedVol = weeklyVol * boost;
  const weeklyFees = weeklyVol * (makerBps / 10_000);
  const weeklyFunding = fundingApr !== null ? (n * (fundingApr / 100)) / 52 : 0;
  const netWeekly = weeklyFunding - weeklyFees;
  const costPerBoostedK = boostedVol > 0 ? (Math.max(0, -netWeekly) / boostedVol) * 1000 : 0;

  return (
    <div className="estimator">
      <div className="est-controls">
        <div className="field" style={{ minWidth: 160 }}>
          <label htmlFor="est-n">HEDGE NOTIONAL (USD)</label>
          <input id="est-n" value={notional} onChange={(e) => setNotional(e.target.value)} inputMode="decimal" />
        </div>
        <div className="field">
          <label>CHURN CYCLE</label>
          <div className="tf-btns">
            {Object.entries(CYCLES).map(([min, label]) => (
              <button
                key={min}
                className={cycleMin === Number(min) ? "active" : ""}
                onClick={() => setCycleMin(Number(min))}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="field">
          <label htmlFor="est-f">CHURN FRACTION · {fraction}%</label>
          <input
            id="est-f"
            type="range"
            min={10}
            max={50}
            step={5}
            value={fraction}
            onChange={(e) => setFraction(Number(e.target.value))}
          />
        </div>
      </div>

      <div className="est-grid mono">
        <div className="est-cell">
          <div className="v">${weeklyVol.toLocaleString(undefined, { maximumFractionDigits: 0 })}</div>
          <div className="k">MAKER VOLUME / WEEK</div>
        </div>
        <div className="est-cell">
          <div className="v violet">${boostedVol.toLocaleString(undefined, { maximumFractionDigits: 0 })}</div>
          <div className="k">BOOSTED VOLUME ({boost}×)</div>
        </div>
        <div className="est-cell">
          <div className="v">−${weeklyFees.toFixed(2)}</div>
          <div className="k">MAKER FEES / WEEK ({makerBps.toFixed(1)}bps)</div>
        </div>
        <div className="est-cell">
          <div className={`v ${weeklyFunding >= 0 ? "mint" : "warn"}`}>
            {weeklyFunding >= 0 ? "+" : "−"}${Math.abs(weeklyFunding).toFixed(2)}
          </div>
          <div className="k">FUNDING / WEEK ({fundingApr === null ? "—" : `${fundingApr.toFixed(1)}%`} APR)</div>
        </div>
        <div className="est-cell">
          <div className={`v ${netWeekly >= 0 ? "mint" : ""}`}>
            {netWeekly >= 0 ? "+" : "−"}${Math.abs(netWeekly).toFixed(2)}
          </div>
          <div className="k">NET CARRY / WEEK</div>
        </div>
        <div className="est-cell">
          <div className="v">{netWeekly >= 0 ? "FREE" : `$${costPerBoostedK.toFixed(3)}`}</div>
          <div className="k">COST PER $1K BOOSTED VOL</div>
        </div>
      </div>

      <p className="est-note">
        Price exposure nets to ~zero — the cost of farming is fees minus funding. mPoints allocation is Perpl's own
        formula; boosted maker volume is the public signal. Delta drift, spot-leg costs and taker rebalances add
        small extras not modeled here.
      </p>
    </div>
  );
}
