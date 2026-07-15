import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Address } from "viem";
import { BookLadder } from "./components/BookLadder";
import { DriftGauge } from "./components/DriftGauge";
import { EngineTerminal, useEngineStatus } from "./components/EngineTerminal";
import { EpochHistory } from "./components/EpochHistory";
import { Estimator } from "./components/Estimator";
import { HedgeConsole } from "./components/HedgeConsole";
import { HistorySpark } from "./components/HistorySpark";
import { Portfolio } from "./components/Portfolio";
import { PriceChart, candleStats, useCandles } from "./components/PriceChart";
import { RecentTrades } from "./components/RecentTrades";
import { StrategyCompare } from "./components/StrategyCompare";
import type { Trade } from "./lib/perplFeed";
import { fetchEpochFeed, publicClient, scanRecentOpeners, type EpochRow } from "./lib/chain";
import {
  fetchPerplMarket,
  fundingAprPct,
  PerplFeed,
  type PerplBook,
  type PerplMarketInfo,
} from "./lib/perplFeed";
import { spotPriceUsd } from "./lib/nt";
import { TradingSession } from "./lib/perplTrading";

function useBlockNumber(): bigint | null {
  const [block, setBlock] = useState<bigint | null>(null);
  useEffect(() => {
    const tick = () => publicClient.getBlockNumber().then(setBlock).catch(() => {});
    tick();
    const t = setInterval(tick, 2000);
    return () => clearInterval(t);
  }, []);
  return block;
}

/** Mono value that flashes mint/red when its numeric source moves. */
function Fv({ text, num, extra = "" }: { text: string; num: number | null; extra?: string }) {
  const prev = useRef<number | null>(null);
  const [cls, setCls] = useState("");
  useEffect(() => {
    if (num == null) return;
    if (prev.current != null && num !== prev.current) {
      setCls(num > prev.current ? "fl-up" : "fl-down");
      const t = setTimeout(() => setCls(""), 700);
      prev.current = num;
      return () => clearTimeout(t);
    }
    prev.current = num;
  }, [num]);
  return <span className={`t-val ${extra} ${cls}`}>{text}</span>;
}

// Selectable engine strategies — each is a separately deployed bot writing its own
// status feed, so users can watch (and compare) the different farming engines live.
type StrategyKey = "churn" | "avellaneda";
const STRATEGIES: Record<StrategyKey, { label: string; src: string; blurb: string }> = {
  churn: {
    label: "Churn",
    src: "/status.json",
    blurb: "Discrete close/re-open round-trips. Simple, robust, funding-adaptive volume.",
  },
  avellaneda: {
    label: "Avellaneda-Stoikov",
    src: "/status-avellaneda.json",
    blurb: "Continuous two-sided market making. Captures the spread, skews to hold the hedge, less wash-like.",
  },
};

