import { describe, expect, test } from "bun:test";
import { PaperPerplExecutor } from "../../src/lib/perpl-trade";
import type { PerplBook, PerplFeed, PerplMarketInfo } from "../../src/lib/perpl";
import { MmQuoter } from "../../src/hedger/strategies/mm-quoter";
import { signedInvMon } from "../../src/hedger/run-mm";

// End-to-end quoter ⇄ paper-executor cycle with a scripted book: place two-sided
// quotes, cross the bid so it fills, and verify the quoter flips its bid semantics
// (long-open from flat → short-close is never used to grow) and mean-reverts.

const MARKET = {
  id: 10,
  name: "MON",
  symbol: "MON",
  priceDecimals: 6,
  sizeDecimals: 0,
  makerFeeMicros: 90,
  takerFeeMicros: 690,
  fundingIntervalSec: 3600,
  orderTtlBlocks: 20,
  pointsBoostBps: 10_000,
} as PerplMarketInfo;

const KNOBS = {
  gamma: 20,
  kappa: 1500,
  minHalfBps: 2,
  maxHalfBps: 25,
  maxSkewBps: 8,
  repriceBps: 1.5,
  clipFrac: 0.03,
  invBandFrac: 0.15,
  depthCapPct: 0.5,
};

function bookOf(bid: number, ask: number): PerplBook {
  return { bids: [{ px: bid, sz: 1e9 }], asks: [{ px: ask, sz: 1e9 }], atMs: Date.now() };
}

function rig() {
  let cur = bookOf(0.9999, 1.0001);
  const feed = { getBook: () => cur } as unknown as PerplFeed;
  const exec = new PaperPerplExecutor(MARKET, feed);
  const quoter = new MmQuoter(KNOBS);
  return {
    exec,
    quoter,
    setBook: (bid: number, ask: number) => {
      cur = bookOf(bid, ask);
    },
    book: () => cur,
    tick: async () => {
      const mid = (cur.bids[0].px + cur.asks[0].px) / 2;
      await quoter.tick({
        book: cur,
        mid,
        invMon: signedInvMon(exec.position()),
        baseMon: 100 / mid,
        volFrac: 0,
        exec,
        market: MARKET,
      });
    },
    // The paper fill pass normally runs on exec.start()'s interval; call it directly
    // (via the private method) so the test is deterministic, no timers involved.
    settle: () => (exec as unknown as { tick: () => void }).tick(),
  };
}

describe("MmQuoter ⇄ paper executor integration", () => {
  test("quotes both sides from flat, fills the bid on a cross, flips to reduce", async () => {
    const { exec, quoter, setBook, tick, settle } = rig();

    await tick(); // flat → bid long-open, ask short-open, resting away from touch
    expect(exec.position().side).toBe("flat");

    // Crash the ask through our bid: the resting long-open bid fills.
    setBook(0.99, 0.9905);
    settle();
    const inv1 = signedInvMon(exec.position());
    expect(exec.position().side).toBe("long");
    expect(inv1).toBeLessThan(0);

    // Next tick re-derives: with a long on the book, the ASK must be a long-close
    // (reduce), never more long-open on the bid beyond the band.
    await tick();
    expect(quoter.intensity === "quoting" || quoter.intensity === "reducing-long").toBe(true);

    // Now rip the bid up through our ask: the resting reduce-side (long-close) fills
    // and the book mean-reverts toward flat — inventory magnitude must NOT grow.
    setBook(1.0105, 1.011);
    settle();
    const inv2 = signedInvMon(exec.position());
    expect(Math.abs(inv2)).toBeLessThanOrEqual(Math.abs(inv1) + 1e-9);
  });

  test("band pulls the growing side once inventory exceeds it", async () => {
    const { exec, quoter, setBook, book, tick, settle } = rig();
    // Force a big long: fill the bid repeatedly (quoter re-places after each pull).
    // The band is baseMon(mid)·frac, so evaluate the break the same way tick will.
    const bandAtCurrentMid = () => {
      const mid = (book().bids[0].px + book().asks[0].px) / 2;
      return (100 / mid) * KNOBS.invBandFrac;
    };
    for (let i = 0; i < 20; i++) {
      await tick();
      setBook(0.98 - i * 0.001, 0.9801 - i * 0.001); // keep crossing the fresh bid
      settle();
      if (-signedInvMon(exec.position()) > bandAtCurrentMid() * 1.2) break;
    }
    const inv = signedInvMon(exec.position());
    expect(inv).toBeLessThan(0);
    expect(-inv).toBeGreaterThan(bandAtCurrentMid()); // we really are beyond the band
    await tick();
    // Beyond the band the quoter must report reducing-long (bid pulled, ask reducing).
    expect(quoter.intensity).toBe("reducing-long");
  });
});
