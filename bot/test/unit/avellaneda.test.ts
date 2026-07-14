// Unit tests for the Avellaneda-Stoikov quote math (pure, deterministic).

import { describe, expect, test } from "bun:test";
import { avellanedaQuote, type AvellanedaParams } from "../../src/hedger/strategies/avellaneda";

const base: AvellanedaParams = {
  mid: 0.02,
  volFrac: 0.003, // 0.3%
  inventoryDev: 0,
  invScale: 4500,
  gamma: 120,
  kappa: 1500,
  feeFrac: 0.00009, // 0.9bps
  minHalfBps: 2,
  maxHalfBps: 25,
  maxSkewBps: 8,
};

describe("Avellaneda quote — spread capture", () => {
  test("half-spread is floored strictly above the maker fee (eats spread)", () => {
    const q = avellanedaQuote({ ...base, volFrac: 0 }); // no vol ⇒ AS spread tiny
    // Floor = max(minHalfBps, fee*1.25) = max(2bps, 1.125bps) = 2bps.
    expect(q.halfSpreadBps).toBeGreaterThanOrEqual(2 - 1e-9);
    // A matched bid+ask pair captures (ask-bid) minus 2 fees > 0.
    const capturedBps = ((q.askPx - q.bidPx) / base.mid) * 1e4 - 2 * (base.feeFrac * 1e4);
    expect(capturedBps).toBeGreaterThan(0);
  });

  test("half-spread widens with volatility", () => {
    const calm = avellanedaQuote({ ...base, volFrac: 0.001 }).halfSpreadBps;
    const wild = avellanedaQuote({ ...base, volFrac: 0.02 }).halfSpreadBps;
    expect(wild).toBeGreaterThan(calm);
  });

  test("half-spread is capped at maxHalfBps even in extreme vol", () => {
    const q = avellanedaQuote({ ...base, volFrac: 0.5 });
    expect(q.halfSpreadBps).toBeLessThanOrEqual(base.maxHalfBps + 1e-9);
  });
});

describe("Avellaneda quote — inventory skew", () => {
  test("flat inventory ⇒ reservation at mid, symmetric quotes", () => {
    const q = avellanedaQuote(base);
    expect(q.reservationPx).toBeCloseTo(base.mid, 12);
    expect(q.skewBps).toBeCloseTo(0, 9);
    expect(base.mid - q.bidPx).toBeCloseTo(q.askPx - base.mid, 12);
  });

  test("over-short ⇒ reservation ABOVE mid (buy back more, add less)", () => {
    const q = avellanedaQuote({ ...base, inventoryDev: 450 }); // +10% over target
    expect(q.reservationPx).toBeGreaterThan(base.mid);
    expect(q.skewBps).toBeGreaterThan(0);
    // Bid sits closer to mid than the ask ⇒ buy-back fills more readily.
    expect(base.mid - q.bidPx).toBeLessThan(q.askPx - base.mid);
  });

  test("under-short ⇒ reservation BELOW mid (add short more, buy back less)", () => {
    const q = avellanedaQuote({ ...base, inventoryDev: -450 });
    expect(q.reservationPx).toBeLessThan(base.mid);
    expect(q.skewBps).toBeLessThan(0);
    expect(q.askPx - base.mid).toBeLessThan(base.mid - q.bidPx);
  });

  test("skew is clamped at maxSkewBps for extreme inventory", () => {
    const q = avellanedaQuote({ ...base, inventoryDev: 9_000, gamma: 100_000 });
    expect(q.skewBps).toBeLessThanOrEqual(base.maxSkewBps + 1e-9);
  });

  test("bid below ask always (never crossed by construction)", () => {
    for (const dev of [-900, -100, 0, 100, 900]) {
      const q = avellanedaQuote({ ...base, inventoryDev: dev });
      expect(q.bidPx).toBeLessThan(q.askPx);
    }
  });
});
