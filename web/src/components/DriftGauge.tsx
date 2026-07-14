// DriftGauge — a horizontal balance beam for the spot-vs-perp hedge.
//
// The marker rides at dead-center when the book is perfectly hedged and slides
// out toward the violet "churn" zone as the engine closes/re-opens a clip to farm
// volume, then snaps back. Two signals drive it, on purpose:
//   • position  = the SIGNED raw delta (spot−short) — this is the visible motion,
//     and it's honest: mid-churn the position really is momentarily one-sided.
//   • color     = the churn-ADJUSTED drift (true hedge health) — so a normal churn
//     swing paints green ("working"), and only a real breach reddens.
// A resting hedge sits calm and centered (that's success); the beam still breathes
// so the instrument reads as live.

interface Props {
  spotMon: number;
  spotUsd: number;
  shortMon: number;
  shortUsd: number;
  /** Signed raw delta in % (+ spot-heavy, − short-heavy). Drives marker position. */
  deltaSignedPct: number;
  /** Churn-adjusted drift magnitude in % (≥0). Drives health color/word. */
  driftPct: number;
  /** Gauge half-range in % — the outer edge equals one full churn clip. */
  churnMax: number;
  hasHedge: boolean;
  stateLabel: string;
  /** Whose hedge this is (e.g. "your hedge" / "engine · paper"). */
  sourceLabel?: string;
  /** Rolling series of signed delta % (oldest→newest) for the drift-over-time trace. */
  trace?: number[];
}

const SOFT = 1; // % adjusted drift — within this the hedge is "in balance"
const HARD = 3; // % adjusted drift — beyond this the engine actively rebalances

/**
 * Rolling area trace of the signed delta over the recent session. Zero is the
 * horizontal centre; each churn cycle shows as a pulse away from the line and
 * back — the visible rhythm of the strategy working over time.
 */
function DriftTrace({ values, churnMax, tone }: { values: number[]; churnMax: number; tone: string }) {
  const W = 100;
  const H = 46;
  // Delta is one-sided in practice (churn closes the short → spot-heavy positive),
  // so anchor zero near the bottom and let drift climb through most of the height.
  const base = H * 0.86;
  const maxPos = Math.max(churnMax, ...values.map((v) => Math.max(0, v))) * 1.08 || 1;
  const maxNeg = Math.max(churnMax * 0.25, ...values.map((v) => Math.max(0, -v))) || 1;
  const n = values.length;
  const x = (i: number) => (n <= 1 ? 0 : (i / (n - 1)) * W);
  const y = (v: number) => (v >= 0 ? base - (v / maxPos) * (base - 2) : base + (-v / maxNeg) * (H - base - 2));
  const line = values.map((v, i) => `${x(i).toFixed(2)},${y(v).toFixed(2)}`).join(" ");
  const area = `0,${base.toFixed(2)} ${line} ${W},${y(values[n - 1]).toFixed(2)} ${W},${base.toFixed(2)}`;
  const stroke = tone === "hard" ? "var(--z-red)" : tone === "warn" ? "var(--z-amber)" : "var(--z-green)";
  // Churn band = drift beyond the hard limit — everything above the HARD line.
  const bandBottom = y(HARD);
  return (
    <svg className="dt-svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="drift over time">
      <rect x="0" y="0" width={W} height={bandBottom.toFixed(2)} className="dt-band" />
      <line x1="0" y1={base.toFixed(2)} x2={W} y2={base.toFixed(2)} className="dt-zero" />
      <polygon points={area} className="dt-area" style={{ fill: stroke }} />
      <polyline points={line} className="dt-line" style={{ stroke }} />
    </svg>
  );
}

