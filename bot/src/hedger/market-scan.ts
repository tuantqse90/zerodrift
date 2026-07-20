// market-scan.ts — one-shot spread/depth/funding survey of every open Perpl
// market, using the repo's own PerplFeed client. Read-only tooling: bun run scan:markets
import { fetchPerplMarket, PerplFeed, type PerplFundingEvent } from "../lib/perpl";

const NAMES = ["BTC", "MON", "ETH", "SOL", "HYPE", "ZEC"];
const SAMPLE_MS = 25_000;

const rows: Record<string, { spreads: number[]; depthBidUsd: number[]; depthAskUsd: number[]; mid: number; fundingMicros?: number; intervalSec?: number }> = {};

const feeds = await Promise.all(
  NAMES.map(async (name) => {
    const market = await fetchPerplMarket(name);
    rows[name] = { spreads: [], depthBidUsd: [], depthAskUsd: [], mid: 0 };
    const feed = new PerplFeed(market, (ev: PerplFundingEvent, mid) => {
      if (mid === market.id) {
        rows[name].fundingMicros = ev.rateMicros;
        rows[name].intervalSec = market.fundingIntervalSec;
      }
    });
    feed.start();
    return { name, feed };
  }),
);

const t0 = Date.now();
while (Date.now() - t0 < SAMPLE_MS) {
  await new Promise((r) => setTimeout(r, 1000));
  for (const { name, feed } of feeds) {
    const b = feed.getBook();
    if (!b) continue;
    const mid = (b.bids[0].px + b.asks[0].px) / 2;
    rows[name].mid = mid;
    rows[name].spreads.push(((b.asks[0].px - b.bids[0].px) / mid) * 1e4);
    rows[name].depthBidUsd.push(b.bids[0].sz * mid);
    rows[name].depthAskUsd.push(b.asks[0].sz * mid);
  }
}
for (const { feed } of feeds) feed.stop();

const med = (a: number[]) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : NaN);
console.log("market  mid          spread_bps(med)  top_bid$(med)  top_ask$(med)  funding_µ/interval  samples");
for (const name of NAMES) {
  const r = rows[name];
  console.log(
    `${name.padEnd(7)} ${String(r.mid).padEnd(12)} ${med(r.spreads).toFixed(2).padStart(10)}       ${med(r.depthBidUsd).toFixed(0).padStart(9)}      ${med(r.depthAskUsd).toFixed(0).padStart(9)}      ${String(r.fundingMicros ?? "?").padStart(8)}/${r.intervalSec ?? "?"}s   ${r.spreads.length}`,
  );
}
process.exit(0);
