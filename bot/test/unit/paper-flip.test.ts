import { describe, expect, test } from "bun:test";
import { PaperPerplExecutor, type FillEvent } from "../../src/lib/perpl-trade";
import type { PerplBook, PerplFeed, PerplMarketInfo } from "../../src/lib/perpl";

// A two-sided MM can cross zero. The paper executor used to clamp there — the flip
// silently discarded size and realized no PnL on the netted amount. These tests pin
// the fixed behavior. (The MM quoter itself never crosses zero in one order, but the
// simulator must stay honest even if sizes race a fill.)
//
// Note: the paper taker sizes fills as notional-at-mid walked through the book, so a
// buy fills slightly under the requested size. Expectations therefore derive from the
// actual FillEvents, not from round numbers.

const MARKET = {
  id: 10,
  name: "MON",
  symbol: "MON",
  priceDecimals: 6,
  sizeDecimals: 0,
  makerFeeMicros: 90,
  takerFeeMicros: 690,
  fundingIntervalSec: 3600,
  orderTtlBlocks: 20,
  pointsBoostBps: 10_000,
} as PerplMarketInfo;

function bookAt(mid: number): PerplBook {
  return {
    bids: [{ px: mid * 0.9999, sz: 1e9 }],
    asks: [{ px: mid * 1.0001, sz: 1e9 }],
    atMs: Date.now(),
  };
}

function paperExec() {
  let cur = bookAt(1.0);
  const feed = { getBook: () => cur } as unknown as PerplFeed;
  const exec = new PaperPerplExecutor(MARKET, feed);
  const fills: FillEvent[] = [];
  exec.onFill((f) => fills.push(f));
  return {
    exec,
    fills,
    setMid: (m: number) => {
      cur = bookAt(m);
    },
  };
}

describe("paper executor cross-zero flip", () => {
  test("a long-open bigger than the short flips to a long at the fill price", async () => {
    const { exec, fills } = paperExec();
    await exec.placeTaker("short-open", 10, 50);
    const shortSz = fills[0].sz;
    expect(exec.position()).toMatchObject({ side: "short" });

    await exec.placeTaker("long-open", 25, 50);
    const flip = fills[1];
    const p = exec.position();
    expect(p.side).toBe("long");
    expect(p.sizeMon).toBeCloseTo(flip.sz - shortSz, 9); // excess beyond the netted short
    expect(p.entryPx).toBeCloseTo(flip.px, 9); // remainder opens at the fill price
  });

  test("netting down realizes PnL on the overlap (used to be silently skipped)", async () => {
    const { exec, fills, setMid } = paperExec();
    await exec.placeTaker("short-open", 100, 50);
    const short = fills[0];
    const entry = exec.position().entryPx;
    expect(entry).toBeCloseTo(short.px, 12);

    setMid(0.99); // price falls 1% → the short is in profit
    const before = exec.account()!.balanceUsd;
    await exec.placeTaker("long-open", 150, 50); // nets the short, flips long
    const after = exec.account()!.balanceUsd;
    const flip = fills[1];

    const expectedPnl = (entry - flip.px) * short.sz; // profit on the netted overlap
    expect(after - before).toBeCloseTo(expectedPnl - flip.feeUsd, 9);
    expect(exec.position().side).toBe("long");
    expect(exec.position().sizeMon).toBeCloseTo(flip.sz - short.sz, 9);
    expect(exec.position().entryPx).toBeCloseTo(flip.px, 9);
  });

  test("exact-to-zero netting lands flat with entryPx reset", async () => {
    const { exec, fills } = paperExec();
    await exec.placeTaker("long-open", 40, 50);
    const longSz = fills[0].sz;
    await exec.placeTaker("short-open", longSz, 50); // sells fill at the requested size
    expect(exec.position()).toEqual({ side: "flat", sizeMon: 0, entryPx: 0 });
  });

  test("hedge-mode paths untouched: same-side accumulate and close-clamp behave as before", async () => {
    const { exec } = paperExec();
    await exec.placeTaker("short-open", 10, 50);
    await exec.placeTaker("short-open", 10, 50);
    expect(exec.position().sizeMon).toBeCloseTo(20, 9);
    await exec.placeTaker("short-close", 25, 50); // clamp: closes only the 20 that exist
    expect(exec.position()).toEqual({ side: "flat", sizeMon: 0, entryPx: 0 });
  });
});
