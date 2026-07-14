// Unit tests for the funding-adaptive churn policy — the core farming optimization.
// Deterministic: pass explicit nowMs + rand, control timing via markCycled().

import { describe, expect, test } from "bun:test";
import { ChurnPolicy } from "../../src/hedger/churn-policy";
import type { PerplBook } from "../../src/lib/perpl";

const thickBook: PerplBook = {
  bids: [{ px: 0.022, sz: 1_000_000_000 }],
  asks: [{ px: 0.0221, sz: 1_000_000_000 }],
  atMs: 0,
};
const thinBook: PerplBook = {
  bids: [{ px: 0.022, sz: 1000 }],
  asks: [{ px: 0.0221, sz: 1000 }],
  atMs: 0,
};

// A timestamp ~30 min into the funding hour → far from the settlement guard window.
const NOW_MID = 1_800_000;
// A timestamp 59 min into the hour → inside the 120s settlement guard.
const NOW_GUARD = 3_540_000;

function policy(): ChurnPolicy {
  const p = new ChurnPolicy(3600);
  p.markCycled(0); // interval has fully elapsed relative to NOW_MID/NOW_GUARD
  return p;
}

describe("ChurnPolicy funding regimes", () => {
  test("shorts earn a lot → AGGRESSIVE, ~2x fraction", () => {
    const d = policy().decide(1000, thickBook, 17.5, NOW_MID, 0.5);
    expect(d.churn).toBe(true);
    expect(d.intensity).toBe("aggressive");
    expect(d.mult).toBeCloseTo(2, 5);
    // fraction cap binds: 50% of the short (churnMaxFraction default 0.5).
    expect(d.clipMon).toBeCloseTo(500, 5);
  });

  test("neutral funding → normal, base 25%", () => {
    const d = policy().decide(1000, thickBook, 5, NOW_MID, 0.5);
    expect(d.intensity).toBe("normal");
    expect(d.mult).toBe(1);
    expect(d.clipMon).toBeCloseTo(250, 5);
  });

  test("funding costs shorts mildly → light, 0.5x", () => {
    const d = policy().decide(1000, thickBook, -3, NOW_MID, 0.5);
    expect(d.intensity).toBe("light");
    expect(d.mult).toBe(0.5);
    expect(d.clipMon).toBeCloseTo(125, 5);
  });

  test("funding costs shorts past pause threshold → PAUSED, no churn", () => {
    const d = policy().decide(1000, thickBook, -12, NOW_MID, 0.5);
    expect(d.churn).toBe(false);
    expect(d.intensity).toBe("paused");
    expect(d.clipMon).toBe(0);
  });
});

describe("ChurnPolicy safety rails", () => {
  test("depth cap: clip never exceeds half the thinner touch", () => {
    const d = policy().decide(1_000_000, thinBook, 17.5, NOW_MID, 0.5);
    // touch = 1000, depthCapPct 0.5 → 500, well below the fraction cap.
    expect(d.clipMon).toBeCloseTo(500, 5);
  });

  test("settlement guard: holds full short near funding settlement", () => {
    const d = policy().decide(1000, thickBook, 17.5, NOW_GUARD, 0.5);
    expect(d.churn).toBe(false);
    expect(d.intensity).toBe("guard");
  });

  test("interval gating: won't churn again before the interval, but still reports the regime", () => {
    const p = new ChurnPolicy(3600);
    p.markCycled(NOW_MID); // just cycled
    const d = p.decide(1000, thickBook, 17.5, NOW_MID + 1000, 0.5); // 1s later
    expect(d.churn).toBe(false);
    expect(d.intensity).toBe("aggressive"); // stance stays visible while waiting
  });

  test("no book / flat position → no churn", () => {
    expect(policy().decide(0, thickBook, 17.5, NOW_MID, 0.5).churn).toBe(false);
    expect(policy().decide(1000, null, 17.5, NOW_MID, 0.5).churn).toBe(false);
  });

  test("jitter stays within ±15% before caps", () => {
    // small short + thick book so neither cap binds; normal regime (mult 1, 25%).
    const lo = policy().decide(1000, thickBook, 5, NOW_MID, 0).clipMon; // jitter 0.85
    const hi = policy().decide(1000, thickBook, 5, NOW_MID, 1).clipMon; // jitter 1.15
    expect(lo).toBeCloseTo(212.5, 3); // 250 * 0.85
    expect(hi).toBeCloseTo(287.5, 3); // 250 * 1.15
  });
});
