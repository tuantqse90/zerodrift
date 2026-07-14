// Unit tests for the trend filter that gates churn during fast directional moves.
// Deterministic: feed explicit (mid, t) samples and read strength / pause state.
// Defaults (from config, unless overridden by env): window 120s, pause 1.0%, resume 0.4%.

import { describe, expect, test } from "bun:test";
import { TrendMonitor } from "../../src/hedger/trend";
import { HEDGER_CONFIG as CFG } from "../../src/hedger/config";

const W = CFG.trendWindowMs;

/** Fill the window with `n` evenly-spaced samples ending at `t`, moving `pct`% net. */
function fill(m: TrendMonitor, startMid: number, pct: number, t0: number, n = 12): number {
  const end = startMid * (1 + pct / 100);
  let t = t0;
  for (let i = 0; i < n; i++) {
    const mid = startMid + (end - startMid) * (i / (n - 1));
    t = t0 + (W * i) / (n - 1);
    m.update(mid, t);
  }
  return t;
}

describe("TrendMonitor strength", () => {
  test("net move across the window is measured as absolute %", () => {
    const m = new TrendMonitor();
    fill(m, 0.02, 1.5, 1_000_000);
    expect(m.strengthPct()).toBeCloseTo(1.5, 2);
  });

  test("a downward move reads the same magnitude", () => {
    const m = new TrendMonitor();
    fill(m, 0.02, -2.0, 1_000_000);
    expect(m.strengthPct()).toBeCloseTo(2.0, 2);
  });

  test("fewer than two samples → zero strength", () => {
    const m = new TrendMonitor();
    m.update(0.02, 1_000_000);
    expect(m.strengthPct()).toBe(0);
  });
});

describe("TrendMonitor pause hysteresis", () => {
  test("warming up (window not yet full) holds the un-paused stance", () => {
    const m = new TrendMonitor();
    // Only a third of the window elapsed, even with a big move → not paused yet.
    m.update(0.02, 1_000_000);
    m.update(0.0208, 1_000_000 + W * 0.3); // +4% but span < 60% window
    expect(m.shouldPause(1_000_000 + W * 0.3)).toBe(false);
  });

  test("a move past the pause band pauses churn", () => {
    const m = new TrendMonitor();
    const t = fill(m, 0.02, CFG.trendPausePct + 0.5, 1_000_000);
    expect(m.shouldPause(t)).toBe(true);
  });

  test("hysteresis: stays paused between resume and pause thresholds, releases below resume", () => {
    const m = new TrendMonitor();
    // 1) trip the pause with a strong move
    let t = fill(m, 0.02, CFG.trendPausePct + 0.6, 1_000_000);
    expect(m.shouldPause(t)).toBe(true);
    // 2) settle into the mid-band (between resume and pause) → still paused
    const mid = (CFG.trendPausePct + CFG.trendResumePct) / 2;
    t = fill(m, 0.02, mid, t + 1);
    expect(m.shouldPause(t)).toBe(true);
    // 3) calm below the resume band → released
    t = fill(m, 0.02, CFG.trendResumePct - 0.2, t + 1);
    expect(m.shouldPause(t)).toBe(false);
  });

  test("old samples fall out of the window", () => {
    const m = new TrendMonitor();
    // A big move long ago...
    fill(m, 0.02, 3.0, 1_000_000);
    // ...then a fresh flat window much later should read calm.
    const t = fill(m, 0.02, 0.0, 1_000_000 + 10 * W);
    expect(m.strengthPct()).toBeCloseTo(0, 3);
    expect(m.shouldPause(t)).toBe(false);
  });
});
