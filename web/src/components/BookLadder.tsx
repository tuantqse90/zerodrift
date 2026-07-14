// BookLadder — live MON-perp depth around the spread. Depth bars show the
// CUMULATIVE sum from the touch outward (standard depth visualization).

import type { PerplBook } from "../lib/perplFeed";

export function BookLadder({ book, depth = 5 }: { book: PerplBook | null; depth?: number }) {
  if (!book) {
    return (
      <div className="ladder book-skeleton" aria-label="Loading order book">
        {Array.from({ length: depth * 2 + 1 }).map((_, i) => (
          <div key={i} className="sk-row" style={{ animationDelay: `${i * 60}ms` }} />
        ))}
      </div>
    );
  }

  const asksRaw = book.asks.slice(0, depth); // best → worst
  const bidsRaw = book.bids.slice(0, depth);
  let acc = 0;
  const askCum = asksRaw.map((l) => (acc += l.px * l.sz));
  acc = 0;
  const bidCum = bidsRaw.map((l) => (acc += l.px * l.sz));
  const maxCum = Math.max(askCum[askCum.length - 1] ?? 1, bidCum[bidCum.length - 1] ?? 1);
  const spread = book.asks[0].px - book.bids[0].px;
  const spreadBps = (spread / book.bids[0].px) * 10_000;

  return (
    <div className="ladder">
      <div className="ladder-head">
        <span>PRICE</span>
        <span style={{ textAlign: "right" }}>SIZE (MON)</span>
        <span style={{ textAlign: "right" }}>SUM ($)</span>
      </div>
      {asksRaw
        .map((l, i) => ({ l, cum: askCum[i] }))
        .reverse()
        .map(({ l, cum }) => (
          <div className="ladder-row ask" key={`a${l.px}`}>
            <span className="depth" style={{ width: `${(cum / maxCum) * 100}%` }} />
            <span className="px">{l.px.toFixed(6)}</span>
            <span className="num">{l.sz.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
            <span className="num sum">{Math.round(cum).toLocaleString()}</span>
          </div>
        ))}
      <div className="spread-row">
        SPREAD {spread.toFixed(6)} · {spreadBps.toFixed(2)} bps
      </div>
      {bidsRaw.map((l, i) => (
        <div className="ladder-row bid" key={`b${l.px}`}>
          <span className="depth" style={{ width: `${(bidCum[i] / maxCum) * 100}%` }} />
          <span className="px">{l.px.toFixed(6)}</span>
          <span className="num">{l.sz.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
          <span className="num sum">{Math.round(bidCum[i]).toLocaleString()}</span>
        </div>
      ))}
    </div>
  );
}
