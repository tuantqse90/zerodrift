// DriftGauge — the signature element: a spirit level for your portfolio.
// The bubble is live delta between the spot long and the perp short; a healthy
// hedge keeps it pinned on the center notch while volume accrues.

interface Props {
  spotMon: number;
  spotUsd: number;
  shortMon: number;
  shortUsd: number;
  deltaPct: number; // signed: + = net long, − = net short
  stateLabel: string;
  hasHedge: boolean;
}

const SOFT = 1;
const HARD = 3;
const RANGE = 5; // gauge full-scale = ±5% delta

export function DriftGauge({ spotMon, spotUsd, shortMon, shortUsd, deltaPct, stateLabel, hasHedge }: Props) {
  const clamped = Math.max(-RANGE, Math.min(RANGE, deltaPct));
  const leftPct = 50 + (clamped / RANGE) * 42; // keep the bubble inside the tube
  const abs = Math.abs(deltaPct);
  const tone = abs > HARD ? "hard" : abs > SOFT ? "warn" : "";

  return (
    <section className="gauge-panel" aria-label="Delta drift gauge">
      <div className="gauge-row">
        <div className="leg">
          <div className="leg-label">SPOT LONG · NULLTERMINAL</div>
          <div className="leg-main long">{hasHedge ? `${spotMon.toFixed(1)} MON` : "—"}</div>
          <div className="leg-sub">{hasHedge ? `$${spotUsd.toFixed(2)}` : "no position"}</div>
        </div>

        <div className="tube" role="img" aria-label={`Delta ${deltaPct.toFixed(2)} percent`}>
          <div className="ticks" aria-hidden="true">
            {Array.from({ length: 11 }).map((_, i) => (
              <i key={i} />
            ))}
          </div>
          <div className="notch" aria-hidden="true" />
          <div className={`bubble ${tone} ${!hasHedge ? "idle" : ""}`} style={{ left: `${leftPct}%` }} />
        </div>

        <div className="leg right">
          <div className="leg-label">PERP SHORT · PERPL</div>
          <div className="leg-main short">{hasHedge ? `${shortMon.toFixed(1)} MON` : "—"}</div>
          <div className="leg-sub">{hasHedge ? `$${shortUsd.toFixed(2)}` : "no position"}</div>
        </div>
      </div>

      <div className="gauge-caption">
        <span>
          DRIFT <span className="drift-val">{hasHedge ? `${deltaPct >= 0 ? "+" : ""}${deltaPct.toFixed(2)}%` : "0.00%"}</span>
        </span>
        <span aria-hidden="true">·</span>
        <span className="state-chip">{stateLabel}</span>
      </div>
    </section>
  );
}
