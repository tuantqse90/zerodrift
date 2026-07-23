import { describe, expect, test } from "bun:test";
import { TrendMonitor } from "../../src/hedger/trend";

// The MM guard must use its OWN long window: a slow grind that never trips the churn
// 120s window must still trip a 30-min window. This pins that the constructor override
// actually changes the verdict, and that churn's default construction is unaffected.

/** Feed a linear drift of `pctOverSpan`% across `spanMs`, one sample per stepMs. */
function drift(m: TrendMonitor, startMid: number, pctOverSpan: number, spanMs: number, stepMs: number) {
  const steps = Math.floor(spanMs / stepMs);
  for (let i = 0; i <= steps; i++) {
    const mid = startMid * (1 + (pctOverSpan / 100) * (i / steps));
    m.update(mid, i * stepMs);
  }
  return steps * stepMs;
}

describe("TrendMonitor window override", () => {
  test("a 0.8%/30min grind trips a 30-min guard but NOT a 120s guard", () => {
    // 120s guard (churn defaults via a tight override): over any 120s slice the move is
    // ~0.8% * 120s/1800s ≈ 0.053% — far below a 0.6% pause line, never pauses.
    const churnLike = new TrendMonitor({ windowMs: 120_000, pausePct: 0.6, resumePct: 0.3 });
    const t1 = drift(churnLike, 0.02, 0.8, 1_800_000, 5_000);
    expect(churnLike.shouldPause(t1)).toBe(false);

    // 30-min guard sees the full 0.8% and pauses.
    const mmLike = new TrendMonitor({ windowMs: 1_800_000, pausePct: 0.6, resumePct: 0.3 });
    const t2 = drift(mmLike, 0.02, 0.8, 1_800_000, 5_000);
    expect(mmLike.shouldPause(t2)).toBe(true);
  });

  test("hysteresis: resumes only after strength falls below the resume line", () => {
    const m = new TrendMonitor({ windowMs: 600_000, pausePct: 0.6, resumePct: 0.3 });
    let t = drift(m, 0.02, 1.0, 600_000, 5_000); // 1% over the window → paused
    expect(m.shouldPause(t)).toBe(true);
    // Now hold price flat: the window slides, strength decays. Feed flat samples until
    // the oldest drifted sample ages out and strength drops under 0.3%.
    const flat = m.strengthPct() > 0 ? 0.02 * 1.01 : 0.02;
    for (let i = 1; i <= 200; i++) {
      t += 5_000;
      m.update(flat, t);
    }
    expect(m.shouldPause(t)).toBe(false);
  });

  test("default construction (no cfg) still reads HEDGER_CONFIG — churn unchanged", () => {
    const churn = new TrendMonitor();
    // With <60% of the (120s default) window filled, it holds the prior stance (false).
    churn.update(0.02, 0);
    churn.update(0.021, 1_000);
    expect(churn.shouldPause(1_000)).toBe(false);
  });
});
