// mm-quoter.ts — standalone two-sided quoter: Avellaneda-Stoikov around a target
// inventory of ZERO, with signed inventory and no spot leg behind it.
//
// It deliberately does NOT reuse AvellanedaStrategy: that class is a hedge-maintainer
// (sizing, bands and side choice all hang off a positive short target). Here inventory
// is signed (+ = short, − = long) and the base size comes from notional, not a target.
//
// The one rule everything else follows from: NO ORDER MAY CROSS ZERO. A reducing side
// is always a close-type order capped at the open size; the flip to the other side
// happens on a later tick, from flat. That keeps us off two known cliffs:
//   - the paper executor's cross-zero clamp (a flip-in-one-fill diverges position()),
//   - unverified venue semantics for an Open* order that exceeds the opposite position.
//
// Sign conventions match avellanedaQuote: inventoryDev > 0 (net short) skews the
// reservation price UP, so the bid (our buy) fills more and mean-reverts us to flat.

import type { PerplBook, PerplMarketInfo } from "../../lib/perpl";
import type { PerplExecutor, PerpSide } from "../../lib/perpl-trade";
import { avellanedaQuote } from "./avellaneda";

export interface MmQuoterKnobs {
  gamma: number;
  kappa: number;
  minHalfBps: number;
  maxHalfBps: number;
  maxSkewBps: number;
  /** Re-place a resting side when its target price drifts this many bps. */
  repriceBps: number;
  /** Quote size as a fraction of baseMon. */
  clipFrac: number;
  /** Pull the growing side once |inventory| exceeds this fraction of baseMon. */
  invBandFrac: number;
  /** Clip is also capped to this fraction of top-of-book depth. */
  depthCapPct: number;
}

export interface MmTickCtx {
  book: PerplBook;
  mid: number;
  /** Signed perp inventory in MON: + = short, − = long, 0 = flat. */
  invMon: number;
  /** Sizing base in MON (notionalUsd / mid). */
  baseMon: number;
  volFrac: number;
  exec: PerplExecutor;
  market: PerplMarketInfo;
}

/** Pure side/size selection for one quote side — exported for direct unit testing.
 * `want` is the direction of the resting order: "buy" (bid) or "sell" (ask). */
export function mmSideFor(
  want: "buy" | "sell",
  invMon: number,
  clip: number,
  epsMon: number,
): { side: PerpSide; sz: number } | null {
  if (want === "buy") {
    // A buy reduces a short first; only from (effectively) flat-or-long does it open long.
    if (invMon > epsMon) return { side: "short-close", sz: Math.min(clip, invMon) };
    return { side: "long-open", sz: clip };
  }
  // A sell reduces a long first; only from flat-or-short does it open more short.
  if (invMon < -epsMon) return { side: "long-close", sz: Math.min(clip, -invMon) };
  return { side: "short-open", sz: clip };
}

interface Side {
  id: string | null;
  px: number;
  side: PerpSide | null;
  sz: number;
}

export class MmQuoter {
  private bid: Side = { id: null, px: 0, side: null, sz: 0 };
  private ask: Side = { id: null, px: 0, side: null, sz: 0 };
  private prevInv = Number.NaN;
  lastHalfBps = 0;
  lastSkewBps = 0;
  intensity = "quoting";

  constructor(private readonly k: MmQuoterKnobs) {}

  private round(px: number, pd: number): number {
    const f = 10 ** pd;
    return Math.round(px * f) / f;
  }

