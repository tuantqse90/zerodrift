// StrategyCompare — a live A/B of the two farming engines running the same $100
// hedge side by side. The honest differentiator: churn farms raw volume cheaply;
// Avellaneda captures the spread. Each row highlights the winner on that metric.

import type { EngineStatus } from "./EngineTerminal";

type Dir = "up" | "down"; // which direction is "better"

interface Row {
  label: string;
  churn: number | null;
  as: number | null;
  fmt: (v: number) => string;
  better: Dir;
}

function pick(a: EngineStatus | null, f: (s: EngineStatus) => number | undefined): number | null {
  const v = a ? f(a) : undefined;
  return typeof v === "number" ? v : null;
}

/** Spread captured per $1k of boosted volume — the volume-normalised maker edge. */
function spreadEff(s: EngineStatus | null): number | null {
  if (!s) return null;
  const vol = s.boostedVolumeUsd ?? 0;
  const sp = s.spreadCaptureUsd ?? 0;
  return vol > 1 ? (sp / vol) * 1000 : null;
}

export function StrategyCompare({ churn, as: asEng }: { churn: EngineStatus | null; as: EngineStatus | null }) {
  const feesOf = (s: EngineStatus) => (s.makerFeesUsd ?? 0) + (s.takerFeesUsd ?? 0);

  const rows: Row[] = [
    {
      label: "BOOSTED VOLUME",
      churn: pick(churn, (s) => s.boostedVolumeUsd),
      as: pick(asEng, (s) => s.boostedVolumeUsd),
      fmt: (v) => `$${Math.round(v).toLocaleString()}`,
      better: "up",
    },
    {
      label: "SPREAD CAPTURED",
      churn: pick(churn, (s) => s.spreadCaptureUsd),
      as: pick(asEng, (s) => s.spreadCaptureUsd),
      fmt: (v) => `${v >= 0 ? "+" : "−"}$${Math.abs(v).toFixed(3)}`,
      better: "up",
    },
    {
      // The honest edge metric — spread earned per $1k of volume, so it isn't just
      // "whoever traded more wins". This is where the AS quoting shows its advantage.
      label: "SPREAD / $1K VOL",
      churn: spreadEff(churn),
      as: spreadEff(asEng),
      fmt: (v) => `$${v.toFixed(3)}`,
      better: "up",
    },
    {
      label: "FEES PAID",
      churn: churn ? feesOf(churn) : null,
      as: asEng ? feesOf(asEng) : null,
      fmt: (v) => `$${v.toFixed(3)}`,
      better: "down",
    },
    {
      label: "FUNDING",
      churn: pick(churn, (s) => s.fundingUsd),
      as: pick(asEng, (s) => s.fundingUsd),
      fmt: (v) => `${v >= 0 ? "+" : "−"}$${Math.abs(v).toFixed(3)}`,
      better: "up",
    },
    {
      label: "NET PnL",
      churn: pick(churn, (s) => s.netPnlUsd),
      as: pick(asEng, (s) => s.netPnlUsd),
      fmt: (v) => `${v >= 0 ? "+" : "−"}$${Math.abs(v).toFixed(3)}`,
      better: "up",
    },
    {
      label: "COST / $1K VOL",
      churn: pick(churn, (s) => s.costPer1kBoostedUsd),
      as: pick(asEng, (s) => s.costPer1kBoostedUsd),
      fmt: (v) => (v <= 0 ? "FREE" : `$${v.toFixed(3)}`),
      better: "down",
    },
  ];

  const winner = (r: Row): "churn" | "as" | null => {
    if (r.churn == null || r.as == null || r.churn === r.as) return null;
    const churnBetter = r.better === "up" ? r.churn > r.as : r.churn < r.as;
    return churnBetter ? "churn" : "as";
  };

  // Headline: the honest trade-off — churn's raw volume vs AS's spread efficiency.
  const volCh = pick(churn, (s) => s.boostedVolumeUsd) ?? 0;
  const volAs = pick(asEng, (s) => s.boostedVolumeUsd) ?? 0;
  const effCh = spreadEff(churn) ?? 0;
  const effAs = spreadEff(asEng) ?? 0;
  const volRatio = volAs > 1 ? volCh / volAs : 0;
  const effRatio = effCh > 0.0005 ? effAs / effCh : effAs > 0.0005 ? Infinity : 0;
  const ready = volCh > 1 && volAs > 1;
  const verdict = ready
    ? `Churn farms ${volRatio.toFixed(1)}× the raw volume for points; Avellaneda captures ${
        effRatio === Infinity ? "far" : `${effRatio.toFixed(1)}×`
      } more spread per dollar. Two honest edges, same hedge.`
    : "Same $100 hedge, two engines — watch the trade-off between raw volume and captured spread.";

  const chip = (s: EngineStatus | null) =>
    s ? <span className={`intensity-badge i-${s.churnIntensity ?? "waiting"}`}>{s.churnIntensity ?? s.state}</span> : <span className="cmp-dim">offline</span>;

  return (
    <div className="strat-compare">
      <p className="cmp-verdict">{verdict}</p>
      <div className="cmp-grid">
        <div className="cmp-head">
          <span />
          <span className="cmp-col-h churn">Churn</span>
          <span className="cmp-col-h as">Avellaneda</span>
        </div>
        <div className="cmp-row cmp-state">
          <span className="cmp-k">STRATEGY</span>
          <span>{chip(churn)}</span>
          <span>{chip(asEng)}</span>
        </div>
        {rows.map((r) => {
          const w = winner(r);
          return (
            <div className="cmp-row" key={r.label}>
              <span className="cmp-k">{r.label}</span>
              <span className={`cmp-v mono ${w === "churn" ? "win" : w ? "lose" : ""}`}>
                {r.churn == null ? "—" : r.fmt(r.churn)}
                {w === "churn" && <i className="cmp-badge">▲</i>}
              </span>
              <span className={`cmp-v mono ${w === "as" ? "win" : w ? "lose" : ""}`}>
                {r.as == null ? "—" : r.fmt(r.as)}
                {w === "as" && <i className="cmp-badge">▲</i>}
              </span>
            </div>
          );
        })}
      </div>
      <p className="cmp-foot">
        Both are the same headless engine (<code>HEDGER_STRATEGY</code>), delta-neutral in paper. Spread captured =
        Σ|fill − mid|·size — the true maker edge, funding &amp; direction excluded.
      </p>
    </div>
  );
}
