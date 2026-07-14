// Unit tests for the funding monitor — APR math, sign convention, pause hysteresis.

import { describe, expect, test } from "bun:test";
import { FundingMonitor, fundingAprPct } from "../../src/hedger/funding";
import type { PerplFundingEvent, PerplMarketInfo } from "../../src/lib/perpl";

const market = { id: 10, fundingIntervalSec: 3600 } as PerplMarketInfo;

function ev(rateMicros: number): PerplFundingEvent {
  return { marketId: 10, feb: 1, rateMicros, idxPx: 0, atMs: 0 };
}

describe("fundingAprPct", () => {
  test("+20µ/h annualizes to ~+17.52% APR", () => {
    expect(fundingAprPct(20, 3600)).toBeCloseTo(17.52, 2);
  });

  test("sign is preserved", () => {
    expect(fundingAprPct(-20, 3600)).toBeCloseTo(-17.52, 2);
    expect(fundingAprPct(0, 3600)).toBe(0);
  });
});

describe("FundingMonitor", () => {
  test("earnAprPct: rate>0 means shorts EARN (default sign +1)", () => {
    const m = new FundingMonitor(market);
    m.update(ev(20));
    expect(m.earnAprPct()).toBeCloseTo(17.52, 2);
  });

  test("ignores funding events for other markets", () => {
    const m = new FundingMonitor(market);
    m.update({ marketId: 99, feb: 1, rateMicros: 20, idxPx: 0, atMs: 0 });
    expect(m.earnAprPct()).toBe(0); // never updated
  });

  test("pause hysteresis: pause >10% pay, hold through the band, resume <5% pay", () => {
    const m = new FundingMonitor(market);
    // paying ~12% APR (rate that gives earn = -12): -12 / 0.876 ≈ -13.7µ
    m.update(ev(-13.7));
    expect(m.earnAprPct()).toBeLessThan(-10);
    expect(m.shouldPause()).toBe(true);

    // paying ~6% — inside the [resume, pause] band → stays paused
    m.update(ev(-6.85));
    expect(m.shouldPause()).toBe(true);

    // paying ~4% — below resume threshold → unpause
    m.update(ev(-4.5));
    expect(m.shouldPause()).toBe(false);
  });

  test("accrualUsd scales with notional and rate", () => {
    const m = new FundingMonitor(market);
    // 1000 MON @ $0.02 = $20 notional, rate 20µ → +$0.0004 earned by the short
    expect(m.accrualUsd(ev(20), 1000, 0.02)).toBeCloseTo(20 * (20 / 1e6), 8);
  });
});
