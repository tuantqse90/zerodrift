// RecentTrades — live trade tape for the MON perp, straight from Perpl's trades
// stream. Buys mint, sells red. Fills the middle column under the book.

import { useEffect, useState } from "react";
import { TradesFeed, type PerplMarketInfo, type Trade } from "../lib/perplFeed";

export function useTrades(market: PerplMarketInfo | null): Trade[] {
  const [trades, setTrades] = useState<Trade[]>([]);
  useEffect(() => {
    if (!market) return;
    const feed = new TradesFeed(market);
    feed.onUpdate = () => setTrades([...feed.trades]);
    feed.start();
    return () => feed.stop();
  }, [market]);
  return trades;
}

function hhmmss(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}:${String(d.getUTCSeconds()).padStart(2, "0")}`;
}

export function RecentTrades({ market, trades }: { market: PerplMarketInfo | null; trades: Trade[] }) {
  if (!market || trades.length === 0) {
    return (
      <div className="ladder book-skeleton" aria-label="Loading trades">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="sk-row" style={{ animationDelay: `${i * 60}ms` }} />
        ))}
      </div>
    );
  }
  const dec = market.priceDecimals;
  return (
    <div className="tape">
      <div className="tape-head">
        <span>PRICE</span>
        <span style={{ textAlign: "right" }}>SIZE (MON)</span>
        <span style={{ textAlign: "right" }}>TIME</span>
      </div>
      {trades.slice(0, 18).map((t, i) => (
        <div className={`tape-row ${t.side}`} key={`${t.tMs}-${i}`}>
          <span className="px">{t.px.toFixed(dec)}</span>
          <span className="num">{t.sz.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
          <span className="tm">{hhmmss(t.tMs)}</span>
        </div>
      ))}
    </div>
  );
}
