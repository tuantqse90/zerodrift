// avellaneda.ts — Avellaneda-Stoikov optimal market-making quotes, retargeted for a
// hedged perp inventory on a thin market.
//
// Classic AS (2008) gives, for inventory q and vol σ:
//   reservation price  r = s − q·γ·σ²          (skews quotes to mean-revert inventory)
//   optimal spread     Δ = γ·σ² + (2/γ)·ln(1 + γ/κ)
// and you quote r ± Δ/2. We keep both mechanisms — inventory skew + vol-scaled spread —
// but with three adaptations for ZeroDrift:
//   1. Inventory is measured as a DEVIATION from the hedge target, not from flat: q =
//      (short − target). Being over-short skews the reservation UP so the bid (buy-back)
//      fills more and the ask (add-short) fills less — pulling the perp back to target.
//   2. We PAY 0.9bps maker (no rebate), so the half-spread is floored strictly above the
//      per-side fee: every matched bid+ask pair then captures 2·(half − fee)·mid > 0.
//      That is the "eat the spread" objective — profit, with points as a byproduct.
//   3. κ is near-impossible to calibrate on thin Monad flow, so the AS spread is clamped
//      into an interpretable [minHalf, maxHalf] bps band. The formula supplies the
//      adaptive SHAPE (widen on vol, skew on inventory); the band supplies robustness.

export interface AvellanedaParams {
  mid: number;
  /** Realized volatility over the estimation window, as a fraction of price (e.g. 0.002 = 0.2%). */
  volFrac: number;
  /** Perp inventory deviation from the hedge target, in MON (+ = over-short). */
  inventoryDev: number;
  /** Normaliser for the deviation (the hedge target size, MON). */
  invScale: number;
  /** Risk aversion (dimensionless): higher ⇒ tighter inventory control + wider spread. */
  gamma: number;
  /** Order-book intensity (dimensionless): higher ⇒ tighter optimal spread. */
  kappa: number;
  /** Maker fee per side as a fraction (0.9bps = 0.00009). Half-spread is floored above it. */
  feeFrac: number;
  /** Half-spread clamp (bps). */
  minHalfBps: number;
  maxHalfBps: number;
  /** Inventory-skew clamp (bps) on the reservation price. */
  maxSkewBps: number;
}

export interface AvellanedaQuote {
  reservationPx: number;
  bidPx: number;
  askPx: number;
  halfSpreadBps: number;
  skewBps: number;
}

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

/**
 * Compute the two-sided AS quote. bidPx is where we rest a buy (short-close), askPx a
 * sell (short-open). No book cross-guard here — the caller clamps against the live touch.
 */
export function avellanedaQuote(p: AvellanedaParams): AvellanedaQuote {
  const sig2 = p.volFrac * p.volFrac;

  // Inventory skew (fractional): q̃·γ·σ², clamped. Over-short (+) ⇒ reservation up.
  const invNorm = clamp(p.invScale > 0 ? p.inventoryDev / p.invScale : 0, -1, 1);
  const rawSkew = invNorm * p.gamma * sig2;
  const skewFrac = clamp(rawSkew, -p.maxSkewBps / 1e4, p.maxSkewBps / 1e4);
  const reservationPx = p.mid * (1 + skewFrac);

  // Optimal half-spread (fractional), clamped and floored strictly above the fee so a
  // matched pair captures spread rather than bleeding it.
  const asSpreadFrac = p.gamma * sig2 + (2 / p.gamma) * Math.log(1 + p.gamma / p.kappa);
  const feeFloor = p.feeFrac * 1.25; // 25% margin over the per-side fee
  const halfFrac = clamp(
    asSpreadFrac / 2,
    Math.max(p.minHalfBps / 1e4, feeFloor),
    p.maxHalfBps / 1e4,
  );

  return {
    reservationPx,
    bidPx: reservationPx * (1 - halfFrac),
    askPx: reservationPx * (1 + halfFrac),
    halfSpreadBps: halfFrac * 1e4,
    skewBps: skewFrac * 1e4,
  };
}
