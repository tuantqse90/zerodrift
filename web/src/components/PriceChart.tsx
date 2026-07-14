// PriceChart — MON-perp candlesticks straight from Perpl's candle stream.
// Up candles are HOLLOW (mint outline), down candles FILLED (red) — polarity is
// never carried by hue alone. Violet dashed line marks the live last price.
// Crosshair + OHLC tooltip on hover.

import { useEffect, useMemo, useRef, useState } from "react";
import { CandleFeed, type Candle, type PerplMarketInfo } from "../lib/perplFeed";

const W = 920;
const H = 260;
const PAD = { top: 10, right: 64, bottom: 22, left: 8 };

export function useCandles(market: PerplMarketInfo | null, resolutionSec = 900): Candle[] {
  const [candles, setCandles] = useState<Candle[]>([]);
  useEffect(() => {
    if (!market) return;
    const feed = new CandleFeed(market, resolutionSec);
    feed.onUpdate = () => setCandles([...feed.candles]);
    feed.start();
    return () => feed.stop();
  }, [market, resolutionSec]);
  return candles;
}

function fmtTime(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

export function PriceChart({ market, candles }: { market: PerplMarketInfo | null; candles: Candle[] }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);

  const view = useMemo(() => {
    if (candles.length < 2) return null;
    const lo = Math.min(...candles.map((c) => c.l));
    const hi = Math.max(...candles.map((c) => c.h));
    const padPx = (hi - lo) * 0.08 || hi * 0.001;
    const min = lo - padPx;
    const max = hi + padPx;
    const plotW = W - PAD.left - PAD.right;
    const plotH = H - PAD.top - PAD.bottom;
    const step = plotW / candles.length;
    const x = (i: number) => PAD.left + step * (i + 0.5);
    const y = (p: number) => PAD.top + plotH * (1 - (p - min) / (max - min));
    return { min, max, step, x, y, plotW, plotH };
  }, [candles]);

  if (!market || !view) {
    return <div className="empty">Waiting for Perpl candles…</div>;
  }

  const { x, y, step } = view;
  const last = candles[candles.length - 1];
  const lastUp = last.c >= last.o;
  const bodyW = Math.max(3, Math.min(9, step - 2.5));
  const yTicks = 4;
  const priceAt = (f: number) => view.min + (view.max - view.min) * f;
  const dec = market.priceDecimals;
  const hovered = hover !== null ? candles[hover] : null;

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = svgRef.current!.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const i = Math.floor((px - PAD.left) / step);
    setHover(i >= 0 && i < candles.length ? i : null);
  };

  return (
    <div style={{ position: "relative" }}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className="chart-svg"
        role="img"
        aria-label={`MON perpetual ${market.name} candlestick chart, last price ${last.c.toFixed(dec)}`}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        {/* recessive grid + right-side price labels */}
        {Array.from({ length: yTicks + 1 }, (_, i) => {
          const p = priceAt(i / yTicks);
          const yy = y(p);
          return (
            <g key={i}>
              <line x1={PAD.left} x2={W - PAD.right} y1={yy} y2={yy} className="grid-line" />
              <text x={W - PAD.right + 8} y={yy + 3.5} className="axis-label">
                {p.toFixed(dec)}
              </text>
            </g>
          );
        })}
        {/* sparse time labels */}
        {candles.map((c, i) =>
          i % 12 === 0 ? (
            <text key={c.t} x={x(i)} y={H - 6} textAnchor="middle" className="axis-label">
              {fmtTime(c.t)}
            </text>
          ) : null,
        )}

        {/* candles: hollow up / filled down */}
        {candles.map((c, i) => {
          const up = c.c >= c.o;
          const cx = x(i);
          const top = y(Math.max(c.o, c.c));
          const bot = y(Math.min(c.o, c.c));
          const h = Math.max(1.5, bot - top);
          return (
            <g key={c.t} className={up ? "candle-up" : "candle-down"} opacity={hover === null || hover === i ? 1 : 0.55}>
              <line x1={cx} x2={cx} y1={y(c.h)} y2={y(c.l)} className="wick" />
              <rect
                x={cx - bodyW / 2}
                y={top}
                width={bodyW}
                height={h}
                rx={1.5}
                className="body"
                fill={up ? "transparent" : undefined}
              />
            </g>
          );
        })}

        {/* live last-price line */}
        <line x1={PAD.left} x2={W - PAD.right} y1={y(last.c)} y2={y(last.c)} className="last-line" />
        <g transform={`translate(${W - PAD.right + 4}, ${y(last.c) - 9})`}>
          <rect width={PAD.right - 6} height={18} rx={4} className={`last-chip ${lastUp ? "up" : "down"}`} />
          <text x={(PAD.right - 6) / 2} y={12.5} textAnchor="middle" className="last-chip-text">
            {last.c.toFixed(dec)}
          </text>
        </g>

        {/* crosshair */}
        {hovered && (
          <line x1={x(hover!)} x2={x(hover!)} y1={PAD.top} y2={H - PAD.bottom} className="crosshair" />
        )}
      </svg>

      {hovered && (
        <div
          className="chart-tip mono"
          style={{ left: `${(x(hover!) / W) * 100}%`, transform: x(hover!) > W * 0.7 ? "translateX(-105%)" : "translateX(8px)" }}
        >
          <div className="tt-time">{fmtTime(hovered.t)} UTC · 15m</div>
          <div>O {hovered.o.toFixed(dec)}</div>
          <div>H {hovered.h.toFixed(dec)}</div>
          <div>L {hovered.l.toFixed(dec)}</div>
          <div className={hovered.c >= hovered.o ? "up" : "down"}>C {hovered.c.toFixed(dec)}</div>
          <div className="tt-vol">vol ${Math.round(hovered.v).toLocaleString()}</div>
        </div>
      )}

      <p className="sr-only">
        MON perpetual price over the last {candles.length} fifteen-minute candles: low{" "}
        {view.min.toFixed(dec)}, high {view.max.toFixed(dec)}, last {last.c.toFixed(dec)}.
      </p>
    </div>
  );
}
