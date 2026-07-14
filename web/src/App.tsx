import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BookLadder } from "./components/BookLadder";
import { DriftGauge } from "./components/DriftGauge";
import { EpochHistory } from "./components/EpochHistory";
import { HedgeConsole } from "./components/HedgeConsole";
import { fetchEpochFeed, scanRecentOpeners, type EpochRow } from "./lib/chain";
import type { Address } from "viem";
import {
  fetchPerplMarket,
  fundingAprPct,
  PerplFeed,
  type PerplBook,
  type PerplMarketInfo,
} from "./lib/perplFeed";
import { spotPriceUsd } from "./lib/nt";
import { loadKeys, TradingSession } from "./lib/perplTrading";

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

  // market + feed
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

        // resume a saved trading session
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

  // NT spot price
  useEffect(() => {
    const tick = () => spotPriceUsd().then((p) => p && setSpotPx(p));
    tick();
    const t = setInterval(tick, 20_000);
    return () => clearInterval(t);
  }, []);

  // registry epochs: featured farmers via views + live 100-block scans while open
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
  const pos = session?.position;
  const shortMon = pos?.side === "short" ? pos.sizeMon : 0;
  const hasHedge = hedgeSpotMon > 0 || shortMon > 0;
  const deltaMon = hedgeSpotMon - shortMon;
  const deltaPct = hasHedge && hedgeSpotMon > 0 ? (deltaMon / hedgeSpotMon) * 100 : 0;

  const stateLabel = useMemo(() => {
    if (!book) return "CONNECTING";
    if (!hasHedge) return "READY — NO LIVE HEDGE";
    const abs = Math.abs(deltaPct);
    if (abs <= 1) return "HEDGED";
    if (abs <= 3) return "DRIFTING — REBALANCE SOON";
    return "REBALANCE NOW";
  }, [book, hasHedge, deltaPct]);

  const shortsEarn = fundingApr !== null && fundingApr > 0;

  return (
    <div className="wrap">
      <header className="topbar">
        <div className="wordmark" aria-label="ZeroDrift">
          ZER
          <span className="o" aria-hidden="true">
            <i />
          </span>
          DRIFT
        </div>
        <div className="topbar-right">
          <span className={`feed-dot ${book ? "live" : ""}`}>
            <i />
            {book ? "PERPL FEED LIVE" : "CONNECTING"}
          </span>
        </div>
      </header>

      <main>
        <p className="eyebrow">DELTA-NEUTRAL POINTS TERMINAL · MONAD MAINNET</p>
        <h1>
          Farm Perpl points. <span className="flat">Stay flat.</span>
        </h1>
        <p className="sub">
          Hold MON as the long. Short the same size on <strong>Perpl</strong> with PostOnly maker orders — 0.9bps
          instead of 6.9bps — and churn volume through the <strong>2x-boosted MON market</strong> while funding pays
          the short. Price moves cancel out; the points don't. Every hedge is attested on-chain.
        </p>

        <DriftGauge
          spotMon={hedgeSpotMon}
          spotUsd={hedgeSpotMon * (spotPx ?? mid ?? 0)}
          shortMon={shortMon}
          shortUsd={shortMon * (mid ?? 0)}
          deltaPct={deltaPct}
          stateLabel={stateLabel}
          hasHedge={hasHedge}
        />

        <section className="stats" aria-label="Live market stats">
          <div className="stat">
            <div className="k">MON-PERP MID</div>
            <div className="v">{mid ? `$${mid.toFixed(6)}` : "—"}</div>
          </div>
          <div className="stat">
            <div className="k">SPOT (NULLTERMINAL)</div>
            <div className="v">{spotPx ? `$${spotPx.toFixed(6)}` : "—"}</div>
          </div>
          <div className="stat">
            <div className="k">FUNDING · 1H</div>
            <div className={`v ${fundingApr === null ? "" : shortsEarn ? "earn" : "pay"}`}>
              {fundingApr === null ? "—" : `${fundingApr > 0 ? "+" : ""}${fundingApr.toFixed(1)}%`}
              <small>{fundingApr === null ? "" : shortsEarn ? "APR · shorts earn" : "APR · shorts pay"}</small>
            </div>
          </div>
          <div className="stat">
            <div className="k">MAKER FEE</div>
            <div className="v earn">
              {market ? (market.makerFeeMicros / 100).toFixed(1) : "—"}
              <small>bps vs {market ? (market.takerFeeMicros / 100).toFixed(1) : "—"} taker</small>
            </div>
          </div>
          <div className="stat">
            <div className="k">POINTS BOOST</div>
            <div className="v boost">
              {market ? `${(market.pointsBoostBps / 10_000).toFixed(0)}x` : "—"}
              <small>MON market</small>
            </div>
          </div>
        </section>

        <div className="main-grid">
          <HedgeConsole
            market={market}
            book={book}
            session={session}
            setSession={setSession}
            onHedgeChange={onHedgeChange}
          />
          <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
            <div className="card">
              <h2>MON-PERP BOOK</h2>
              <p className="card-sub">Live depth from Perpl's on-chain CLOB. Maker orders join the touch.</p>
              <BookLadder book={book} />
            </div>
            <div className="card">
              <h2>ON-CHAIN EPOCHS</h2>
              <p className="card-sub">
                Every hedge writes an epoch to the HedgeRegistry — public, permissionless proof of delta-neutral
                farming.
              </p>
              <EpochHistory epochs={epochs} loading={epochsLoading} />
            </div>
          </div>
        </div>

        <section className="how" aria-label="How it works">
          <div className="step">
            <div className="glyph">[ LONG ]</div>
            <h3>Hold spot MON</h3>
            <p>
              The MON in your wallet is the long leg. Need more? Swap anything on Monad for MON through NullTerminal's
              aggregator at the best route.
            </p>
          </div>
          <div className="step">
            <div className="glyph">[ SHORT ]</div>
            <h3>Short the perp on Perpl</h3>
            <p>
              The console works PostOnly orders at the touch — maker fees, no price impact. Delta pins to zero: MON up
              or down, the hedge doesn't care.
            </p>
          </div>
          <div className="step">
            <div className="glyph">[ CHURN ]</div>
            <h3>Farm the volume</h3>
            <p>
              Purple Summer points follow weekly volume, and the MON market pays 2x. Churn re-opens a slice every 15
              minutes at ~1.8bps a round trip.
            </p>
          </div>
        </section>
      </main>

      <footer>
        <span>ZERODRIFT · powered by NullTerminal</span>
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
