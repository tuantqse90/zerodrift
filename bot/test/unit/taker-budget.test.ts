import { describe, expect, test } from "bun:test";

/** The taker budget is the delta guard's emergency valve. Cloud instances only ever get
 * HEDGER_NOTIONAL_USD, so the default must scale with the position — a flat $25 (tuned
 * at $100) silently under-funds every hedge above ~$100. */
function defaultDailyTakerUsd(notionalUsd: number): number {
  return Math.max(25, notionalUsd * 0.25);
}

describe("daily taker budget scales with notional", () => {
  test("small hedges keep the $25 floor", () => {
    expect(defaultDailyTakerUsd(10)).toBe(25);
    expect(defaultDailyTakerUsd(100)).toBe(25); // the original tuning point
  });

  test("large hedges get a proportional valve, not a $25 stub", () => {
    expect(defaultDailyTakerUsd(500)).toBe(125);
    expect(defaultDailyTakerUsd(1200)).toBe(300);
    expect(defaultDailyTakerUsd(2000)).toBe(500); // cloud cap
  });

  test("the valve is always a quarter of the position once past the floor", () => {
    for (const n of [400, 750, 1600, 2000]) {
      expect(defaultDailyTakerUsd(n) / n).toBeCloseTo(0.25, 9);
    }
  });
});
