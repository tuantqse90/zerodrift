// Unit tests for the ISO-week bucketing used by the weekly-volume (points) tally.

import { describe, expect, test } from "bun:test";
import { fillSpreadUsd, isoWeek } from "../../src/hedger/pnl";

describe("isoWeek", () => {
  test("formats as YYYY-Www", () => {
    expect(isoWeek(new Date(Date.UTC(2026, 6, 14)))).toMatch(/^\d{4}-W\d{2}$/);
  });

  test("known ISO boundaries (Monday-anchored)", () => {
    // 2021-01-04 is the Monday of ISO week 2021-W01.
    expect(isoWeek(new Date(Date.UTC(2021, 0, 4)))).toBe("2021-W01");
    // 2021-01-03 (Sunday) still belongs to the previous ISO year's last week.
    expect(isoWeek(new Date(Date.UTC(2021, 0, 3)))).toBe("2020-W53");
  });

  test("same week collapses, adjacent weeks differ", () => {
    const mon = new Date(Date.UTC(2026, 6, 13));
    const sun = new Date(Date.UTC(2026, 6, 19));
    const nextMon = new Date(Date.UTC(2026, 6, 20));
    expect(isoWeek(mon)).toBe(isoWeek(sun));
    expect(isoWeek(nextMon)).not.toBe(isoWeek(mon));
  });
});

describe("fillSpreadUsd (spread capture vs mid)", () => {
  test("maker banks the distance from mid", () => {
    // Buy 100 @ 0.0224 while mid is 0.0225 → captured 0.0001·100 = $0.01.
    expect(fillSpreadUsd(0.0224, 100, true, 0.0225)).toBeCloseTo(0.01, 9);
    // Sell above mid captures the same way (absolute distance).
    expect(fillSpreadUsd(0.0226, 100, true, 0.0225)).toBeCloseTo(0.01, 9);
  });

  test("taker pays the distance (negative)", () => {
    expect(fillSpreadUsd(0.0227, 100, false, 0.0225)).toBeCloseTo(-0.02, 9);
  });

  test("no mid ⇒ zero (can't attribute edge)", () => {
    expect(fillSpreadUsd(0.0224, 100, true)).toBe(0);
    expect(fillSpreadUsd(0.0224, 100, true, 0)).toBe(0);
  });

  test("a wider maker quote captures more than a tight one (AS vs churn)", () => {
    const wide = fillSpreadUsd(0.02236, 100, true, 0.0225); // ~6bps off mid (AS)
    const tight = fillSpreadUsd(0.022489, 100, true, 0.0225); // ~0.5bps off mid (churn touch)
    expect(wide).toBeGreaterThan(tight);
  });
});
