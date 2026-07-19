// churn.ts — volume oscillation mechanism. Closes a clip of the perp short with a
// PostOnly maker order, then re-opens the same size — two maker fills of volume per
// cycle at ~0.9bps each. The clip SIZE and TIMING are decided by ChurnPolicy (the
// funding-adaptive, depth-aware market-maker brain); this class just executes it.

import type { PerplBook } from "../lib/perpl";
import type { FillEvent, PerplExecutor } from "../lib/perpl-trade";
import { HEDGER_CONFIG } from "./config";
import { MakerWorker } from "./maker";

type Phase = "idle" | "closing" | "reopening";

export class Churner {
  private phase: Phase = "idle";
  private worker: MakerWorker | null = null;
  private cycleSz = 0;
  private legStartedAt = 0;
  private timedOut = false;
  roundTrips = 0;
  /** Cumulative maker notional churned (USD), for realized efficiency telemetry. */
  churnedVolumeUsd = 0;

  constructor(private readonly legTimeoutMs: number = HEDGER_CONFIG.churnLegTimeoutMs) {}

  /** True once (consumed) if the last cycle was killed by the leg timeout. */
  consumeTimeout(): boolean {
    const t = this.timedOut;
    this.timedOut = false;
    return t;
  }

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

  handleFill(f: FillEvent): void {
    this.worker?.handleFill(f);
    // Every maker fill during a churn cycle is booked as churned volume.
    if (this.phase !== "idle") this.churnedVolumeUsd += f.px * f.sz;
  }

  /** Start a close→reopen cycle for the policy-decided clip (jitter already applied). */
  start(clipMon: number): void {
    if (this.phase !== "idle" || clipMon <= 0) return;
    this.cycleSz = clipMon;
    this.phase = "closing";
    this.worker = null;
  }

  async abort(): Promise<void> {
    await this.worker?.cancel();
    this.worker = null;
    this.phase = "idle";
    this.legStartedAt = 0;
  }

  /** Drive the cycle. Returns true when the round trip completed this tick. */
  async tick(book: PerplBook, exec: PerplExecutor): Promise<boolean> {
    if (this.phase === "idle") return false;

    // A leg that can't complete (e.g. a re-open ask chasing a falling market) must
    // not hold the intentional delta gap open forever: kill the cycle and let the
    // engine's delta guard restore the hedge through its usual maker/taker path.
    if (this.legStartedAt > 0 && Date.now() - this.legStartedAt > this.legTimeoutMs) {
      await this.abort();
      this.timedOut = true;
      return false;
    }

    if (!this.worker) {
      const side = this.phase === "closing" ? "short-close" : "short-open";
      this.worker = new MakerWorker(side, this.cycleSz, exec);
      this.legStartedAt = Date.now();
    }
    await this.worker.tick(book);

    if (this.worker.done) {
      if (this.phase === "closing") {
        this.phase = "reopening";
        this.worker = null; // next tick opens the restore leg
        this.legStartedAt = 0; // each leg gets its own timeout budget
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
