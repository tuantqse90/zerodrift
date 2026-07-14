import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Address } from "viem";
import { BookLadder } from "./components/BookLadder";
import { DriftGauge } from "./components/DriftGauge";
import { EpochHistory } from "./components/EpochHistory";
import { HedgeConsole } from "./components/HedgeConsole";
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

function useUtcClock(): string {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return now.toISOString().slice(11, 19);
}

function useBlockNumber(): bigint | null {
  const [block, setBlock] = useState<bigint | null>(null);
  useEffect(() => {
    const tick = () => publicClient.getBlockNumber().then(setBlock).catch(() => {});
    tick();
    const t = setInterval(tick, 5000);
    return () => clearInterval(t);
  }, []);
  return block;
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
  const clock = useUtcClock();
  const blockNumber = useBlockNumber();

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
    const t = setInterval(tick, 20_000);
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

  return (
    <div className="unit boot">
      <span className="screw tl" aria-hidden="true" />
      <span className="screw tr" aria-hidden="true" />
      <span className="screw bl" aria-hidden="true" />
      <span className="screw br" aria-hidden="true" />

      <header className="headstrip">
        <div className="wordmark" aria-label="ZeroDrift">
          ZER
          <span className="o" aria-hidden="true">
            <i />
          </span>
          DRIFT
          <span className="unit-no">UNIT 001</span>
        </div>

        <div className="annunciators" role="status" aria-label="System status">
          <span className={`lamp ${book ? "on" : ""}`}>
            <i />
            FEED
          </span>
          <span className={`lamp ${blockNumber ? "on" : ""}`}>
            <i />
            CHAIN
          </span>
          <span
            className={`lamp ${session?.status === "ready" ? "on" : session?.status === "auth-failed" ? "on err" : ""}`}
          >
            <i />
            KEYS
          </span>
        </div>

        <div style={{ display: "flex", gap: 8 }}>
          <span className="hud-chip">
            <span className="dim">BLK</span> {blockNumber ? blockNumber.toLocaleString() : "———"}
          </span>
          <span className="hud-chip">
            <span className="dim">UTC</span> {clock}
          </span>
        </div>
      </header>

      <main>
        <section className="hero">
          <div>
            <span className="placard">DELTA-NEUTRAL POINTS TERMINAL · MONAD 143</span>
            <h1>
              FARM PERPL POINTS.
              <span className="flat">STAY FLAT.</span>
            </h1>
            <p className="sub">
              Hold MON as the long. Short the same size on <strong>Perpl</strong> with PostOnly maker orders — 0.9bps
              instead of 6.9bps — and churn volume through the <strong>2x-boosted MON market</strong> while funding
              pays the short. Price moves cancel out; the points don't. Every hedge is attested on-chain.
            </p>
          </div>

          <div className="readouts" aria-label="Live market readouts">
            <div className="lcd">
              <div className="k">MON-PERP MID</div>
              <div className="v">{mid ? mid.toFixed(6) : "——————"}</div>
            </div>
            <div className="lcd">
              <div className="k">SPOT · NULLTERMINAL</div>
              <div className="v">{spotPx ? spotPx.toFixed(6) : "——————"}</div>
            </div>
            <div className="lcd">
              <div className="k">FUNDING · 1H</div>
              <div className={`v ${fundingApr === null ? "" : shortsEarn ? "" : "amber"}`}>
                {fundingApr === null ? "———" : `${fundingApr > 0 ? "+" : ""}${fundingApr.toFixed(1)}`}
                <small>{fundingApr === null ? "" : `% APR · SHORTS ${shortsEarn ? "EARN" : "PAY"}`}</small>
              </div>
            </div>
            <div className="lcd">
              <div className="k">MAKER FEE</div>
              <div className="v">
                {market ? (market.makerFeeMicros / 100).toFixed(1) : "——"}
                <small>BPS · TAKER {market ? (market.takerFeeMicros / 100).toFixed(1) : "——"}</small>
              </div>
            </div>
            <div className="lcd wide">
              <div className="k">POINTS BOOST · PURPLE SUMMER</div>
              <div className="v violet">
                {market ? `${(market.pointsBoostBps / 10_000).toFixed(0)}×` : "——"}
                <small>MON MARKET · WEEKLY MPOINTS ∝ VOLUME</small>
              </div>
            </div>
          </div>
        </section>

        <DriftGauge
          spotMon={hedgeSpotMon}
          spotUsd={hedgeSpotMon * (spotPx ?? mid ?? 0)}
          shortMon={shortMon}
          shortUsd={shortMon * (mid ?? 0)}
          deltaPct={deltaPct}
          stateLabel={stateLabel}
          hasHedge={hasHedge}
        />

        <div className="deck">
          <HedgeConsole
            market={market}
            book={book}
            session={session}
            setSession={setSession}
            onHedgeChange={onHedgeChange}
          />
          <div className="deck-col">
            <section className="panel">
              <span className="placard tab">MON-PERP BOOK · LIVE</span>
              <p className="panel-sub">Depth from Perpl's on-chain CLOB. Maker orders join the touch.</p>
              <div className="screen-inset">
                <BookLadder book={book} />
              </div>
            </section>
            <section className="panel">
              <span className="placard tab">ON-CHAIN EPOCHS · HEDGEREGISTRY</span>
              <p className="panel-sub">
                Every hedge writes an epoch on-chain — public, permissionless proof of delta-neutral farming.
              </p>
              <EpochHistory epochs={epochs} loading={epochsLoading} />
            </section>
          </div>
        </div>

        <section className="sequence" aria-label="Operation sequence">
          <span className="placard tab">OPERATION SEQUENCE</span>
          <div className="seq-flow">
            <div className="seq-step">
              <div className="seq-glyph">01 · LONG</div>
              <h3>Hold spot MON</h3>
              <p>
                The MON in your wallet is the long leg. Need more? Route any Monad token through NullTerminal's
                aggregator for the best fill.
              </p>
            </div>
            <span className="seq-arrow" aria-hidden="true">
              ─▶
            </span>
            <div className="seq-step">
              <div className="seq-glyph">02 · SHORT</div>
              <h3>Short the perp on Perpl</h3>
              <p>
                The console works PostOnly orders at the touch — maker fees, zero market impact. Delta pins to the
                center notch: MON up or down, the hedge doesn't care.
              </p>
            </div>
            <span className="seq-arrow" aria-hidden="true">
              ─▶
            </span>
            <div className="seq-step">
              <div className="seq-glyph">03 · CHURN</div>
              <h3>Farm the volume</h3>
              <p>
                Purple Summer mPoints follow weekly volume and the MON market pays 2×. Churn re-opens a slice every 15
                minutes at ~1.8bps a round trip.
              </p>
            </div>
          </div>
        </section>

        <footer className="serial-plate">
          <span>ZERODRIFT · POWERED BY NULLTERMINAL · BUILT FOR MONAD SPARK</span>
          <span>
            HEDGEREGISTRY{" "}
            <a
              href="https://monadscan.com/address/0x24BD952B9BaD090Eab24A1a91948fA130c8D3A48"
              target="_blank"
              rel="noreferrer"
            >
              0x24BD…3A48
            </a>{" "}
            · CHAIN 143 · NOT FINANCIAL ADVICE
          </span>
        </footer>
      </main>
    </div>
  );
}
