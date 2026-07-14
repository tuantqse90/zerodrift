// maker.ts — MakerWorker: keep a PostOnly order working at the best price until a
// target size is filled. The executor re-posts on lb expiry at the SAME price;
// re-PRICING (following the book) is this worker's job: cancel + re-place when the
// best price moved away and the order has been resting longer than repriceMs.

import type { PerplBook } from "../lib/perpl";
import type { FillEvent, PerplExecutor, PerpSide } from "../lib/perpl-trade";
import { HEDGER_CONFIG } from "./config";

/** Which price a maker order joins: sells rest at the ask, buys at the bid. */
function joinPrice(side: PerpSide, book: PerplBook): number {
  const sells = side === "short-open" || side === "long-close";
  return sells ? book.asks[0].px : book.bids[0].px;
}

export class MakerWorker {
  filledSz = 0;
  private intentId: string | null = null;
  private intentPx = 0;
  private placedAt = 0;
  private canceled = false;

  constructor(
    readonly side: PerpSide,
    readonly targetSz: number,
    private readonly exec: PerplExecutor,
  ) {}

  get remaining(): number {
    return Math.max(0, this.targetSz - this.filledSz);
  }

  get done(): boolean {
    return this.remaining <= 1e-9;
  }

  /** Route fills from the executor's onFill stream (matched by intent id). */
  handleFill(f: FillEvent): void {
    if (f.intentId === this.intentId) this.filledSz += f.sz;
  }

  async cancel(): Promise<void> {
    this.canceled = true;
    if (this.intentId) await this.exec.cancel(this.intentId);
    this.intentId = null;
  }

  /** Drive the worker; call every engine tick with a fresh (non-null) book. */
  async tick(book: PerplBook): Promise<void> {
    if (this.done || this.canceled || !this.exec.isReady()) return;
    const px = joinPrice(this.side, book);

    if (!this.intentId) {
      this.intentId = await this.exec.placeMaker(this.side, px, this.remaining);
      this.intentPx = px;
      this.placedAt = Date.now();
      return;
    }

    // Re-price: the book moved away from our resting price and we've waited long enough.
    const stale = Date.now() - this.placedAt > HEDGER_CONFIG.repriceMs;
    if (stale && px !== this.intentPx) {
      await this.exec.cancel(this.intentId);
      this.intentId = await this.exec.placeMaker(this.side, px, this.remaining);
      this.intentPx = px;
      this.placedAt = Date.now();
    }
  }
}
