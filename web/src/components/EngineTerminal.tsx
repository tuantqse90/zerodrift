// EngineTerminal — NT-style terminal window streaming the REAL hedging engine:
// the bot (paper mode, live mainnet data) writes /status.json on the server and
// this card polls it. Nothing here is canned.

import { useEffect, useState } from "react";

interface StatusEvent {
  ts: string;
  kind: "fill" | "state" | "info";
  text: string;
}
export interface HistoryPoint {
  t: number;
  vol: number;
  fees: number;
  funding: number;
  net: number;
}
export interface EngineStatus {
  generatedAt: string;
  events: StatusEvent[];
  history?: HistoryPoint[];
  mode: string;
  state: string;
  marketName: string;
  mid: number;
  deltaPct: number;
  /** Signed raw delta (+ spot-heavy, − short-heavy) — drives the gauge needle position. */
  deltaSignedPct?: number;
  /** Churn-adjusted delta = true hedge drift (excludes the intentional churn gap). */
  driftPct?: number;
  /** Fraction of the short a churn cycle closes/reopens — sets the gauge's outer band. */
  churnFraction?: number;
  spotMon: number;
  shortMon: number;
  roundTrips: number;
  fillCount: number;
  weekVolumeUsd: number;
  makerFeesUsd: number;
  takerFeesUsd: number;
  fundingUsd: number;
  fundingAprPct: number;
  churnIntensity?: string;
  /** Absolute mid move over the trend window (%). */
  trendStrengthPct?: number;
  /** True while churn is sitting out a strong trend. */
  trendPaused?: boolean;
  boostedVolumeUsd?: number;
  netCostUsd?: number;
  costPer1kBoostedUsd?: number;
  config?: {
    leverageX: number;
    churnMin: number;
    softPct: number;
    hardPct: number;
    makerFeeBps: number;
    takerFeeBps: number;
    pointsBoostX: number;
  };
}

export function useEngineStatus(): EngineStatus | null {
  const [status, setStatus] = useState<EngineStatus | null>(null);
  useEffect(() => {
    let live = true;
    const tick = async () => {
      try {
        const res = await fetch("/status.json", { cache: "no-store" });
        if (res.ok && live) setStatus((await res.json()) as EngineStatus);
      } catch {
        /* keep last */
      }
    };
    tick();
    const t = setInterval(tick, 10_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);
  return status;
}

function hhmmss(ts: string): string {
  return ts.slice(11, 19);
}

function Line({ ev }: { ev: StatusEvent }) {
  const time = <span className="dim">[{hhmmss(ev.ts)}]</span>;
  if (ev.kind === "fill") {
    const m = ev.text.match(/^fill (maker|taker) ([\d.]+) @ ([\d.]+) fee=\$([\d.-]+)$/);
    if (m) {
      return (
        <div>
          {time} fill <span className={m[1] === "maker" ? "mint" : "amber"}>{m[1]}</span> {m[2]} @ {m[3]} fee=
          <span className="mint">${m[4]}</span>
        </div>
      );
    }
  }
  if (ev.kind === "state") {
    const parts = ev.text.split("→");
    if (parts.length === 2) {
      const [head, tail] = parts;
      const target = tail.trim().split(" ")[0];
      const rest = tail.trim().slice(target.length);
      const tone = target === "HEDGED" ? "mint" : target === "UNWINDING" || target === "REBALANCING" ? "amber" : "violet";
      return (
        <div>
          {time} {head.trim()} → <span className={tone}>{target}</span>
          <span className="dim">{rest}</span>
        </div>
      );
    }
  }
  return (
    <div>
      {time} {ev.text}
    </div>
  );
}

export function EngineTerminal({ status }: { status: EngineStatus | null }) {
  const stale = status ? Date.now() - new Date(status.generatedAt).getTime() > 60_000 : false;

  return (
    <section className="terminal glass-strong" aria-label="Hedging engine log">
      <div className="t-head">
        <span className="dot r" />
        <span className="dot y" />
        <span className="dot g" />
        <span className="t-title">
          zerodrift — hedging engine{" "}
          {status ? `(${status.mode.toLowerCase()} session · live mainnet data)` : "(connecting…)"}
        </span>
        <span className="t-right">bun run hedger</span>
      </div>
      <div className="t-body">
        <div>
          <span className="dim">$</span> bun run hedger
        </div>
        {status ? (
          <>
            <div className="dim">
              market "{status.marketName}" · state <span className="mint">{status.state}</span> · mid{" "}
              {status.mid.toFixed(6)} · round-trips <span className="violet">{status.roundTrips}</span> · week volume{" "}
              <span className="violet">${status.weekVolumeUsd.toFixed(0)}</span> · fees $
              {(status.makerFeesUsd + status.takerFeesUsd).toFixed(4)}
            </div>
            {status.events.slice(-7).map((ev, i) => (
              <Line key={`${ev.ts}-${i}`} ev={ev} />
            ))}
            {stale && <div className="amber">… feed stale — engine restarting or redeploying</div>}
          </>
        ) : (
          <div className="dim">waiting for /status.json — engine warming up…</div>
        )}
      </div>
      <div className="t-foot">
        Live output, polled every 10s from the engine running on our server (paper mode — same code path as live).
        Runs headless with Telegram alerts; unwinds itself on margin pressure.
      </div>
    </section>
  );
}
