// BookLadder — live MON-perp depth, 5 levels a side around the spread.

import type { PerplBook } from "../lib/perplFeed";

export function BookLadder({ book }: { book: PerplBook | null }) {
  if (!book) return <div className="empty">Waiting for the Perpl order book…</div>;

  const asks = book.asks.slice(0, 5).reverse();
  const bids = book.bids.slice(0, 5);
  const maxSz = Math.max(...asks.map((l) => l.sz), ...bids.map((l) => l.sz), 1);
  const spread = book.asks[0].px - book.bids[0].px;
  const spreadBps = (spread / book.bids[0].px) * 10_000;

  return (
    <div className="ladder">
      <div className="ladder-head">
        <span>PRICE</span>
        <span style={{ textAlign: "right" }}>SIZE (MON)</span>
        <span style={{ textAlign: "right" }}>TOTAL ($)</span>
      </div>
      {asks.map((l) => (
        <div className="ladder-row ask" key={`a${l.px}`}>
          <span className="depth" style={{ width: `${(l.sz / maxSz) * 100}%` }} />
          <span className="px">{l.px.toFixed(6)}</span>
          <span className="num">{l.sz.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
          <span className="num">{(l.px * l.sz).toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
        </div>
      ))}
      <div className="spread-row">
        SPREAD {spread.toFixed(6)} · {spreadBps.toFixed(2)} bps
      </div>
      {bids.map((l) => (
        <div className="ladder-row bid" key={`b${l.px}`}>
          <span className="depth" style={{ width: `${(l.sz / maxSz) * 100}%` }} />
          <span className="px">{l.px.toFixed(6)}</span>
          <span className="num">{l.sz.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
          <span className="num">{(l.px * l.sz).toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
        </div>
      ))}
    </div>
  );
}
