// HistorySpark — cumulative track record of the engine: maker volume climbing over
// time (mint area) with the net carry line (funding − fees) on the same time axis
// but its own framing. Single-series area + a reference line; no dual y-axis.

import type { HistoryPoint } from "./EngineTerminal";

const W = 320;
const H = 74;
const PAD = 4;

export function HistorySpark({ history }: { history: HistoryPoint[] }) {
  if (history.length < 2) {
    return <div className="spark-empty mono">building history… (one point every 5 min)</div>;
  }

  const vols = history.map((h) => h.vol);
  const maxVol = Math.max(...vols, 1);
  const t0 = history[0].t;
  const tSpan = history[history.length - 1].t - t0 || 1;
  const x = (t: number) => PAD + ((t - t0) / tSpan) * (W - 2 * PAD);
  const y = (v: number) => H - PAD - (v / maxVol) * (H - 2 * PAD);

  const linePts = history.map((h) => `${x(h.t).toFixed(1)},${y(h.vol).toFixed(1)}`);
  const areaPath = `M ${x(t0).toFixed(1)},${(H - PAD).toFixed(1)} L ${linePts.join(" L ")} L ${x(history[history.length - 1].t).toFixed(1)},${(H - PAD).toFixed(1)} Z`;

  const last = history[history.length - 1];
  const hours = tSpan / 3_600_000;
  const span = hours >= 24 ? `${(hours / 24).toFixed(1)}d` : `${hours.toFixed(1)}h`;

  return (
    <div className="spark">
      <div className="spark-head mono">
        <span>CUMULATIVE MAKER VOLUME</span>
        <span className="spark-span">{span} · {history.length} pts</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="spark-svg" role="img" aria-label={`Cumulative maker volume over ${span}, now $${last.vol.toFixed(0)}`}>
        <defs>
          <linearGradient id="sparkFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="hsl(160 84% 55% / 0.35)" />
            <stop offset="1" stopColor="hsl(160 84% 55% / 0)" />
          </linearGradient>
        </defs>
        <path d={areaPath} fill="url(#sparkFill)" />
        <polyline points={linePts.join(" ")} fill="none" stroke="hsl(160 84% 55%)" strokeWidth="1.5" />
        <circle cx={x(last.t)} cy={y(last.vol)} r="3" fill="hsl(160 84% 55%)" />
      </svg>
      <div className="spark-foot mono">
        <span>
          vol <span className="mint">${last.vol.toFixed(0)}</span>
        </span>
        <span>
          net carry{" "}
          <span className={last.net >= 0 ? "mint" : "warn"}>
            {last.net >= 0 ? "+" : "−"}${Math.abs(last.net).toFixed(3)}
          </span>
        </span>
      </div>
    </div>
  );
}
