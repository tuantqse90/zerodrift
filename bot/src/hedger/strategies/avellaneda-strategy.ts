// avellaneda-strategy.ts — the two-sided quoter that turns AS quotes into live orders.
//
// Each tick it maintains a resting BID (short-close) and ASK (short-open) around the
// AS reservation price. As the market oscillates both sides fill: it captures the
// quoted spread, and the inventory skew keeps the perp short near the hedge target.
// A hard inventory band pulls a side entirely when the short strays too far, so the
// hedge can never drift past the delta guard.

import type { PerplBook, PerplMarketInfo } from "../../lib/perpl";
import type { PerplExecutor, PerpSide } from "../../lib/perpl-trade";
import { HEDGER_CONFIG as CFG } from "../config";
import { avellanedaQuote } from "./avellaneda";

export interface AsTickCtx {
  book: PerplBook;
  mid: number;
  shortMon: number;
  targetMon: number;
  volFrac: number;
  exec: PerplExecutor;
  market: PerplMarketInfo;
}

interface Side {
  id: string | null;
  px: number;
}

export class AvellanedaStrategy {
  private bid: Side = { id: null, px: 0 };
  private ask: Side = { id: null, px: 0 };
  private prevShort = -1;
  /** Last computed quote, for status/telemetry. */
  lastHalfBps = 0;
  lastSkewBps = 0;
  intensity = "quoting";

  private round(px: number): number {
    const f = 10 ** this.market_pd;
    return Math.round(px * f) / f;
  }
  private market_pd = 0;

  async tick(ctx: AsTickCtx): Promise<void> {
    this.market_pd = ctx.market.priceDecimals;
    const { book, mid, shortMon, targetMon, exec } = ctx;
    const bestBid = book.bids[0].px;
    const bestAsk = book.asks[0].px;
    const tick = 1 / 10 ** ctx.market.priceDecimals;

    // A fill moved the position → the consumed order is stale; re-quote both fresh.
    if (this.prevShort >= 0 && Math.abs(shortMon - this.prevShort) > 1e-9) {
      await this.pull(exec, "bid");
      await this.pull(exec, "ask");
    }
    this.prevShort = shortMon;

    const q = avellanedaQuote({
      mid,
      volFrac: ctx.volFrac,
      inventoryDev: shortMon - targetMon,
      invScale: targetMon,
      gamma: CFG.asGamma,
      kappa: CFG.asKappa,
      feeFrac: ctx.market.makerFeeMicros / 1_000_000,
      minHalfBps: CFG.asMinHalfBps,
      maxHalfBps: CFG.asMaxHalfBps,
      maxSkewBps: CFG.asMaxSkewBps,
    });
    this.lastHalfBps = q.halfSpreadBps;
    this.lastSkewBps = q.skewBps;

    // Clip sized off the target, capped by top-of-book depth so both sides fill fast.
    const clip = Math.min(
      targetMon * CFG.asClipFrac,
      Math.min(book.bids[0].sz, book.asks[0].sz) * CFG.churnDepthCapPct,
    );

    // Inventory band: pull the side that would push the short further out of the hedge.
    const overShort = shortMon > targetMon * (1 + CFG.asInvBandFrac);
    const underShort = shortMon < targetMon * (1 - CFG.asInvBandFrac);

    // BID = short-close, rests at/below best ask; never cross.
    const bidPx = this.round(Math.min(q.bidPx, bestAsk - tick));
    // ASK = short-open, rests at/above best bid; never cross.
    const askPx = this.round(Math.max(q.askPx, bestBid + tick));

    if (clip <= 0) {
      await this.pull(exec, "bid");
      await this.pull(exec, "ask");
      this.intensity = "thin-book";
      return;
    }
    this.intensity = overShort ? "unwinding-inv" : underShort ? "building-inv" : "quoting";

    // Buy-back leg: skip while we're already under target (would over-flatten).
    if (underShort) await this.pull(exec, "bid");
    else await this.reconcile(exec, "bid", "short-close", bidPx, clip);

    // Add-short leg: skip while we're already over target.
    if (overShort) await this.pull(exec, "ask");
    else await this.reconcile(exec, "ask", "short-open", askPx, clip);
  }

  /** Cancel both quotes (on rebalance / pause / unwind). */
  async flatten(exec: PerplExecutor): Promise<void> {
    await this.pull(exec, "bid");
    await this.pull(exec, "ask");
    this.prevShort = -1;
  }

  private side(key: "bid" | "ask"): Side {
    return key === "bid" ? this.bid : this.ask;
  }

  private async pull(exec: PerplExecutor, key: "bid" | "ask"): Promise<void> {
    const s = this.side(key);
    if (s.id) {
      try {
        await exec.cancel(s.id);
      } catch {
        /* already gone */
      }
      s.id = null;
    }
  }

  private async reconcile(
    exec: PerplExecutor,
    key: "bid" | "ask",
    side: PerpSide,
    desiredPx: number,
    sz: number,
  ): Promise<void> {
    const s = this.side(key);
    const drifted = s.id && s.px > 0 && (Math.abs(desiredPx - s.px) / s.px) * 1e4 > CFG.asRepriceBps;
    if (!s.id || drifted) {
      if (s.id) await this.pull(exec, key);
      s.id = await exec.placeMaker(side, desiredPx, sz);
      s.px = desiredPx;
    }
  }
}
