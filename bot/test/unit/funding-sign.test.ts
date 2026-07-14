// Unit tests for funding-sign auto-verification — the hedge-desk safety rail that
// catches an inverted funding convention before it flips the pause logic.

import { describe, expect, test } from "bun:test";
import { empiricalShortFundingSign, FundingMonitor, verifyFundingSign } from "../../src/hedger/funding";
import type { PerplFundingEvent, PerplMarketInfo } from "../../src/lib/perpl";

describe("empiricalShortFundingSign", () => {
  test("credit up → short earned (+1), down → paid (-1), flat → ambiguous (0)", () => {
    expect(empiricalShortFundingSign(0.5)).toBe(1);
    expect(empiricalShortFundingSign(-0.5)).toBe(-1);
    expect(empiricalShortFundingSign(0)).toBe(0);
  });
});

describe("verifyFundingSign", () => {
  // Default assumed sign +1: rate>0 ⇒ we think the short EARNS.
  test("earned credit at positive rate agrees with assumed +1 → ok", () => {
    expect(verifyFundingSign(+0.3, 20, 1)).toBe("ok");
  });
  test("PAID credit at a positive rate contradicts +1 → inverted", () => {
    expect(verifyFundingSign(-0.3, 20, 1)).toBe("inverted");
  });
  test("earned credit at a negative rate under +1 → inverted", () => {
    // assumed earn = +1 * sign(-rate) = -1, but we observed earning (+1) → mismatch
    expect(verifyFundingSign(+0.3, -20, 1)).toBe("inverted");
  });
  test("zero credit or zero rate → unknown (not enough signal)", () => {
    expect(verifyFundingSign(0, 20, 1)).toBe("unknown");
    expect(verifyFundingSign(0.3, 0, 1)).toBe("unknown");
  });
});

describe("FundingMonitor.observeCredit", () => {
  const market = { id: 10, fundingIntervalSec: 3600 } as PerplMarketInfo;
  const ev = (rateMicros: number): PerplFundingEvent => ({ marketId: 10, feb: 1, rateMicros, idxPx: 0, atMs: 0 });

  test("consistent credit keeps status ok and never fires onInverted", () => {
    const m = new FundingMonitor(market);
    let fired = false;
    m.onInverted = () => (fired = true);
    m.update(ev(20)); // positive rate
    m.observeCredit(+0.4); // short earned → consistent with default +1
    expect(m.signStatus).toBe("ok");
    expect(fired).toBe(false);
  });

  test("contradictory credit flips status to inverted and fires the alert", () => {
    const m = new FundingMonitor(market);
    let fired = false;
    m.onInverted = () => (fired = true);
    m.update(ev(20)); // positive rate → we assume the short earns
    m.observeCredit(-0.4); // but it PAID → inverted
    expect(m.signStatus).toBe("inverted");
    expect(fired).toBe(true);
  });

  test("no funding event yet → observeCredit is a no-op", () => {
    const m = new FundingMonitor(market);
    m.observeCredit(1);
    expect(m.signStatus).toBe("unknown");
  });
});
