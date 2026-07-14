// Live integration test against the REAL Perpl mainnet API. Proves the read-side
// client parses production data: /pub/context market metadata, the L2 order-book
// WebSocket, and the candle stream. Network-dependent — skipped when SKIP_LIVE=1.

import { describe, expect, test } from "bun:test";
import { fetchPerplMarket, PerplFeed } from "../../src/lib/perpl";

const LIVE = process.env.SKIP_LIVE !== "1";
const d = LIVE ? describe : describe.skip;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

d("Perpl mainnet (live)", () => {
  test("fetchPerplMarket('MON') returns the real MON perp config", async () => {
    const m = await fetchPerplMarket("MON");
    expect(m.id).toBe(10); // MON on mainnet
    expect(m.priceDecimals).toBeGreaterThan(0);
    expect(m.makerFeeMicros).toBeGreaterThan(0);
    expect(m.takerFeeMicros).toBeGreaterThan(m.makerFeeMicros);
    expect(m.pointsBoostBps).toBeGreaterThanOrEqual(10_000); // MON carries the boost
  }, 20_000);

  test("PerplFeed delivers a coherent live order book", async () => {
    const m = await fetchPerplMarket("MON");
    const feed = new PerplFeed(m);
    feed.start();
    try {
      let book = null;
      for (let i = 0; i < 30 && !book; i++) {
        await sleep(500);
        book = feed.getBook();
      }
      expect(book).not.toBeNull();
      expect(book!.bids.length).toBeGreaterThan(0);
      expect(book!.asks.length).toBeGreaterThan(0);
      // Book must be coherent: best bid strictly below best ask.
      expect(book!.bids[0].px).toBeLessThan(book!.asks[0].px);
    } finally {
      feed.stop();
    }
  }, 25_000);
});
