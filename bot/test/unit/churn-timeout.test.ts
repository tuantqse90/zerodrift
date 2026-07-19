import { describe, expect, test } from "bun:test";
import { Churner } from "../../src/hedger/churn";
import type { PerplBook } from "../../src/lib/perpl";
import type { FillEvent, PerplExecutor } from "../../src/lib/perpl-trade";

const BOOK = {
  bids: [{ px: 0.0212, sz: 10_000 }],
  asks: [{ px: 0.02121, sz: 10_000 }],
  atMs: 0,
} as unknown as PerplBook;

function fakeExec() {
  const calls = { placed: 0, canceled: 0 };
  let fillCb: ((f: FillEvent) => void) | null = null;
  const exec: PerplExecutor = {
    async start() {},
    stop() {},
    isReady: () => true,
    async placeMaker() {
      calls.placed += 1;
      return `i${calls.placed}`;
    },
    async placeTaker() {
      return "t1";
    },
    async cancel() {
      calls.canceled += 1;
    },
    async cancelAll() {},
    onFill(cb) {
      fillCb = cb;
    },
    onFundingCredit() {},
    position: () => ({ side: "short", sizeMon: 2000, entryPx: 0.0212 }),
    account: () => null,
    headBlock: () => 0,
  };
  return { exec, calls, fill: (f: Partial<FillEvent>) => fillCb?.(f as FillEvent) };
}

describe("churn leg timeout", () => {
  test("a leg that never fills aborts the cycle and reports once", async () => {
    const { exec, calls } = fakeExec();
    const c = new Churner(30); // 30ms leg timeout
    c.start(500);
    await c.tick(BOOK, exec); // places the close-leg maker
    expect(c.active).toBe(true);
    expect(c.pendingMon()).toBe(0); // closing, nothing filled yet
    await new Promise((r) => setTimeout(r, 45));
    const done = await c.tick(BOOK, exec); // timeout fires
    expect(done).toBe(false);
    expect(c.active).toBe(false); // cycle killed → pendingMon()=0 → delta guard sees raw delta
    expect(c.pendingMon()).toBe(0);
    expect(calls.canceled).toBe(1);
    expect(c.consumeTimeout()).toBe(true);
    expect(c.consumeTimeout()).toBe(false); // consumed once
    expect(c.roundTrips).toBe(0); // aborted cycles never count
  });

  test("a completing cycle stamps each leg separately and never times out", async () => {
    const { exec } = fakeExec();
    const c = new Churner(10_000);
    c.start(100);
    await c.tick(BOOK, exec); // close leg placed (intent i1)
    c.handleFill({ intentId: "i1", px: 0.0212, sz: 100, feeUsd: 0, maker: true, oid: 1, tsMs: 0 });
    await c.tick(BOOK, exec); // close done → reopening
    await c.tick(BOOK, exec); // open leg placed (intent i2)
    c.handleFill({ intentId: "i2", px: 0.02121, sz: 100, feeUsd: 0, maker: true, oid: 2, tsMs: 0 });
    const done = await c.tick(BOOK, exec);
    expect(done).toBe(true);
    expect(c.roundTrips).toBe(1);
    expect(c.consumeTimeout()).toBe(false);
  });
});
