import { describe, expect, test } from "bun:test";
import { mmSideFor } from "../../src/hedger/strategies/mm-quoter";
import { signedInvMon } from "../../src/hedger/run-mm";

const EPS = 0.001;

describe("mmSideFor — the no-order-may-cross-zero rule", () => {
  test("net short: the bid CLOSES the short, capped at the open size", () => {
    expect(mmSideFor("buy", 5, 10, EPS)).toEqual({ side: "short-close", sz: 5 });
    expect(mmSideFor("buy", 20, 10, EPS)).toEqual({ side: "short-close", sz: 10 });
  });

  test("flat: the bid opens a long, the ask opens a short — both at full clip", () => {
    expect(mmSideFor("buy", 0, 10, EPS)).toEqual({ side: "long-open", sz: 10 });
    expect(mmSideFor("sell", 0, 10, EPS)).toEqual({ side: "short-open", sz: 10 });
  });

  test("net long: the ask CLOSES the long, capped at the open size", () => {
    expect(mmSideFor("sell", -5, 10, EPS)).toEqual({ side: "long-close", sz: 5 });
    expect(mmSideFor("sell", -20, 10, EPS)).toEqual({ side: "long-close", sz: 10 });
  });

  test("the reducing side never uses an open-type order (venue flip semantics unverified)", () => {
    for (const inv of [0.01, 1, 100]) {
      expect(mmSideFor("buy", inv, 50, EPS)!.side).toBe("short-close");
      expect(mmSideFor("sell", -inv, 50, EPS)!.side).toBe("long-close");
    }
  });

  test("the growing side keeps quoting normally on the other book side", () => {
    expect(mmSideFor("sell", 5, 10, EPS)).toEqual({ side: "short-open", sz: 10 });
    expect(mmSideFor("buy", -5, 10, EPS)).toEqual({ side: "long-open", sz: 10 });
  });

  test("dust below epsilon is treated as flat, not as a tiny close", () => {
    expect(mmSideFor("buy", EPS / 2, 10, EPS)!.side).toBe("long-open");
    expect(mmSideFor("sell", -EPS / 2, 10, EPS)!.side).toBe("short-open");
  });
});

describe("signedInvMon", () => {
  test("+ short, − long, 0 flat", () => {
    expect(signedInvMon({ side: "short", sizeMon: 7, entryPx: 1 })).toBe(7);
    expect(signedInvMon({ side: "long", sizeMon: 7, entryPx: 1 })).toBe(-7);
    expect(signedInvMon({ side: "flat", sizeMon: 0, entryPx: 0 })).toBe(0);
  });
});
