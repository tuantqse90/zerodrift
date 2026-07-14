// churn.ts — volume oscillation. Every churn interval, close a fraction of the
// perp short with a PostOnly maker order, then re-open the same size — two maker
// fills of volume per cycle at ~0.9bps each, delta drift bounded by the fraction.
// Fraction is jittered ±20% so the pattern doesn't look robotic (wash-flag risk).

import type { PerplBook } from "../lib/perpl";
import type { FillEvent, PerplExecutor } from "../lib/perpl-trade";
import { HEDGER_CONFIG } from "./config";
import { MakerWorker } from "./maker";

type Phase = "idle" | "closing" | "reopening";

export class Churner {
  private phase: Phase = "idle";
  private worker: MakerWorker | null = null;
  // Seeded to "now" so the FIRST churn waits a full interval after boot/hedge —
  // opening the hedge already generated volume this cycle.
  private lastCycleAt = Date.now();
  private cycleSz = 0;
  roundTrips = 0;

  get active(): boolean {
    return this.phase !== "idle";
  }

  /**
   * MON intentionally un-hedged by the in-flight churn cycle (closed but not yet
   * re-opened). The engine subtracts this from raw delta so a normal churn never
   * trips the hard-delta guard.
   */
  pendingMon(): number {
    if (this.phase === "closing") return this.worker?.filledSz ?? 0;
    if (this.phase === "reopening") return this.cycleSz - (this.worker?.filledSz ?? 0);
    return 0;
  }

  due(): boolean {
    return Date.now() - this.lastCycleAt >= HEDGER_CONFIG.churnIntervalMs;
  }

  handleFill(f: FillEvent): void {
    this.worker?.handleFill(f);
  }

  /** Start a close→reopen cycle for a jittered fraction of the current short. */
  start(currentShortMon: number): void {
    if (this.phase !== "idle" || currentShortMon <= 0) return;
    const jitter = 0.8 + Math.random() * 0.4; // ±20%
    this.cycleSz = currentShortMon * HEDGER_CONFIG.churnFraction * jitter;
    if (this.cycleSz <= 0) return;
    this.phase = "closing";
    this.worker = null;
    this.lastCycleAt = Date.now();
  }

  async abort(): Promise<void> {
    await this.worker?.cancel();
    this.worker = null;
    this.phase = "idle";
  }

  /** Drive the cycle. Returns true when the round trip completed this tick. */
  async tick(book: PerplBook, exec: PerplExecutor): Promise<boolean> {
    if (this.phase === "idle") return false;

    if (!this.worker) {
      const side = this.phase === "closing" ? "short-close" : "short-open";
      this.worker = new MakerWorker(side, this.cycleSz, exec);
    }
    await this.worker.tick(book);

    if (this.worker.done) {
      if (this.phase === "closing") {
        this.phase = "reopening";
        this.worker = null; // next tick opens the restore leg
      } else {
        this.phase = "idle";
        this.worker = null;
        this.roundTrips += 1;
        return true;
      }
    }
    return false;
  }
}
