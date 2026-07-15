// avellaneda.ts — browser port of the Avellaneda-Stoikov quote math (mirrors the
// bot's src/hedger/strategies/avellaneda.ts). Pure: given mid, vol, inventory vs the
// hedge target, and tuning, returns the two-sided quote. The reservation price skews
// to mean-revert the short to target; the half-spread widens with vol but is floored
// above the maker fee so a matched bid+ask pair captures spread. Clamped to a bps band
// so a thin book can't blow it up.

export interface AvellanedaParams {
  mid: number;
  volFrac: number; // realized vol as a fraction of price
  inventoryDev: number; // short − target (MON); + = over-short
  invScale: number; // target size (MON)
  gamma: number;
  kappa: number;
  feeFrac: number; // maker fee per side (0.9bps = 0.00009)
  minHalfBps: number;
  maxHalfBps: number;
  maxSkewBps: number;
}

export interface AvellanedaQuote {
  reservationPx: number;
  bidPx: number;
  askPx: number;
  halfSpreadBps: number;
  skewBps: number;
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

export function avellanedaQuote(p: AvellanedaParams): AvellanedaQuote {
  const sig2 = p.volFrac * p.volFrac;
  const invNorm = clamp(p.invScale > 0 ? p.inventoryDev / p.invScale : 0, -1, 1);
  const skewFrac = clamp(invNorm * p.gamma * sig2, -p.maxSkewBps / 1e4, p.maxSkewBps / 1e4);
  const reservationPx = p.mid * (1 + skewFrac);

  const asSpreadFrac = p.gamma * sig2 + (2 / p.gamma) * Math.log(1 + p.gamma / p.kappa);
  const feeFloor = p.feeFrac * 1.25;
  const halfFrac = clamp(asSpreadFrac / 2, Math.max(p.minHalfBps / 1e4, feeFloor), p.maxHalfBps / 1e4);

  return {
    reservationPx,
    bidPx: reservationPx * (1 - halfFrac),
    askPx: reservationPx * (1 + halfFrac),
    halfSpreadBps: halfFrac * 1e4,
    skewBps: skewFrac * 1e4,
  };
}

/** Realized volatility (fraction of price) from a rolling buffer of mids. */
export function realizedVol(mids: number[]): number {
  if (mids.length < 3) return 0;
  const rets: number[] = [];
  for (let i = 1; i < mids.length; i++) if (mids[i - 1] > 0) rets.push((mids[i] - mids[i - 1]) / mids[i - 1]);
  if (rets.length < 2) return 0;
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const varc = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(varc);
}

/** Default AS tuning for the browser hedge (matches the live bot). */
export const AS_DEFAULTS = {
  gamma: 120,
  kappa: 1500,
  minHalfBps: 2,
  maxHalfBps: 25,
  maxSkewBps: 8,
  clipFrac: 0.02, // each quote = 2% of target
  invBandFrac: 0.015, // pull a side once the short strays this far
  repriceBps: 2, // re-quote a side only when its target price drifts this much
};
