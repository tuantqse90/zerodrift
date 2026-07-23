// trend.ts — pauses churn during strong directional moves.
//
// A resting PostOnly maker only earns 0.9bps, but when MON is trending fast the
// order gets picked off by informed flow (adverse selection) — the close leg fills
// as price drops, the reopen as it rises, so each round-trip books a small negative
// edge that dwarfs the fee saved. So we sit out the trend and resume once the tape
// calms. Same hysteresis shape as the funding pause: a wide pause band, a tighter
// resume band, so we don't flicker on the boundary.

import { HEDGER_CONFIG } from "./config";

interface Sample {
  t: number;
  mid: number;
}

export interface TrendConfig {
  windowMs: number;
  pausePct: number;
  resumePct: number;
}

export class TrendMonitor {
  private buf: Sample[] = [];
  private paused = false;

  /** Churn passes nothing and inherits HEDGER_CONFIG. MM passes its OWN config: the
   * churn window (120s) only catches fast spikes, but what bled the MM was a slow
   * grind — +5.3% over 41h reached the churn threshold in only ~2.6% of 120s windows
   * vs ~27% of 30-min windows (measured on the 2026-07-22 loss). Same math, right lens. */
  constructor(private readonly cfg?: TrendConfig) {}
  private win(): number {
    return this.cfg?.windowMs ?? HEDGER_CONFIG.trendWindowMs;
  }
  private pauseAt(): number {
    return this.cfg?.pausePct ?? HEDGER_CONFIG.trendPausePct;
  }
  private resumeAt(): number {
    return this.cfg?.resumePct ?? HEDGER_CONFIG.trendResumePct;
  }

  /** Feed the latest mid once per loop tick. */
  update(mid: number, nowMs: number): void {
    if (!(mid > 0)) return;
    this.buf.push({ t: nowMs, mid });
    const cutoff = nowMs - this.win();
    while (this.buf.length > 2 && this.buf[0].t < cutoff) this.buf.shift();
  }

  /**
   * Realized volatility over the window as a fraction of price — the standard
   * deviation of successive tick-to-tick returns. Feeds the AS spread term.
   */
  realizedVolFrac(): number {
    if (this.buf.length < 3) return 0;
    const rets: number[] = [];
    for (let i = 1; i < this.buf.length; i++) {
      const prev = this.buf[i - 1].mid;
      if (prev > 0) rets.push((this.buf[i].mid - prev) / prev);
    }
    if (rets.length < 2) return 0;
    const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
    const varc = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1);
    return Math.sqrt(varc);
  }

  /** Absolute % move across the window — the directional trend strength. */
  strengthPct(): number {
    if (this.buf.length < 2) return 0;
    const first = this.buf[0].mid;
    const last = this.buf[this.buf.length - 1].mid;
    if (!(first > 0)) return 0;
    return Math.abs((last - first) / first) * 100;
  }

  /**
   * True while churn should sit out a strong trend. Holds the prior stance until the
   * window is mostly full (a single fresh sample must not read as "calm"), then
   * applies the pause/resume hysteresis.
   */
  shouldPause(nowMs: number): boolean {
    const span = this.buf.length >= 2 ? this.buf[this.buf.length - 1].t - this.buf[0].t : 0;
    if (span < this.win() * 0.6) return this.paused;
    const s = this.strengthPct();
    if (!this.paused && s > this.pauseAt()) this.paused = true;
    else if (this.paused && s < this.resumeAt()) this.paused = false;
    return this.paused;
  }
}
