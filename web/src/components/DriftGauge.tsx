// DriftGauge — a 270° radial instrument for the spot-vs-perp delta. The needle
// sweeps -5%…+5% across colored zones (green center = the engine's soft/hard
// limits ±1/±3%, amber, red). Big center readout; the two legs sit below.

interface Props {
  spotMon: number;
  spotUsd: number;
  shortMon: number;
  shortUsd: number;
  deltaPct: number;
  stateLabel: "HEDGED" | "DRIFT" | "REBAL" | "STANDBY";
  hasHedge: boolean;
}

const CX = 170;
const CY = 165;
const R = 120;
const RANGE = 5;
const START = 225; // deg, bottom-left = -5%
const SWEEP = 270; // clockwise to bottom-right = +5%

function polar(deg: number, r = R): [number, number] {
  const a = (deg * Math.PI) / 180;
  return [CX + r * Math.cos(a), CY - r * Math.sin(a)];
}
function angleFor(delta: number): number {
  const c = Math.max(-RANGE, Math.min(RANGE, delta));
  return START - ((c + RANGE) / (2 * RANGE)) * SWEEP;
}
/** Arc path from delta a to delta b (a < b), swept clockwise. */
function zonePath(a: number, b: number, r = R): string {
  const [x1, y1] = polar(angleFor(a), r);
  const [x2, y2] = polar(angleFor(b), r);
  const large = Math.abs(angleFor(a) - angleFor(b)) > 180 ? 1 : 0;
  return `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;
}

const ZONES: Array<[number, number, string]> = [
  [-5, -3, "var(--z-red)"],
  [-3, -1, "var(--z-amber)"],
  [-1, 1, "var(--z-green)"],
  [1, 3, "var(--z-amber)"],
  [3, 5, "var(--z-red)"],
];

export function DriftGauge({ spotMon, spotUsd, shortMon, shortUsd, deltaPct, stateLabel, hasHedge }: Props) {
  const abs = Math.abs(deltaPct);
  const tone = !hasHedge ? "idle" : abs > 3 ? "hard" : abs > 1 ? "warn" : "ok";
  const needleAngle = angleFor(hasHedge ? deltaPct : 0);
  const [nx, ny] = polar(needleAngle, R - 16);
  const chipTone =
    stateLabel === "STANDBY" ? "muted" : stateLabel === "DRIFT" ? "warn" : stateLabel === "REBAL" ? "hard" : "";
  const needleColor =
    tone === "hard" ? "var(--z-red)" : tone === "warn" ? "var(--z-amber)" : tone === "ok" ? "var(--z-green)" : "var(--z-dim)";

  const ticks = [-5, -3, -1, 0, 1, 3, 5];

  return (
    <section className="card glass gauge-card" aria-label="Delta drift gauge">
      <div className="card-head">
        <span className="title">
          <i />
          Drift indicator
        </span>
        <span className="meta mono">MON delta · ±5%</span>
      </div>

      <div className="radial-wrap">
        <svg viewBox="0 0 340 300" className="radial-svg" role="img" aria-label={`Delta ${deltaPct.toFixed(2)} percent`}>
          {/* track */}
          <path d={zonePath(-5, 5)} className="rg-track" />
          {/* colored zones */}
          {ZONES.map(([a, b, c], i) => {
            const active = hasHedge && deltaPct >= a && deltaPct < b + (b === 5 ? 0.001 : 0);
            return <path key={i} d={zonePath(a, b)} stroke={c} className={`rg-zone ${active ? "active" : ""}`} />;
          })}
          {/* tick labels */}
          {ticks.map((t) => {
            const [lx, ly] = polar(angleFor(t), R + 20);
            return (
              <text key={t} x={lx} y={ly + 4} textAnchor="middle" className={`rg-tick ${t === 0 ? "zero" : ""}`}>
                {t === 0 ? "0" : t > 0 ? `+${t}` : t}
              </text>
            );
          })}
          {/* needle */}
          <g className={tone === "idle" ? "rg-needle-idle" : ""} style={{ transformOrigin: `${CX}px ${CY}px` }}>
            <line x1={CX} y1={CY} x2={nx} y2={ny} stroke={needleColor} strokeWidth="3" strokeLinecap="round" style={{ transition: "all .6s cubic-bezier(.22,1,.36,1)" }} />
            <circle cx={CX} cy={CY} r="8" fill="hsl(var(--card))" stroke={needleColor} strokeWidth="2.5" />
          </g>
          {/* center readout */}
          <text x={CX} y={CY + 46} textAnchor="middle" className={`rg-value ${tone}`}>
            {hasHedge ? `${deltaPct >= 0 ? "+" : "−"}${abs.toFixed(2)}%` : "+0.00%"}
          </text>
          <text x={CX} y={CY + 66} textAnchor="middle" className="rg-sub">
            DRIFT
          </text>
        </svg>
        <span className={`state-chip radial-chip ${chipTone}`}>{stateLabel === "STANDBY" ? "NO LIVE HEDGE" : stateLabel}</span>
      </div>

      <div className="legs">
        <div className="leg-box">
          <div className="lb-k">SPOT LONG · NULLTERMINAL</div>
          <div className="lb-v long">{hasHedge ? `${spotMon.toFixed(1)} MON` : "0.0 MON"}</div>
          <div className="lb-s">{hasHedge ? `$${spotUsd.toFixed(2)}` : "standby"}</div>
        </div>
        <div className="leg-box">
          <div className="lb-k">PERP SHORT · PERPL</div>
          <div className="lb-v short">{hasHedge ? `${shortMon.toFixed(1)} MON` : "0.0 MON"}</div>
          <div className="lb-s">{hasHedge ? `$${shortUsd.toFixed(2)}` : "standby"}</div>
        </div>
      </div>
    </section>
  );
}
