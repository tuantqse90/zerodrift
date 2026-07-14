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

  const TickerItems = ({ ariaHidden }: { ariaHidden?: boolean }) => (
    <span style={{ display: "inline-flex", gap: 44 }} aria-hidden={ariaHidden || undefined}>

          <span>
            <span className="t-label">MON-PERP</span>
            <span className="t-val">{mid ? `$${mid.toFixed(6)}` : "—"}</span>
          </span>
          <span>
            <span className="t-label">SPOT</span>
            <span className="t-val">{spotPx ? `$${spotPx.toFixed(6)}` : "—"}</span>
          </span>
          <span>
            <span className="t-label">FUNDING</span>
            <span className={`t-val ${fundingApr === null ? "" : shortsEarn ? "up" : "down"}`}>
              {fundingApr === null ? "—" : `${fundingApr > 0 ? "+" : ""}${fundingApr.toFixed(1)}% APR`}
            </span>
            <span className="t-label" style={{ marginLeft: 7 }}>
              {fundingApr === null ? "" : shortsEarn ? "SHORTS EARN" : "SHORTS PAY"}
            </span>
          </span>
          <span>
            <span className="t-label">MAKER</span>
            <span className="t-val up">{market ? `${(market.makerFeeMicros / 100).toFixed(1)}bps` : "—"}</span>
          </span>
          <span>
            <span className="t-label">TAKER</span>
            <span className="t-val">{market ? `${(market.takerFeeMicros / 100).toFixed(1)}bps` : "—"}</span>
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
            <span className="t-label">BLOCK</span>
            <span className="t-val">{blockNumber ? blockNumber.toLocaleString() : "—"}</span>
          </span>
    </span>
  );

  return (
    <div className="wrap">
      <a href="#console" className="sr-only">
        Skip to hedge console
      </a>

      <nav className="nav">
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
        <div className="nav-right">
          <span className={`live-dot ${book ? "on" : ""}`}>
            <i />
            PERPL FEED
          </span>
          <span className={`live-dot ${blockNumber ? "on" : ""}`}>
            <i />
            MONAD
          </span>
        </div>
      </nav>

      <div className="ticker mono" aria-label="Live market data">
        <div className="track">
          <TickerItems />
          <TickerItems ariaHidden />
        </div>
      </div>

      <header className="hero">
        <span className="pill mono">
          <i />
          LIVE ON MONAD MAINNET · PURPLE SUMMER
        </span>
        <h1>
          Farm Perpl points, <span className="violet">stay flat</span>
        </h1>
        <p className="sub">
          Hold MON as the long, short the same size on <strong>Perpl</strong> with maker orders, and churn volume
          through the <strong>2×-boosted MON market</strong> — price moves cancel out, the points don't. Every hedge
          is attested on-chain.
        </p>
      </header>

      <div className="duo" id="console">
        <HedgeConsole
          market={market}
          book={book}
          session={session}
          setSession={setSession}
          onHedgeChange={onHedgeChange}
        />
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

      <section className="card glass" style={{ marginBottom: 26 }}>
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

      <div className="statstrip">
        <div className="inner glass">
          <div className="stat">
            <div className="v mint">{market ? `${(market.makerFeeMicros / 100).toFixed(1)}bps` : "—"}</div>
            <div className="k">MAKER FEE</div>
          </div>
          <div className="stat">
            <div className="v">{market ? `~${((market.makerFeeMicros / 100) * 2).toFixed(1)}bps` : "—"}</div>
            <div className="k">CHURN ROUND TRIP</div>
          </div>
          <div className="stat">
            <div className="v">{market ? `${(market.pointsBoostBps / 10_000).toFixed(0)}×` : "—"}</div>
            <div className="k">MON POINTS BOOST</div>
          </div>
          <div className="stat">
            <div className={`v ${shortsEarn ? "mint" : "warn"}`}>
              {fundingApr === null ? "—" : `${fundingApr > 0 ? "+" : ""}${fundingApr.toFixed(1)}%`}
            </div>
            <div className="k">FUNDING APR</div>
          </div>
          <div className="stat">
            <div className="v">{engine ? engine.roundTrips : "—"}</div>
            <div className="k">ENGINE ROUND TRIPS</div>
          </div>
          <div className="stat">
            <div className="v mint">{engine ? `$${engine.weekVolumeUsd.toFixed(0)}` : "—"}</div>
            <div className="k">ENGINE WEEK VOLUME</div>
          </div>
        </div>
      </div>

      {latestEpoch && (
        <div className="live-line">
          <span className="pill">
            <i />
            <b>EPOCH #{latestEpoch.epochId}</b>
            <span className="addr">${latestEpoch.notionalUsd.toFixed(2)}</span>
            by {latestEpoch.owner.slice(0, 6)}…{latestEpoch.owner.slice(-4)} ·{" "}
            {latestEpoch.closed ? "closed" : "open"} · {ago(latestEpoch.openedAt)}
          </span>
        </div>
      )}

      <EngineTerminal status={engine} />

      <div className="deck">
        <section className="card glass">
          <div className="card-head">
            <span className="title">
              <i />
              MON-perp book
            </span>
            <span className="meta mono">Perpl on-chain CLOB</span>
          </div>
          <p className="card-sub">Live depth. Maker orders join the touch — no impact, 0.9bps.</p>
          <BookLadder book={book} />
        </section>
        <section className="card glass">
          <div className="card-head">
            <span className="title">
              <i />
              On-chain epochs
            </span>
            <span className="meta mono">HedgeRegistry</span>
          </div>
          <p className="card-sub">Every hedge writes an epoch on-chain — public proof of delta-neutral farming.</p>
          <EpochHistory epochs={epochs} loading={epochsLoading} />
        </section>
      </div>

      <div className="features">
        <div className="feature glass">
          <div className="f-icon">δ→0</div>
          <h3>Delta-neutral by construction</h3>
          <p>
            Spot long and perp short cancel out. MON can double or halve — your PnL is fees and funding, not
            direction.
          </p>
        </div>
        <div className="feature glass">
          <div className="f-icon">0.9bps</div>
          <h3>Maker-only churn</h3>
          <p>
            PostOnly orders at the touch, re-posted automatically. A full churn round trip costs ~1.8bps against a 2×
            points boost — and funding currently pays the short.
          </p>
        </div>
        <div className="feature glass">
          <div className="f-icon">⛓</div>
          <h3>Attested on-chain</h3>
          <p>
            The HedgeRegistry contract logs every epoch — open, close, notional — permissionless and verified on
            MonadScan. No trust, just receipts.
          </p>
        </div>
      </div>

      <div className="callout">
        <div className="c-icon">＄</div>
        <div className="c-text">
          <b>Run it headless</b>
          <p>
            The same engine ships as a bot — <code>bun run hedger</code> — with Telegram alerts, PnL decomposition,
            and paper mode by default. Point it at your keys and it farms while you sleep.
          </p>
        </div>
        <a
          className="c-link"
          href="https://monadscan.com/address/0x24BD952B9BaD090Eab24A1a91948fA130c8D3A48"
          target="_blank"
          rel="noreferrer"
        >
          View the contract →
        </a>
      </div>

      <footer>
        <span>ZeroDrift · powered by NullTerminal · built for Monad Spark</span>
        <span>
          HedgeRegistry{" "}
          <a
            href="https://monadscan.com/address/0x24BD952B9BaD090Eab24A1a91948fA130c8D3A48"
            target="_blank"
            rel="noreferrer"
          >
            0x24BD…3A48
          </a>{" "}
          · Monad 143 · not financial advice
        </span>
      </footer>
    </div>
  );
}
