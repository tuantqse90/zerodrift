// Unit tests for the ISO-week bucketing used by the weekly-volume (points) tally.

import { describe, expect, test } from "bun:test";
import { isoWeek } from "../../src/hedger/pnl";

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
