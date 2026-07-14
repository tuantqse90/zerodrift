import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Address } from "viem";
import { BookLadder } from "./components/BookLadder";
import { DriftGauge } from "./components/DriftGauge";
import { EngineTerminal, useEngineStatus } from "./components/EngineTerminal";
import { EpochHistory } from "./components/EpochHistory";
import { HedgeConsole } from "./components/HedgeConsole";
import { PriceChart, useCandles } from "./components/PriceChart";
import { fetchEpochFeed, publicClient, scanRecentOpeners, type EpochRow } from "./lib/chain";
import {
  fetchPerplMarket,
  fundingAprPct,
  PerplFeed,
  type PerplBook,
  type PerplMarketInfo,
} from "./lib/perplFeed";
import { spotPriceUsd } from "./lib/nt";
import { loadKeys, TradingSession } from "./lib/perplTrading";

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
  const [tab, setTab] = useState<"engine" | "epochs">("engine");
  const feedRef = useRef<PerplFeed | null>(null);
  const blockNumber = useBlockNumber();
  const engine = useEngineStatus();
  const candles = useCandles(market);

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
            if (feed.funding) setFundingApr(fundingAprPct(feed.funding.rateMicros, m.fundingIntervalSec));
          });
        };
        feed.start();

        const keys = loadKeys();
        if (keys) {
          const s = new TradingSession(m, keys);
          s.start();
          setSession(s);
        }
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

  const mid = book ? (book.bids[0].px + book.asks[0].px) / 2 : null;
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

  const shortsEarn = fundingApr !== null && fundingApr > 0;
  const latestEpoch = epochs[0];

  return (
    <div className="app">
      <nav className="topbar">
        <div className="brand">
          <span>
            <span className="zero">Zero</span>Drift
          </span>
          <span className="by">
            by{" "}
            <a href="https://nullterminal.xyz" target="_blank" rel="noreferrer">
              NullTerminal
            </a>
          </span>
        </div>
        <span className="tagline">Delta-neutral Perpl points farming — hold MON, short the perp, farm the volume.</span>
        <span className="spacer" />
        <div className="nav-right">
          <span className={`live-dot ${book ? "on" : ""}`}>
            <i />
            PERPL
          </span>
          <span className={`live-dot ${blockNumber ? "on" : ""}`}>
            <i />
            MONAD
          </span>
          <span className={`live-dot ${engine ? "on" : ""}`}>
            <i />
            ENGINE
          </span>
        </div>
      </nav>

      <div className="statsbar" aria-label="Live market stats">
        <span className="pair">
          <span className="dot" />
          MON-PERP
        </span>
        <span>
          <span className="t-label">MARK</span>
          <span className="t-val">{mid ? `$${mid.toFixed(6)}` : "—"}</span>
        </span>
        <span>
          <span className="t-label">SPOT · NT</span>
          <span className="t-val">{spotPx ? `$${spotPx.toFixed(6)}` : "—"}</span>
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
          <span className="t-val">{spreadBps !== null ? `${spreadBps.toFixed(2)}bps` : "—"}</span>
        </span>
        <span>
          <span className="t-label">ENGINE</span>
          <span className="t-val">
            {engine ? `${engine.state} · ${engine.roundTrips} RT · $${engine.weekVolumeUsd.toFixed(0)} wk` : "—"}
          </span>
        </span>
        <span>
          <span className="t-label">BLOCK</span>
          <span className="t-val">{blockNumber ? blockNumber.toLocaleString() : "—"}</span>
        </span>
      </div>

      <div className="term-grid">
        <div className="col">
          <section className="card glass" style={{ flex: 1 }}>
            <div className="card-head">
              <span className="title">
                <i />
                MON-perp · 15m
              </span>
              <span className="meta mono">
                Perpl candles · last {candles.length ? candles[candles.length - 1].c.toFixed(6) : "—"}
              </span>
            </div>
            <PriceChart market={market} candles={candles} />
          </section>
          <div className="gauge-slim">
            <DriftGauge
              spotMon={hedgeSpotMon}
              spotUsd={hedgeSpotMon * (spotPx ?? mid ?? 0)}
              shortMon={shortMon}
              shortUsd={shortMon * (mid ?? 0)}
              deltaPct={deltaPct}
              stateLabel={stateLabel}
              hasHedge={hasHedge}
            />
          </div>
        </div>

        <div className="col book-col">
          <section className="card glass book-card">
            <div className="card-head">
              <span className="title">
                <i />
                Book
              </span>
              <span className="meta mono">on-chain CLOB</span>
            </div>
            <BookLadder book={book} depth={9} />
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
        </div>
      </div>

      <div className="bottom-panel">
        <div className="bottom-tabs" role="tablist">
          <button role="tab" aria-selected={tab === "engine"} className={tab === "engine" ? "active" : ""} onClick={() => setTab("engine")}>
            ENGINE LOG
          </button>
          <button role="tab" aria-selected={tab === "epochs"} className={tab === "epochs" ? "active" : ""} onClick={() => setTab("epochs")}>
            ON-CHAIN EPOCHS {epochs.length > 0 ? `(${epochs.length})` : ""}
          </button>
          <span className="tab-meta">
            {tab === "engine"
              ? engine
                ? `paper session · live mainnet data · ${engine.state}`
                : "connecting…"
              : latestEpoch
                ? `latest: #${latestEpoch.epochId} · ${latestEpoch.closed ? "closed" : "open"} · ${ago(latestEpoch.openedAt)}`
                : "HedgeRegistry"}
          </span>
        </div>
        <div className="bottom-body">
          {tab === "engine" ? (
            <EngineTerminal status={engine} />
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