export function DriftGauge({
  spotMon,
  spotUsd,
  shortMon,
  shortUsd,
  deltaSignedPct,
  driftPct,
  churnMax,
  hasHedge,
  stateLabel,
  sourceLabel,
  trace,
}: Props) {
  const tone = !hasHedge ? "idle" : driftPct > HARD ? "hard" : driftPct > SOFT ? "warn" : "ok";
  const chipTone = tone === "warn" ? "warn" : tone === "hard" ? "hard" : tone === "idle" ? "muted" : "";
  const word = !hasHedge
    ? "No live hedge"
    : tone === "hard"
      ? "Rebalancing"
      : tone === "warn"
        ? "Minor drift"
        : "In balance";

  // Marker position: 50% = perfectly hedged; ±churnMax maps to the beam edges.
  const frac = Math.max(-1, Math.min(1, deltaSignedPct / churnMax));
  const pos = hasHedge ? 50 + frac * 46 : 50;
  const sign = deltaSignedPct >= 0 ? "+" : "−";

  // Neutral (green) band width as a share of the half-beam — the true tolerance is
  // tiny against a churn-scaled axis, so floor it to a legible detent.
  const neutralHalf = Math.max(9, Math.min(28, (HARD / churnMax) * 46));

  const displayState = stateLabel === "STANDBY" ? "NO LIVE HEDGE" : stateLabel;

  return (
    <section className="card glass gauge-card" aria-label="Hedge balance">
      <div className="card-head">
        <span className="title">
          <i />
          Drift indicator
        </span>
        <span className="meta mono">
          {sourceLabel ? `spot vs perp · ${sourceLabel}` : `spot vs perp · ±${churnMax}%`}
        </span>
      </div>

      <div className="beam-body">
        <div className="beam-status">
          <div className={`beam-word ${tone}`}>{word}</div>
          <div className="beam-sub">
            <span className="mono beam-delta">
              Δ {hasHedge ? `${sign}${Math.abs(deltaSignedPct).toFixed(2)}%` : "—"}
            </span>
            <span className={`state-chip ${chipTone}`}>{displayState}</span>
          </div>
        </div>

        <div className="beam-wrap">
          <div className={`beam ${tone} ${hasHedge ? "" : "off"}`}>
            {/* zones: violet churn flanks + green neutral detent */}
            <span
              className="beam-zone neutral"
              style={{ left: `${50 - neutralHalf}%`, right: `${50 - neutralHalf}%` }}
            />
            {/* fixed tick grid for a sense of scale */}
            {[10, 30, 50, 70, 90].map((t) => (
              <span key={t} className={`beam-tick ${t === 50 ? "mid" : ""}`} style={{ left: `${t}%` }} />
            ))}
            {/* the balance marker */}
            <span
              className={`beam-marker ${tone}`}
              style={{ left: `${pos}%` }}
              role="img"
              aria-label={`delta ${sign}${Math.abs(deltaSignedPct).toFixed(2)} percent`}
            >
              <span className="bm-line" />
              <span className="bm-dot" />
            </span>
          </div>
          <div className="beam-scale mono">
            <span>
              −{churnMax}% <b>short-heavy</b>
            </span>
            <span className="bs-mid">hedged</span>
            <span>
              <b>spot-heavy</b> +{churnMax}%
            </span>
          </div>
        </div>

        {hasHedge && (
          <div className="beam-trace">
            <div className="bt-head mono">
              <span>DRIFT OVER TIME{trace && trace.length > 1 ? ` · ${trace.length} SAMPLES` : ""}</span>
              <span className="bt-legend">
                <i className="bt-band" /> churn band
              </span>
            </div>
            {trace && trace.length > 1 ? (
              <DriftTrace values={trace} churnMax={churnMax} tone={tone} />
            ) : (
              <div className="bt-warm mono">collecting drift history…</div>
            )}
          </div>
        )}

        <div className="beam-foot mono">
          {hasHedge ? (
            <>
              true drift <b className={tone}>{driftPct.toFixed(2)}%</b> · churn-adjusted, guard trips at {HARD}%
            </>
          ) : (
            <>open a hedge to arm the balance</>
          )}
        </div>
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
