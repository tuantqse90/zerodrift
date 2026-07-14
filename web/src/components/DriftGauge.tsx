// DriftGauge — clean NT-style track: mint bubble pinned to the violet center
// notch, tinted zones for the engine's real soft/hard limits (±1% / ±3%).

interface Props {
  spotMon: number;
  spotUsd: number;
  shortMon: number;
  shortUsd: number;
  deltaPct: number;
  stateLabel: "HEDGED" | "DRIFT" | "REBAL" | "STANDBY";
  hasHedge: boolean;
}

const RANGE = 5;

function leftPct(pct: number): number {
  const clamped = Math.max(-RANGE, Math.min(RANGE, pct));
  return 50 + (clamped / RANGE) * 46;
}

export function DriftGauge({ spotMon, spotUsd, shortMon, shortUsd, deltaPct, stateLabel, hasHedge }: Props) {
  const abs = Math.abs(deltaPct);
  const tone = !hasHedge ? "idle" : abs > 3 ? "hard" : abs > 1 ? "warn" : "";
  const chipTone =
    stateLabel === "STANDBY" ? "muted" : stateLabel === "DRIFT" ? "warn" : stateLabel === "REBAL" ? "hard" : "";

  return (
    <section className="card glass" aria-label="Delta drift gauge">
      <div className="card-head">
        <span className="title">
          <i />
          Drift indicator
        </span>
        <span className="meta mono">MON delta · scale ±5%</span>
      </div>
      <p className="card-sub">Spot long minus perp short. A healthy hedge keeps the bubble on the notch.</p>

      <div className="gauge-track-wrap">
        <div className="gauge-scale mono" aria-hidden="true">
          <span>-5%</span>
          <span>-3</span>
          <span>-1</span>
          <span style={{ color: "hsl(var(--primary))", fontWeight: 600 }}>0</span>
          <span>+1</span>
          <span>+3</span>
          <span>+5%</span>
        </div>
        <div className="gauge-track" role="img" aria-label={`Delta ${deltaPct.toFixed(2)} percent`}>
          <span className="zone warn" style={{ left: `${leftPct(-3)}%`, right: `${100 - leftPct(3)}%` }} />
          <span className="zone ok" style={{ left: `${leftPct(-1)}%`, right: `${100 - leftPct(1)}%` }} />
          <span className="notch" />
          <span
            className={`bubble ${tone === "idle" ? "idle" : tone}`}
            style={{ left: `${leftPct(hasHedge ? deltaPct : 0)}%` }}
          />
        </div>
      </div>

      <div className="gauge-readout">
        <span className={`big ${tone === "hard" ? "hard" : tone === "warn" ? "warn" : ""}`}>
          {hasHedge ? `${deltaPct >= 0 ? "+" : "−"}${Math.abs(deltaPct).toFixed(2)}%` : "+0.00%"}
          <small>drift</small>
        </span>
        <span className={`state-chip ${chipTone}`}>
          {stateLabel === "STANDBY" ? "NO LIVE HEDGE" : stateLabel}
        </span>
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
