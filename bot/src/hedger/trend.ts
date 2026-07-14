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

export class TrendMonitor {
  private buf: Sample[] = [];
  private paused = false;

  /** Feed the latest mid once per loop tick. */
  update(mid: number, nowMs: number): void {
    if (!(mid > 0)) return;
    this.buf.push({ t: nowMs, mid });
    const cutoff = nowMs - HEDGER_CONFIG.trendWindowMs;
    while (this.buf.length > 2 && this.buf[0].t < cutoff) this.buf.shift();
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
    if (span < HEDGER_CONFIG.trendWindowMs * 0.6) return this.paused;
    const s = this.strengthPct();
    if (!this.paused && s > HEDGER_CONFIG.trendPausePct) this.paused = true;
    else if (this.paused && s < HEDGER_CONFIG.trendResumePct) this.paused = false;
    return this.paused;
  }
}
