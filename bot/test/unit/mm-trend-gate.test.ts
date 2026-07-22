import { describe, expect, test } from "bun:test";
import { quotingPlan, TrendGate } from "../../src/hedger/run-mm";
import type { PerplExecutor } from "../../src/lib/perpl-trade";

// The 41h live post-mortem (docs/mm-trend-guard.md): two-sided quotes in a +5.3%
// trend sold 12.4bps below buys. These tests pin the guard that sits trends out.

const K = { invBandFrac: 0.15, maxInvFrac: 0.5 };
const BASE = 1000;

describe("quotingPlan — the per-tick QUOTING decision", () => {
  test("calm + inside band → quote", () => {
    expect(quotingPlan(false, 0, BASE, K)).toBe("quote");
    expect(quotingPlan(false, 100, BASE, K)).toBe("quote");
    expect(quotingPlan(false, -400, BASE, K)).toBe("quote"); // beyond band but calm: quoter's own band handles it
  });

  test("hard cap always rebalances, trend or not", () => {
    expect(quotingPlan(false, 501, BASE, K)).toBe("rebalance");
    expect(quotingPlan(true, -501, BASE, K)).toBe("rebalance");
  });

  test("paused + inside band → hold-paused (no quotes, no rebalance)", () => {
    expect(quotingPlan(true, 0, BASE, K)).toBe("hold-paused");
    expect(quotingPlan(true, 149, BASE, K)).toBe("hold-paused");
    expect(quotingPlan(true, -149, BASE, K)).toBe("hold-paused");
  });

  test("paused + band breach → EARLY rebalance (trend is when stranded inventory bleeds fastest)", () => {
    expect(quotingPlan(true, 151, BASE, K)).toBe("rebalance");
    expect(quotingPlan(true, -151, BASE, K)).toBe("rebalance");
    // same inventory while calm would still be quoting
    expect(quotingPlan(false, 151, BASE, K)).toBe("quote");
  });

  test("degenerate base never divides or quotes", () => {
    expect(quotingPlan(false, 10, 0, K)).toBe("quote"); // loop's thin-book path handles base<=0
    expect(quotingPlan(true, 10, 0, K)).toBe("hold-paused");
  });
});

describe("TrendGate — one-shot flatten latch around the pause", () => {
  function rig() {
    let flattens = 0;
    let pauses = 0;
    let resumes = 0;
    const quoter = {
      flatten: async () => {
        flattens++;
      },
    };
    const gate = new TrendGate();
    const exec = {} as PerplExecutor;
    return {
      gate,
      quoter,
      exec,
      counts: () => ({ flattens, pauses, resumes }),
      onPause: () => pauses++,
      onResume: () => resumes++,
    };
  }

  test("entering pause flattens ONCE, then skips without touching the quoter", async () => {
    const { gate, quoter, exec, counts, onPause, onResume } = rig();
    expect(await gate.apply("hold-paused", quoter, exec, onPause, onResume)).toBe("skip");
    expect(await gate.apply("hold-paused", quoter, exec, onPause, onResume)).toBe("skip");
    expect(await gate.apply("hold-paused", quoter, exec, onPause, onResume)).toBe("skip");
    expect(counts()).toEqual({ flattens: 1, pauses: 1, resumes: 0 });
  });

  test("resume fires once and quoting restarts", async () => {
    const { gate, quoter, exec, counts, onPause, onResume } = rig();
    await gate.apply("hold-paused", quoter, exec, onPause, onResume);
    expect(await gate.apply("quote", quoter, exec, onPause, onResume)).toBe("quote");
    expect(await gate.apply("quote", quoter, exec, onPause, onResume)).toBe("quote");
    expect(counts()).toEqual({ flattens: 1, pauses: 1, resumes: 1 });
  });

  test("band breach while paused routes to rebalance and re-arms the latch", async () => {
    const { gate, quoter, exec, counts, onPause, onResume } = rig();
    await gate.apply("hold-paused", quoter, exec, onPause, onResume);
    expect(await gate.apply("rebalance", quoter, exec, onPause, onResume)).toBe("rebalance");
    // back in QUOTING later, still trending → the flatten must fire again
    expect(await gate.apply("hold-paused", quoter, exec, onPause, onResume)).toBe("skip");
    expect(counts().flattens).toBe(2);
  });

  test("calm path never flattens and never fires callbacks", async () => {
    const { gate, quoter, exec, counts, onPause, onResume } = rig();
    expect(await gate.apply("quote", quoter, exec, onPause, onResume)).toBe("quote");
    expect(counts()).toEqual({ flattens: 0, pauses: 0, resumes: 0 });
  });
});