function ago(unixSec: number): string {
  const s = Math.max(0, Math.floor(Date.now() / 1000) - unixSec);
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export default function App() {
  const [market, setMarket] = useState<PerplMarketInfo | null>(null);
  const [book, setBook] = useState<PerplBook | null>(null);
  const [fundingApr, setFundingApr] = useState<number | null>(null);
  const [spotPx, setSpotPx] = useState<number | null>(null);
  const [epochs, setEpochs] = useState<EpochRow[]>([]);
  const [epochsLoading, setEpochsLoading] = useState(true);
  const [session, setSession] = useState<TradingSession | null>(null);
  const [hedgeSpotMon, setHedgeSpotMon] = useState(0);
  const [tab, setTab] = useState<"portfolio" | "engine" | "compare" | "epochs" | "estimator">("engine");
  const [stratKey, setStratKey] = useState<StrategyKey>("churn");
  const [feedState, setFeedState] = useState<"connecting" | "live" | "reconnecting">("connecting");
  const feedRef = useRef<PerplFeed | null>(null);
  const blockNumber = useBlockNumber();
  // Poll BOTH deployed bots so the A/B compare tab is always live; the rest of the UI
  // follows whichever strategy the picker selects.
  const churnEngine = useEngineStatus(STRATEGIES.churn.src);
  const asEngine = useEngineStatus(STRATEGIES.avellaneda.src);
  const engine = stratKey === "avellaneda" ? asEngine : churnEngine;
  const [res, setRes] = useState(900);
  const candles = useCandles(market, res);
  const [trades, setTrades] = useState<Trade[]>([]);

  useEffect(() => {
    let live = true;
    fetchPerplMarket("MON")
      .then((m) => {
        if (!live) return;
        setMarket(m);
        const feed = new PerplFeed(m);
        feedRef.current = feed;
        let raf = 0;
        feed.onUpdate = () => {
          cancelAnimationFrame(raf);
          raf = requestAnimationFrame(() => {
            setBook(feed.getBook());
            setFeedState(feed.connState);
            setTrades([...feed.trades]);
            if (feed.funding) setFundingApr(fundingAprPct(feed.funding.rateMicros, m.fundingIntervalSec));
          });
        };
        feed.start();
        // The trading session is started per-wallet by HedgeConsole once an address
        // and its keys are known — never from a global blob at mount.
      })
      .catch(() => {});
    return () => {
      live = false;
      feedRef.current?.stop();
    };
  }, []);

  useEffect(() => {
    const tick = () => spotPriceUsd().then((p) => p && setSpotPx(p));
    tick();
    const t = setInterval(tick, 10_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const seenOwners = new Set<Address>();
    const tick = async () => {
      try {
        const fresh = await scanRecentOpeners();
        for (const o of fresh) seenOwners.add(o);
        setEpochs(await fetchEpochFeed([...seenOwners]));
      } catch {
        /* keep last */
      } finally {
        setEpochsLoading(false);
      }
    };
    tick();
    const t = setInterval(tick, 30_000);
    return () => clearInterval(t);
  }, []);

  const onHedgeChange = useCallback((spotMon: number) => setHedgeSpotMon(spotMon), []);

  const bookMid = book ? (book.bids[0].px + book.asks[0].px) / 2 : null;
  const lastCandle = candles.length ? candles[candles.length - 1].c : null;
  const mid = bookMid ?? lastCandle;
  const spreadBps = book ? ((book.asks[0].px - book.bids[0].px) / book.bids[0].px) * 10_000 : null;
  const pos = session?.position;
  const shortMon = pos?.side === "short" ? pos.sizeMon : 0;
  const hasHedge = hedgeSpotMon > 0 || shortMon > 0;
  const deltaMon = hedgeSpotMon - shortMon;
  const deltaPct = hasHedge && hedgeSpotMon > 0 ? (deltaMon / hedgeSpotMon) * 100 : 0;

  const stateLabel = useMemo<"HEDGED" | "DRIFT" | "REBAL" | "STANDBY">(() => {
    if (!hasHedge) return "STANDBY";
    const abs = Math.abs(deltaPct);
    if (abs <= 1) return "HEDGED";
    if (abs <= 3) return "DRIFT";
    return "REBAL";
  }, [hasHedge, deltaPct]);

  // The drift gauge shows YOUR hedge when you have one; otherwise it mirrors the
  // live engine's own position (which churns 24/7) so the instrument actually moves
  // with real data instead of sitting idle at zero.
  const engineHasPos = !!engine && engine.spotMon > 0;

  // Rolling drift-over-time series for the gauge trace. Sampled on a steady 4s
  // cadence (finer than the engine's 5-min history) so churn pulses are visible.
  const displaySigned = hasHedge ? deltaPct : engineHasPos ? engine?.deltaSignedPct ?? engine?.deltaPct ?? 0 : 0;
  const armed = hasHedge || engineHasPos;
  const sampleRef = useRef({ v: displaySigned, armed });
  sampleRef.current = { v: displaySigned, armed };
  const [trace, setTrace] = useState<number[]>([]);
  useEffect(() => {
    const push = () => {
      if (!sampleRef.current.armed) return;
      setTrace((prev) => {
        const next = [...prev, sampleRef.current.v];
        return next.length > 90 ? next.slice(-90) : next;
      });
    };
    push();
    const t = setInterval(push, 4000);
    return () => clearInterval(t);
  }, []);

  const gauge = hasHedge
    ? {
        spotMon: hedgeSpotMon,
        spotUsd: hedgeSpotMon * (spotPx ?? mid ?? 0),
        shortMon,
        shortUsd: shortMon * (mid ?? 0),
        deltaSignedPct: deltaPct, // already signed (spot−short)/spot
        driftPct: Math.abs(deltaPct), // a manual hedge doesn't churn — drift == |delta|
        churnMax: 5,
        hasHedge: true,
        stateLabel,
        sourceLabel: "your hedge",
        trace,
      }
    : engineHasPos
      ? {
          spotMon: engine!.spotMon,
          spotUsd: engine!.spotMon * (mid ?? 0),
          shortMon: engine!.shortMon,
          shortUsd: engine!.shortMon * (mid ?? 0),
          deltaSignedPct: engine!.deltaSignedPct ?? engine!.deltaPct,
          driftPct: engine!.driftPct ?? engine!.deltaPct,
          churnMax: Math.max(10, Math.round((engine!.churnFraction ?? 0.5) * 100)),
          hasHedge: true,
          stateLabel: engine!.state,
          sourceLabel: "engine · paper",
          trace,
        }
      : {
          spotMon: 0,
          spotUsd: 0,
          shortMon: 0,
          shortUsd: 0,
          deltaSignedPct: 0,
          driftPct: 0,
          churnMax: 5,
          hasHedge: false,
          stateLabel: "STANDBY",
          sourceLabel: undefined,
          trace,
        };

  const shortsEarn = fundingApr !== null && fundingApr > 0;
  const latestEpoch = epochs[0];
  const stats = candleStats(candles);

  // Live tab title like a real exchange: "$0.0224 ▲ MON-PERP · ZeroDrift".
  useEffect(() => {
    if (mid) {
      const arrow = stats && stats.changePct >= 0 ? "\u25B2" : "\u25BC";
      document.title = `$${mid.toFixed(6)} ${arrow} MON-PERP \u00B7 ZeroDrift`;
    }
  }, [mid, stats]);

  return (
    <div className="app">
      <nav className="topbar">
        <a className="brand" href="#/" aria-label="ZeroDrift home">
          <img src="/icon.svg" alt="" width="26" height="26" className="brand-mark" />
          <span className="brand-name">
            <span className="zero">Zero</span>Drift
          </span>
          <span className="brand-by">by NullTerminal</span>
        </a>

        <div className="nav-menu" role="navigation">
          <a className="nav-item active" href="#/">
            Terminal
          </a>
          <a className="nav-item" href="#/guide">
            Guide
          </a>
          <a
            className="nav-item"
            href="https://monadscan.com/address/0x24BD952B9BaD090Eab24A1a91948fA130c8D3A48"
            target="_blank"
            rel="noreferrer"
          >
            Contract <span className="ext">↗</span>
          </a>
          <a className="nav-item hide-sm" href="https://perpl.xyz" target="_blank" rel="noreferrer">
            Perpl <span className="ext">↗</span>
          </a>
        </div>

        <span className="spacer" />

        <div className="nav-status">
          <span
            className={`sdot ${feedState === "live" ? "on" : feedState === "reconnecting" ? "reconn" : ""}`}
            title={`Perpl feed: ${feedState}`}
          >
            <svg viewBox="0 0 32 32" className="brand-svg" aria-hidden="true">
              <path d="M9.71373 0H4V31H9.71373V0Z" fill="currentColor" />
              <path d="M21.5062 15.4392H15.7925V31H21.5062V15.4392Z" fill="currentColor" />
              <path d="M27.2196 0H21.5059V15.4392H27.2196V0Z" fill="currentColor" />
            </svg>
            {feedState === "reconnecting" ? "RECONNECTING" : "Perpl"}
          </span>
          <span className={`sdot ${blockNumber ? "on" : ""}`} title="Monad chain">
            <img src="/mon.svg" className="brand-img" alt="" aria-hidden="true" />
            Monad
          </span>
          <span className={`sdot ${engine ? "on" : ""}`} title="Hedging engine">
            <i />
            Engine
          </span>
        </div>
      </nav>

      <div className="statsbar" aria-label="Live market stats">
        <div className="stats-lead">
          <span className="pair">
            <img src="/mon.svg" className="coin" alt="" />
            MON-PERP
          </span>
          <Fv text={mid ? `$${mid.toFixed(6)}` : "—"} num={mid} extra="lead-price" />
          {stats ? (
            <span className={`lead-chg ${stats.changePct >= 0 ? "up" : "down"}`}>
              {stats.changePct >= 0 ? "▲" : "▼"} {Math.abs(stats.changePct).toFixed(2)}%
            </span>
          ) : null}
          {!bookMid && lastCandle ? <span className="t-label">candle</span> : null}
        </div>
        <span>
          <span className="t-label">SPOT · NT</span>
          <Fv text={spotPx ? `$${spotPx.toFixed(6)}` : "—"} num={spotPx} />
        </span>
        <span>
          <span className="t-label">FUNDING 1H</span>
          <span className={`t-val ${fundingApr === null ? "" : shortsEarn ? "up" : "down"}`}>
            {fundingApr === null ? "—" : `${fundingApr > 0 ? "+" : ""}${fundingApr.toFixed(1)}% APR`}
          </span>
          <span className="t-label" style={{ marginLeft: 6 }}>
            {fundingApr === null ? "" : shortsEarn ? "SHORTS EARN" : "SHORTS PAY"}
          </span>
        </span>
        <span>
          <span className="t-label">FEES M/T</span>
          <span className="t-val">
            <span className="up">{market ? (market.makerFeeMicros / 100).toFixed(1) : "—"}</span>
            {" / "}
            {market ? (market.takerFeeMicros / 100).toFixed(1) : "—"}bps
          </span>
        </span>
        <span>
          <span className="t-label">POINTS</span>
          <span className="t-val violet">{market ? `${(market.pointsBoostBps / 10_000).toFixed(0)}× BOOST` : "—"}</span>
        </span>
        <span>
          <span className="t-label">SPREAD</span>
          <Fv text={spreadBps !== null ? `${spreadBps.toFixed(2)}bps` : "—"} num={spreadBps} />
        </span>
        <span>
          <span className="t-label">ENGINE</span>
          <span className="t-val">
            {engine ? `${engine.state} · ${engine.roundTrips} RT · $${engine.weekVolumeUsd.toFixed(0)} wk` : "—"}
          </span>
          {engine?.churnIntensity ? (
            <span className={`intensity-badge i-${engine.churnIntensity}`} style={{ marginLeft: 7 }}>
              {engine.churnIntensity}
            </span>
          ) : null}
        </span>
        <span>
          <span className="t-label">BLOCK</span>
          <span className="t-val">{blockNumber ? blockNumber.toLocaleString() : "—"}</span>
        </span>
      </div>

      <div className="term-grid">
        <div className="col">
          <section className="card glass">
            <div className="card-head">
              <span className="title">
                <img src="/mon.svg" className="coin sm" alt="" />
                MON-perp
              </span>
              <span className="tf-btns" role="tablist" aria-label="Timeframe">
                  {[
                    [300, "5m"],
                    [900, "15m"],
                    [3600, "1h"],
                    [14400, "4h"],
                  ].map(([sec, label]) => (
                    <button
                      key={sec}
                      className={res === sec ? "active" : ""}
                      onClick={() => setRes(sec as number)}
                    >
                      {label}
                    </button>
                  ))}
              </span>
            </div>
            {stats && (
              <div className="chart-stats mono">
                <span>
                  <span className="cs-k">LAST</span>
                  <span className="cs-v">{stats.last.toFixed(6)}</span>
                </span>
                <span>
                  <span className="cs-k">Δ RANGE</span>
                  <span className={`cs-v ${stats.changePct >= 0 ? "up" : "down"}`}>
                    {stats.changePct >= 0 ? "+" : ""}
                    {stats.changePct.toFixed(2)}%
                  </span>
                </span>
                <span>
                  <span className="cs-k">HIGH</span>
                  <span className="cs-v">{stats.high.toFixed(6)}</span>
                </span>
                <span>
                  <span className="cs-k">LOW</span>
                  <span className="cs-v">{stats.low.toFixed(6)}</span>
                </span>
                <span>
                  <span className="cs-k">VOL</span>
                  <span className="cs-v">${(stats.vol / 1000).toFixed(0)}k</span>
                </span>
              </div>
            )}
            <PriceChart market={market} candles={candles} />
          </section>
          <div className="gauge-slim">
            <DriftGauge {...gauge} />
          </div>
        </div>

        <div className="col book-col">
          <section className="card glass">
            <div className="card-head">
              <span className="title">
                <i />
                Book
              </span>
              <span className="meta mono">on-chain CLOB</span>
            </div>
            <BookLadder book={book} depth={9} />
          </section>
          <section className="card glass trades-card">
            <div className="card-head">
              <span className="title">
                <i />
                Recent trades
              </span>
              <span className="meta mono">live tape</span>
            </div>
            <RecentTrades market={market} trades={trades} />
          </section>
        </div>

        <div className="col">
          <HedgeConsole
            market={market}
            book={book}
            session={session}
            setSession={setSession}
            onHedgeChange={onHedgeChange}
          />
          <section className="card glass engine-mini">
            <div className="card-head">
              <span className="title">
                <i />
                Engine session
              </span>
              <span className="meta mono">{engine ? engine.mode.toLowerCase() : "connecting…"}</span>
            </div>
            <div className="strat-picker" role="tablist" aria-label="Farming strategy">
              {(Object.keys(STRATEGIES) as StrategyKey[]).map((k) => (
                <button
                  key={k}
                  role="tab"
                  aria-selected={stratKey === k}
                  className={stratKey === k ? "active" : ""}
                  onClick={() => setStratKey(k)}
                >
                  {STRATEGIES[k].label}
                </button>
              ))}
            </div>
            <p className="strat-blurb">{STRATEGIES[stratKey].blurb}</p>
            {engine ? (
              <>
                <div className="kv">
                  <span className="k">STATE</span>
                  <span className="mono v-mint">{engine.state}</span>
                </div>
                {engine.churnIntensity && (
                  <div className="kv">
                    <span className="k">STRATEGY</span>
                    <span className={`intensity-badge i-${engine.churnIntensity}`}>{engine.churnIntensity}</span>
                  </div>
                )}
                {engine.trendStrengthPct != null && (
                  <div className="kv">
                    <span className="k">TREND</span>
                    <span className={`mono ${engine.trendPaused ? "v-warn" : ""}`}>
                      {engine.trendStrengthPct.toFixed(2)}%{engine.trendPaused ? " · sitting out" : ""}
                    </span>
                  </div>
                )}
                {engine.strategy === "avellaneda" && engine.asHalfSpreadBps != null && (
                  <>
                    <div className="kv">
                      <span className="k">QUOTE SPREAD</span>
                      <span className="mono v-mint">±{engine.asHalfSpreadBps.toFixed(1)} bps</span>
                    </div>
                    <div className="kv">
                      <span className="k">INV SKEW</span>
                      <span className={`mono ${Math.abs(engine.asSkewBps ?? 0) > 0.1 ? "v-warn" : ""}`}>
                        {(engine.asSkewBps ?? 0) >= 0 ? "+" : ""}
                        {(engine.asSkewBps ?? 0).toFixed(1)} bps
                      </span>
                    </div>
                  </>
                )}
                <div className="kv">
                  <span className="k">ROUND TRIPS</span>
                  <span className="mono">{engine.roundTrips}</span>
                </div>
                <div className="kv">
                  <span className="k">BOOSTED VOL</span>
                  <span className="mono v-mint">
                    ${(engine.boostedVolumeUsd ?? engine.weekVolumeUsd * 2).toFixed(0)}
                  </span>
                </div>
                <div className="kv">
                  <span className="k">FUNDING</span>
                  <span className={`mono ${engine.fundingAprPct >= 0 ? "v-mint" : "v-warn"}`}>
                    {engine.fundingAprPct >= 0 ? "+" : ""}
                    {engine.fundingAprPct.toFixed(1)}% APR
                  </span>
                </div>
                <div className="kv">
                  <span className="k">COST / $1K VOL</span>
                  <span className="mono">
                    {engine.costPer1kBoostedUsd != null
                      ? engine.costPer1kBoostedUsd <= 0
                        ? "FREE"
                        : `$${engine.costPer1kBoostedUsd.toFixed(3)}`
                      : "—"}
                  </span>
                </div>
                {engine.spreadCaptureUsd != null && (
                  <div className="kv">
                    <span className="k">SPREAD CAPTURED</span>
                    <span className={`mono ${engine.spreadCaptureUsd > 0 ? "v-mint" : ""}`}>
                      {engine.spreadCaptureUsd >= 0 ? "+" : "−"}${Math.abs(engine.spreadCaptureUsd).toFixed(3)}
                    </span>
                  </div>
                )}
                {engine.netPnlUsd != null && (
                  <div className="kv">
                    <span className="k">NET PnL</span>
                    <span className={`mono ${engine.netPnlUsd >= 0 ? "v-mint" : "v-warn"}`}>
                      {engine.netPnlUsd >= 0 ? "+" : "−"}${Math.abs(engine.netPnlUsd).toFixed(3)}
                    </span>
                  </div>
                )}
                {engine.history && engine.history.length > 1 && (
                  <HistorySpark history={engine.history} />
                )}
                <div className="foot">
                  Same engine ships as a headless bot — paper by default, live with your keys. Volume here is the
                  bot's own session, not yours.
                </div>
              </>
            ) : (
              <div className="empty">waiting for /status.json…</div>
            )}
          </section>
        </div>
      </div>

      <div className="bottom-panel">
        <div className="bottom-tabs" role="tablist">
          <button role="tab" aria-selected={tab === "portfolio"} className={tab === "portfolio" ? "active" : ""} onClick={() => setTab("portfolio")}>
            MY PORTFOLIO
          </button>
          <button role="tab" aria-selected={tab === "engine"} className={tab === "engine" ? "active" : ""} onClick={() => setTab("engine")}>
            ENGINE LOG
          </button>
          <button role="tab" aria-selected={tab === "compare"} className={tab === "compare" ? "active" : ""} onClick={() => setTab("compare")}>
            A/B COMPARE
          </button>
          <button role="tab" aria-selected={tab === "epochs"} className={tab === "epochs" ? "active" : ""} onClick={() => setTab("epochs")}>
            ON-CHAIN EPOCHS {epochs.length > 0 ? `(${epochs.length})` : ""}
          </button>
          <button role="tab" aria-selected={tab === "estimator"} className={tab === "estimator" ? "active" : ""} onClick={() => setTab("estimator")}>
            POINTS ESTIMATOR
          </button>
          <span className="tab-meta">
            {tab === "portfolio"
              ? session?.status === "ready"
                ? "your live account · Perpl"
                : "connect a key to see yours"
              : tab === "engine"
                ? engine
                  ? `paper session · live mainnet data · ${engine.state}`
                  : "connecting…"
                : tab === "compare"
                  ? "two live engines · same $100 hedge"
                : tab === "estimator"
                  ? "live fees · funding · boost"
                  : latestEpoch
                    ? `latest: #${latestEpoch.epochId} · ${latestEpoch.closed ? "closed" : "open"} · ${ago(latestEpoch.openedAt)}`
                    : "HedgeRegistry"}
          </span>
        </div>
        <div className="bottom-body">
          {tab === "portfolio" ? (
            <Portfolio session={session} mark={mid} />
          ) : tab === "engine" ? (
            <EngineTerminal status={engine} />
          ) : tab === "compare" ? (
            <StrategyCompare churn={churnEngine} as={asEngine} />
          ) : tab === "estimator" ? (
            <Estimator market={market} fundingApr={fundingApr} />
          ) : (
            <EpochHistory epochs={epochs} loading={epochsLoading} />
          )}
        </div>
      </div>

      <footer>
        <span>ZeroDrift · powered by NullTerminal · built for Monad Spark · not financial advice</span>
        <span>
          HedgeRegistry{" "}
          <a
            href="https://monadscan.com/address/0x24BD952B9BaD090Eab24A1a91948fA130c8D3A48"
            target="_blank"
            rel="noreferrer"
          >
            0x24BD…3A48
          </a>{" "}
          · Monad 143
        </span>
      </footer>
    </div>
  );
}
