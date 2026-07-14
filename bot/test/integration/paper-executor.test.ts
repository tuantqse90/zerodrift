// Integration test for the PAPER/LIVE seam: PaperPerplExecutor driving the full
// order lifecycle against a stub book — place a maker order, have the book cross
// it, and assert the fill flows through onFill and updates the position + balance.
// This is the exact code path the engine uses; live mode swaps the executor only.

import { describe, expect, test } from "bun:test";
import { PaperPerplExecutor, type FillEvent } from "../../src/lib/perpl-trade";
import type { PerplBook, PerplMarketInfo } from "../../src/lib/perpl";

const market = {
  id: 10,
  name: "MON",
  priceDecimals: 6,
  sizeDecimals: 0,
  makerFeeMicros: 90, // 0.9 bps
  takerFeeMicros: 690, // 6.9 bps
  fundingIntervalSec: 3600,
  orderTtlBlocks: 20,
  initialMarginFrac: 300,
  maintenanceMarginFrac: 2000,
  pointsBoostBps: 20000,
  minPostingAmount: "0",
} as PerplMarketInfo;

/** Minimal feed stub exposing just getBook(), which is all the paper executor reads. */
function stubFeed(book: PerplBook) {
  return { getBook: () => book } as any;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("PaperPerplExecutor lifecycle", () => {
  test("maker short-open fills when the book crosses, updating position + balance", async () => {
    const book: PerplBook = { bids: [{ px: 0.022, sz: 100_000 }], asks: [{ px: 0.0221, sz: 100_000 }], atMs: Date.now() };
    const exec = new PaperPerplExecutor(market, stubFeed(book), 1000);
    const fills: FillEvent[] = [];
    exec.onFill((f) => fills.push(f));
    await exec.start();

    // short-open rests on the ask; it fills once a bid reaches the posted price.
    // Post AT the current bid so the cross condition (bids[0].px >= px) holds.
    await exec.placeMaker("short-open", 0.022, 1000);
    await sleep(700); // paper tick runs every 500ms

    expect(fills.length).toBeGreaterThan(0);
    const filled = fills.reduce((s, f) => s + f.sz, 0);
    expect(filled).toBeCloseTo(1000, 3);
    expect(fills[0].maker).toBe(true);

    const pos = exec.position();
    expect(pos.side).toBe("short");
    expect(pos.sizeMon).toBeCloseTo(1000, 3);

    // maker fee = px * sz * 90µ = 0.022 * 1000 * 0.00009 ≈ $0.00198, debited from balance.
    const acct = exec.account()!;
    expect(acct.balanceUsd).toBeLessThan(1000);
    expect(acct.balanceUsd).toBeGreaterThan(999.9);
    exec.stop();
  });

  test("taker short-close reduces the position immediately", async () => {
    const book: PerplBook = { bids: [{ px: 0.022, sz: 100_000 }], asks: [{ px: 0.0221, sz: 100_000 }], atMs: Date.now() };
    const exec = new PaperPerplExecutor(market, stubFeed(book), 1000);
    await exec.start();
    // open first (maker)
    await exec.placeMaker("short-open", 0.022, 1000);
    await sleep(700);
    expect(exec.position().sizeMon).toBeCloseTo(1000, 3);

    // close half via taker — fills instantly from the book VWAP. The taker sizes by
    // notional (sizeMon × mid) and fills at the ask, so the realized base size is
    // near — not exactly — 500; assert the position roughly halved.
    await exec.placeTaker("short-close", 500, 50);
    await sleep(100);
    const remaining = exec.position().sizeMon;
    expect(remaining).toBeGreaterThan(490);
    expect(remaining).toBeLessThan(510);
    exec.stop();
  });

  test("isReady reflects book availability", async () => {
    const staleFeed = { getBook: () => null } as any;
    const exec = new PaperPerplExecutor(market, staleFeed, 1000);
    await exec.start();
    expect(exec.isReady()).toBe(false); // no book → not ready
    exec.stop();
  });
});