  async tick(ctx: MmTickCtx): Promise<void> {
    const { book, mid, invMon, baseMon, exec, market } = ctx;
    const bestBid = book.bids[0].px;
    const bestAsk = book.asks[0].px;
    const tick = 1 / 10 ** market.priceDecimals;
    const lot = 1 / 10 ** market.sizeDecimals;
    // Float-dust epsilon ONLY. It must stay below one lot: at ±1 lot of inventory the
    // reduce-first rule still applies (a 1-lot close is a valid order), otherwise both
    // sides quote opens against a real position and the never-cross-zero rule breaks.
    const epsMon = baseMon * 1e-6;

    // A fill moved inventory → both resting quotes are stale (size AND side may be
    // wrong now that the position changed); pull and re-derive from scratch.
    if (!Number.isNaN(this.prevInv) && Math.abs(invMon - this.prevInv) > 1e-9) {
      await this.pull(exec, "bid");
      await this.pull(exec, "ask");
    }
    this.prevInv = invMon;

    const q = avellanedaQuote({
      mid,
      volFrac: ctx.volFrac,
      inventoryDev: invMon,
      invScale: baseMon,
      gamma: this.k.gamma,
      kappa: this.k.kappa,
      feeFrac: market.makerFeeMicros / 1_000_000,
      minHalfBps: this.k.minHalfBps,
      maxHalfBps: this.k.maxHalfBps,
      maxSkewBps: this.k.maxSkewBps,
    });
    this.lastHalfBps = q.halfSpreadBps;
    this.lastSkewBps = q.skewBps;

    // Clip rounded DOWN to whole lots: a sub-lot size scales to a 0-size order on the
    // venue (sizeDecimals=0 markets trade in 1-MON lots). Sub-lot ⇒ treat as thin book.
    const rawClip = Math.min(
      baseMon * this.k.clipFrac,
      Math.min(book.bids[0].sz, book.asks[0].sz) * this.k.depthCapPct,
    );
    const clip = Math.floor(rawClip / lot) * lot;
    if (clip < lot || baseMon <= 0) {
      await this.pull(exec, "bid");
      await this.pull(exec, "ask");
      this.intensity = "thin-book";
      return;
    }

    // Inventory band around ZERO: pull whichever side would grow the position further.
    const band = baseMon * this.k.invBandFrac;
    const overShort = invMon > band;
    const overLong = invMon < -band;
    this.intensity = overShort ? "reducing-short" : overLong ? "reducing-long" : "quoting";

    const bidPx = this.round(Math.min(q.bidPx, bestAsk - tick), market.priceDecimals);
    const askPx = this.round(Math.max(q.askPx, bestBid + tick), market.priceDecimals);

    // Sizes go to the venue in whole lots; a plan that floors to zero is unquotable
    // this tick (e.g. sub-lot paper dust being closed) — pull rather than send size 0.
    const lotted = (p: { side: PerpSide; sz: number } | null) => {
      if (!p) return null;
      const sz = Math.floor(p.sz / lot) * lot;
      return sz >= lot ? { side: p.side, sz } : null;
    };

    // BID (buy). Growing the LONG side is what the band forbids when overLong; a bid
    // that merely closes a short is always allowed.
    const bidPlan = lotted(mmSideFor("buy", invMon, clip, epsMon));
    if (overLong || !bidPlan) await this.pull(exec, "bid");
    else await this.reconcile(exec, "bid", bidPlan.side, bidPx, bidPlan.sz);

    // ASK (sell). Growing the SHORT side is forbidden when overShort.
    const askPlan = lotted(mmSideFor("sell", invMon, clip, epsMon));
    if (overShort || !askPlan) await this.pull(exec, "ask");
    else await this.reconcile(exec, "ask", askPlan.side, askPx, askPlan.sz);
  }

  /** Cancel both quotes (rebalance / unwind / shutdown). */
  async flatten(exec: PerplExecutor): Promise<void> {
    await this.pull(exec, "bid");
    await this.pull(exec, "ask");
    this.prevInv = Number.NaN;
  }

  private sideRef(key: "bid" | "ask"): Side {
    return key === "bid" ? this.bid : this.ask;
  }

  private async pull(exec: PerplExecutor, key: "bid" | "ask"): Promise<void> {
    const s = this.sideRef(key);
    if (s.id) {
      try {
        await exec.cancel(s.id);
      } catch {
        /* already gone */
      }
      s.id = null;
      s.side = null;
    }
  }

  private async reconcile(
    exec: PerplExecutor,
    key: "bid" | "ask",
    side: PerpSide,
    desiredPx: number,
    sz: number,
  ): Promise<void> {
    const s = this.sideRef(key);
    // Heal phantoms: the venue can kill an order with no callback (PostOnly reject,
    // admin cancel, repost-storm halt). A dead id must not suppress re-placing.
    if (s.id && !exec.isLive(s.id)) {
      s.id = null;
      s.side = null;
    }
    const drifted = s.id && s.px > 0 && (Math.abs(desiredPx - s.px) / s.px) * 1e4 > this.k.repriceBps;
    // A side-type flip (short-close → long-open across zero) always re-places. Size is
    // held to a MATERIAL threshold: clip breathes with mid every tick, and an exact
    // compare here turned into a cancel/replace storm — one round-trip per loop tick —
    // which reads as order spam on the venue and forfeits queue position for nothing.
    const retyped = s.id && (s.side !== side || Math.abs(s.sz - sz) > Math.max(s.sz * 0.1, 1e-9));
    if (!s.id || drifted || retyped) {
      if (s.id) await this.pull(exec, key);
      s.id = await exec.placeMaker(side, desiredPx, sz);
      s.px = desiredPx;
      s.side = side;
      s.sz = sz;
    }
  }
}
