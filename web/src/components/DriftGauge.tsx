// DriftGauge — the instrument. A graduated spirit level: engraved percent scale,
// marked operating zones (green |δ|≤1, amber ≤3, red beyond — the engine's real
// soft/hard limits), a glass tube, and a bubble that reads live delta.

interface Props {
  spotMon: number;
  spotUsd: number;
  shortMon: number;
  shortUsd: number;
  deltaPct: number;
  stateLabel: "HEDGED" | "DRIFT" | "REBAL" | "STANDBY";
  hasHedge: boolean;
}

const RANGE = 5; // full scale ±5%
const X0 = 60;
const X1 = 940;

function xAt(pct: number): number {
  const clamped = Math.max(-RANGE, Math.min(RANGE, pct));
  return X0 + ((clamped + RANGE) / (2 * RANGE)) * (X1 - X0);
}

export function DriftGauge({ spotMon, spotUsd, shortMon, shortUsd, deltaPct, stateLabel, hasHedge }: Props) {
  const abs = Math.abs(deltaPct);
  const tone = !hasHedge ? "idle" : abs > 3 ? "red" : abs > 1 ? "amber" : "green";
  const bubbleX = xAt(hasHedge ? deltaPct : 0);

  const majors = Array.from({ length: 11 }, (_, i) => i - 5);
  const minors = Array.from({ length: 21 }, (_, i) => (i - 10) / 2).filter((v) => v % 1 !== 0);

  const bubbleFill = tone === "red" ? "url(#bubR)" : tone === "amber" ? "url(#bubA)" : "url(#bubG)";
  const glow =
    tone === "red" ? "rgba(255,107,126,.55)" : tone === "amber" ? "rgba(255,180,84,.55)" : "rgba(94,225,162,.55)";

  return (
    <section className="instrument" aria-label="Delta drift gauge">
      <div className="inst-head">
        <span className="inst-title">DRIFT INDICATOR · MON DELTA · FULL SCALE ±5%</span>
        <div className="inst-lamps" role="status">
          <span className={`lamp ${stateLabel === "HEDGED" ? "on" : ""}`}>
            <i />
            HEDGED
          </span>
          <span className={`lamp ${stateLabel === "DRIFT" ? "on warn" : ""}`}>
            <i />
            DRIFT
          </span>
          <span className={`lamp ${stateLabel === "REBAL" ? "on err" : ""}`}>
            <i />
            REBAL
          </span>
        </div>
      </div>

      <div className="gauge-grid">
        <div className="leg">
          <div className="leg-label">SPOT LONG · NULLTERMINAL</div>
          <div className="leg-main long">{hasHedge ? spotMon.toFixed(1) : "———"}</div>
          <div className="leg-sub">{hasHedge ? `MON · $${spotUsd.toFixed(2)}` : "MON · standby"}</div>
        </div>

        <div className="tube-cell">
          <svg className="gauge-svg" viewBox="0 0 1000 138" role="img" aria-label={`Delta ${deltaPct.toFixed(2)} percent`}>
            <defs>
              <linearGradient id="tubeGlass" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="#05070a" />
                <stop offset="0.45" stopColor="#0c0f14" />
                <stop offset="1" stopColor="#070a0e" />
              </linearGradient>
              <linearGradient id="tubeShine" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="rgba(255,255,255,.14)" />
                <stop offset="1" stopColor="rgba(255,255,255,0)" />
              </linearGradient>
              <radialGradient id="bubG" cx="0.36" cy="0.3" r="0.9">
                <stop offset="0" stopColor="#eafff4" />
                <stop offset="0.35" stopColor="#5ee1a2" />
                <stop offset="1" stopColor="rgba(94,225,162,.12)" />
              </radialGradient>
              <radialGradient id="bubA" cx="0.36" cy="0.3" r="0.9">
                <stop offset="0" stopColor="#fff4e2" />
                <stop offset="0.35" stopColor="#ffb454" />
                <stop offset="1" stopColor="rgba(255,180,84,.12)" />
              </radialGradient>
              <radialGradient id="bubR" cx="0.36" cy="0.3" r="0.9">
                <stop offset="0" stopColor="#ffe9ec" />
                <stop offset="0.35" stopColor="#ff6b7e" />
                <stop offset="1" stopColor="rgba(255,107,126,.14)" />
              </radialGradient>
            </defs>

            {/* engraved scale numbers + ticks */}
            {majors.map((m) => (
              <g key={m}>
                <text
                  x={xAt(m)}
                  y={13}
                  textAnchor="middle"
                  fontFamily="IBM Plex Mono, monospace"
                  fontSize="11"
                  fill={m === 0 ? "#99a1b3" : "#5c6373"}
                  fontWeight={m === 0 ? 600 : 400}
                >
                  {m === 0 ? "0" : m > 0 ? `+${m}` : m}
                </text>
                <line x1={xAt(m)} y1={20} x2={xAt(m)} y2={34} stroke={m === 0 ? "#99a1b3" : "#3d4350"} strokeWidth={m === 0 ? 2 : 1.2} />
              </g>
            ))}
            {minors.map((m) => (
              <line key={m} x1={xAt(m)} y1={27} x2={xAt(m)} y2={34} stroke="#2b3038" strokeWidth="1" />
            ))}

            {/* operating zones on the scale band (real soft/hard limits) */}
            <rect x={xAt(-5)} y={36} width={xAt(-3) - xAt(-5)} height={4} fill="rgba(255,107,126,.45)" />
            <rect x={xAt(-3)} y={36} width={xAt(-1) - xAt(-3)} height={4} fill="rgba(255,180,84,.4)" />
            <rect x={xAt(-1)} y={36} width={xAt(1) - xAt(-1)} height={4} fill="rgba(94,225,162,.5)" />
            <rect x={xAt(1)} y={36} width={xAt(3) - xAt(1)} height={4} fill="rgba(255,180,84,.4)" />
            <rect x={xAt(3)} y={36} width={xAt(5) - xAt(3)} height={4} fill="rgba(255,107,126,.45)" />

            {/* tube */}
            <rect x={X0 - 32} y={48} width={X1 - X0 + 64} height={62} rx={31} fill="url(#tubeGlass)" stroke="#2b3038" strokeWidth="1.5" />
            <rect x={X0 - 24} y={53} width={X1 - X0 + 48} height={16} rx={8} fill="url(#tubeShine)" />

            {/* center notch */}
            <path d={`M ${xAt(0) - 6} 44 L ${xAt(0) + 6} 44 L ${xAt(0)} 52 Z`} fill="#99a1b3" />
            <line x1={xAt(0)} y1={52} x2={xAt(0)} y2={106} stroke="rgba(153,161,179,.35)" strokeWidth="1.5" strokeDasharray="3 3" />

            {/* bubble */}
            <g style={{ transform: `translateX(${bubbleX - 500}px)`, transition: "transform .7s cubic-bezier(.22,1,.36,1)" }}>
              <g className={tone === "idle" ? "bubble-idle" : undefined}>
                <ellipse cx={500} cy={79} rx={33} ry={19} fill={bubbleFill} style={{ filter: `drop-shadow(0 0 10px ${glow})` }} />
                <ellipse cx={489} cy={71} rx={11} ry={5.5} fill="rgba(255,255,255,.55)" />
              </g>
            </g>

            <style>{`
              @media (prefers-reduced-motion: no-preference) {
                .bubble-idle { animation: gaugeWander 7s ease-in-out infinite; }
                @keyframes gaugeWander {
                  0%,100% { transform: translateX(0); }
                  28% { transform: translateX(9px); }
                  62% { transform: translateX(-7px); }
                }
              }
            `}</style>
          </svg>
        </div>

        <div className="leg right">
          <div className="leg-label">PERP SHORT · PERPL</div>
          <div className="leg-main short">{hasHedge ? shortMon.toFixed(1) : "———"}</div>
          <div className="leg-sub">{hasHedge ? `MON · $${shortUsd.toFixed(2)}` : "MON · standby"}</div>
        </div>
      </div>

      <div className="gauge-foot">
        <span className="etched" style={{ fontSize: 9 }}>
          DRIFT
        </span>
        <span className={`drift-lcd ${tone === "red" ? "red" : tone === "amber" ? "amber" : ""}`}>
          {hasHedge ? `${deltaPct >= 0 ? "+" : "−"}${Math.abs(deltaPct).toFixed(2)} %` : "+0.00 %"}
        </span>
        <span className="etched" style={{ fontSize: 9 }}>
          {stateLabel === "STANDBY" ? "NO LIVE HEDGE — CONSOLE BELOW" : `MODE ${stateLabel}`}
        </span>
      </div>
    </section>
  );
}
