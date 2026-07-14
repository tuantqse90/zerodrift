// Unit tests for order-book VWAP math (used by taker sims + honest impact).

import { describe, expect, test } from "bun:test";
import { vwapForNotional, type PerplBook } from "../../src/lib/perpl";

const book: PerplBook = {
  bids: [
    { px: 100, sz: 1 },
    { px: 99, sz: 2 },
  ],
  asks: [
    { px: 101, sz: 1 },
    { px: 102, sz: 2 },
  ],
  atMs: 0,
};

describe("vwapForNotional", () => {
  test("sell walks the bids, VWAP between the levels", () => {
    const r = vwapForNotional(book, "sell", 150); // $100 @100 + $50 @99
    expect(r.full).toBe(true);
    expect(r.filledUsd).toBeCloseTo(150, 6);
    expect(r.avgPx).toBeLessThan(100);
    expect(r.avgPx).toBeGreaterThan(99);
  });

  test("buy lifts the asks", () => {
    const r = vwapForNotional(book, "buy", 150); // $101 @101 + $49 @102
    expect(r.full).toBe(true);
    expect(r.avgPx).toBeGreaterThan(101);
    expect(r.avgPx).toBeLessThan(102);
  });

  test("partial fill when notional exceeds depth → full=false", () => {
    const r = vwapForNotional(book, "sell", 10_000); // depth only 100 + 198 = $298
    expect(r.full).toBe(false);
    expect(r.filledUsd).toBeCloseTo(298, 6);
  });

  test("size accounting: filledSz matches USD/price weighting", () => {
    const r = vwapForNotional(book, "sell", 100); // exactly the top bid
    expect(r.filledSz).toBeCloseTo(1, 6);
    expect(r.avgPx).toBeCloseTo(100, 6);
  });
});
