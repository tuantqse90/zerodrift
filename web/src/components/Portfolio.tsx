// Portfolio — YOUR live position, PnL, and Perpl account stats (the points
// signal). Lights up when a Perpl key is connected; before that it explains what
// you'll see. Perp uPnL is entry-vs-mark; account stats (total volume, realized
// PnL, trades, win-rate) come from Perpl's own snapshot; mPoints is a best-effort
// signed fetch that degrades to a link if the endpoint shape is unknown.

import { useEffect, useState } from "react";
import type { TradingSession } from "../lib/perplTrading";

const POINTS_PATHS = ["/v1/profile/points", "/v1/profile/mpoints", "/v1/profile/rewards"];

/** Pull the first plausible points number out of an unknown JSON shape. */
function extractPoints(obj: any): number | null {
  if (obj == null) return null;
  if (typeof obj === "number") return obj;
  for (const k of ["mpoints", "points", "total", "totalPoints", "score", "amount"]) {
    if (typeof obj[k] === "number") return obj[k];
    if (typeof obj[k] === "string" && Number.isFinite(Number(obj[k]))) return Number(obj[k]);
  }
  // nested { data: {...} } / { result: {...} }
  for (const k of ["data", "result", "profile"]) if (obj[k]) return extractPoints(obj[k]);
  return null;
}

export function Portfolio({ session, mark }: { session: TradingSession | null; mark: number | null }) {
  const ready = session?.status === "ready";
  const [points, setPoints] = useState<number | null>(null);
  const [pointsTried, setPointsTried] = useState(false);
  const [, force] = useState(0);

  // Poll session state (position/account/stats) rather than hijack session.onChange
  // (the Hedge console owns that callback).
  useEffect(() => {
    if (!session) return;
    const t = setInterval(() => force((n) => n + 1), 2000);
    return () => clearInterval(t);
  }, [session]);

  // Best-effort signed points fetch once the session is ready.
  useEffect(() => {
    if (!ready || !session) return;
    let live = true;
    const run = async () => {
      for (const p of POINTS_PATHS) {
        const j = await session.signedGet(p);
        const n = extractPoints(j);
        if (live && n != null) {
          setPoints(n);
          break;
        }
      }
      if (live) setPointsTried(true);
    };
    run();
    const t = setInterval(run, 120_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [ready, session]);

  if (!ready) {
    return (
      <div className="pf-empty">
        <p>
          Connect a Perpl trade key in the <b>Hedge</b> console to see <b>your</b> live position, PnL, Perpl trading
          volume (the points signal), and mPoints.
        </p>
        <p className="pf-muted">
          Nothing here is the bot's — this is your own account. Keys stay in your browser and can't withdraw.
        </p>
      </div>
    );
  }

  const pos = session.position;
  const short = pos.side === "short" ? pos.sizeMon : 0;
  const uPnl = short > 0 && mark ? (pos.entryPx - mark) * short : 0;
  const acct = session.account;
  const st = session.stats;

  const Cell = ({ k, v, tone }: { k: string; v: string; tone?: string }) => (
    <div className="pf-cell">
      <div className={`pf-v ${tone ?? ""}`}>{v}</div>
      <div className="pf-k">{k}</div>
    </div>
  );

  return (
    <div className="pf">
      <div className="pf-grid">
        <Cell k="PERP SHORT" v={short > 0 ? `${short.toFixed(1)} MON` : "flat"} />
        <Cell k="ENTRY" v={short > 0 ? pos.entryPx.toFixed(6) : "—"} />
        <Cell
          k="PERP uPnL"
          v={short > 0 ? `${uPnl >= 0 ? "+" : "−"}$${Math.abs(uPnl).toFixed(2)}` : "—"}
          tone={short > 0 ? (uPnl >= 0 ? "mint" : "loss") : ""}
        />
        <Cell k="FREE COLLATERAL" v={acct ? `$${acct.balanceUsd.toFixed(2)}` : "—"} />
      </div>

      <div className="pf-sec">Your Perpl account</div>
      <div className="pf-grid">
        <Cell k="TOTAL VOLUME" v={st ? `$${st.totalVolumeUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : "—"} tone="mint" />
        <Cell k="REALIZED PnL" v={st ? `${st.realizedPnlUsd >= 0 ? "+" : "−"}$${Math.abs(st.realizedPnlUsd).toFixed(2)}` : "—"} tone={st && st.realizedPnlUsd >= 0 ? "mint" : "loss"} />
        <Cell k="TRADES" v={st ? `${st.trades}` : "—"} />
        <Cell k="WIN RATE" v={st ? `${st.winRatePct.toFixed(1)}%` : "—"} />
      </div>

      <div className="pf-points">
        <div>
          <div className="pf-points-label">PERPL mPOINTS · PURPLE SUMMER</div>
          <div className="pf-points-val">
            {points != null ? points.toLocaleString() : pointsTried ? "see official page" : "loading…"}
          </div>
        </div>
        <a className="btn secondary sm" href="https://app.perpl.xyz/points" target="_blank" rel="noreferrer">
          Perpl points ↗
        </a>
      </div>
      <p className="pf-muted" style={{ marginTop: 8 }}>
        Points accrue from your volume on Perpl. Total volume above is the reliable signal; the mPoints number is read
        straight from your Perpl account when available.
      </p>
    </div>
  );
}
