// Guide — the ZeroDrift how-to. A standalone tutorial view reached at #/guide:
// what delta-neutral points farming is, how to use the terminal, how to go live,
// and the honest bits (what earns points, what doesn't, the risks).

import { useEffect, useState } from "react";
import { fetchPerplMarket, type PerplMarketInfo } from "../lib/perplFeed";

function CopyLine({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="copy-line mono"
      onClick={() => {
        navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
      aria-label="Copy command"
    >
      <span>{text}</span>
      <span className="copy-tag">{copied ? "copied" : "copy"}</span>
    </button>
  );
}

export function Guide() {
  const [market, setMarket] = useState<PerplMarketInfo | null>(null);
  useEffect(() => {
    fetchPerplMarket("MON").then(setMarket).catch(() => {});
    window.scrollTo(0, 0);
  }, []);

  const maker = market ? (market.makerFeeMicros / 100).toFixed(1) : "0.9";
  const taker = market ? (market.takerFeeMicros / 100).toFixed(1) : "6.9";
  const boost = market ? (market.pointsBoostBps / 10_000).toFixed(0) : "2";

  return (
    <div className="wrap guide">
      <nav className="nav">
        <div className="brand">
          <span>
            <span className="zero">Zero</span>Drift
          </span>
          <span className="by">Guide</span>
        </div>
        <a className="btn secondary sm" href="#/">
          ← Back to terminal
        </a>
      </nav>

      <header className="g-hero">
        <span className="pill mono">
          <i />
          HOW IT WORKS · 3 MIN READ
        </span>
        <h1>
          Farm Perpl points <span className="violet">without betting on price</span>
        </h1>
        <p className="g-lead">
          ZeroDrift holds MON and shorts the same size on Perpl, so price moves cancel out. You keep farming the{" "}
          {boost}×-boosted MON market with maker orders while price does whatever it wants. Here's the whole thing.
        </p>
      </header>

      {/* ── the core idea ── */}
      <section className="g-sec">
        <div className="g-num">01</div>
        <div className="g-body">
          <h2>The idea: two legs that cancel</h2>
          <p className="g-p">
            A points program pays you for <b>trading volume</b>. The naive way — just trade back and forth — costs you
            taker fees and leaves you exposed to price. ZeroDrift removes both by running two opposite legs at equal
            size:
          </p>
          <div className="g-legs">
            <div className="g-leg long">
              <div className="g-leg-tag">LONG</div>
              <div className="g-leg-title">Spot MON</div>
              <div className="g-leg-desc">
                The MON in your wallet, bought via the NullTerminal aggregator. Goes up when MON goes up.
              </div>
            </div>
            <div className="g-plus">+</div>
            <div className="g-leg short">
              <div className="g-leg-tag">SHORT</div>
              <div className="g-leg-title">MON perp on Perpl</div>
              <div className="g-leg-desc">
                An equal-size short on Perpl's perpetual. Goes up when MON goes <i>down</i>.
              </div>
            </div>
            <div className="g-eq">=</div>
            <div className="g-leg flat">
              <div className="g-leg-tag">RESULT</div>
              <div className="g-leg-title">Delta ≈ 0</div>
              <div className="g-leg-desc">Price exposure nets to zero. MON can 2× or halve — your PnL doesn't move.</div>
            </div>
          </div>
        </div>
      </section>

      {/* ── churn ── */}
      <section className="g-sec">
        <div className="g-num">02</div>
        <div className="g-body">
          <h2>Churn the volume — with maker orders</h2>
          <p className="g-p">
            Volume is the point signal, so ZeroDrift oscillates the short: it closes a slice and re-opens it with{" "}
            <b>PostOnly maker orders</b> ({maker}bps, vs {taker}bps taker) every few minutes. Each round-trip is two
            maker fills of volume for almost nothing — and the MON market pays a <b>{boost}× points boost</b>.
          </p>
          <p className="g-p">
            The engine is <b>funding-adaptive</b>: when the funding rate pays shorts (it often does), it churns
            aggressively — bigger clips, shorter interval — because volume is nearly free <i>and</i> you're being paid
            to hold the short. When funding turns expensive, it backs off automatically.
          </p>
        </div>
      </section>

      {/* ── economics ── */}
      <section className="g-sec">
        <div className="g-num">03</div>
        <div className="g-body">
          <h2>The honest economics</h2>
          <p className="g-p">
            It's not free — it's <b>cheap and hedged</b>. Your only real costs are fees minus funding:
          </p>
          <table className="g-table mono">
            <tbody>
              <tr>
                <td>Maker fee (per fill)</td>
                <td className="mint">{maker} bps</td>
              </tr>
              <tr>
                <td>Churn round-trip cost</td>
                <td>~{market ? ((market.makerFeeMicros / 100) * 2).toFixed(1) : "1.8"} bps</td>
              </tr>
              <tr>
                <td>Points boost (MON market)</td>
                <td className="violet">{boost}×</td>
              </tr>
              <tr>
                <td>Funding (paid to the short, when positive)</td>
                <td className="mint">offsets fees — often net-positive</td>
              </tr>
            </tbody>
          </table>
          <p className="g-p g-muted">
            When funding pays more than the fees cost, farming is literally <b>free</b> (net-positive carry). The
            live <a href="#/">Points Estimator</a> computes this for any size using the current numbers.
          </p>
        </div>
      </section>

      {/* ── using the terminal ── */}
      <section className="g-sec">
        <div className="g-num">04</div>
        <div className="g-body">
          <h2>Using the terminal</h2>
          <p className="g-p">Everything is live and read-only until you connect — poke around first.</p>
          <ul className="g-list">
            <li>
              <b>Chart + book</b> — live MON-perp price (5m/15m/1h/4h) and on-chain order book, straight from Perpl.
            </li>
            <li>
              <b>Drift indicator</b> — the spirit-level gauge; a healthy hedge keeps the bubble on the center notch.
            </li>
            <li>
              <b>Hedge console</b> — connect a wallet, paste a Perpl trade key, and open/close a hedge with maker
              orders. Keys stay in your browser and <b>can't withdraw funds</b>.
            </li>
            <li>
              <b>Engine session</b> — a real bot runs 24/7 in paper mode; its live state, strategy, volume and cost
              stream here.
            </li>
            <li>
              <b>Points Estimator</b> — plug in a size, compare Conservative vs Adaptive, see cost per $1k of boosted
              volume.
            </li>
          </ul>
        </div>
      </section>

      {/* ── go live ── */}
      <section className="g-sec">
        <div className="g-num">05</div>
        <div className="g-body">
          <h2>Going live (real funds)</h2>
          <p className="g-p">
            The terminal farms with your keys in-browser; the headless bot farms unattended. Both need a funded wallet
            and a Perpl trade key. Three steps:
          </p>
          <ol className="g-steps">
            <li>
              <b>Fund a fresh wallet</b> — AUSD (Perpl collateral, ≥$10), USDC for the spot leg, a little MON for gas.
              Connect it once at <a href="https://app.perpl.xyz" target="_blank" rel="noreferrer">app.perpl.xyz</a> to
              create your Perpl profile.
            </li>
            <li>
              <b>Get a trade-scope key</b> — create one at{" "}
              <a href="https://app.perpl.xyz/apikeys" target="_blank" rel="noreferrer">app.perpl.xyz/apikeys</a> and
              paste the token + Ed25519 private key into the Hedge console. (For the bot: <code>bun run hedger:enroll</code>.)
            </li>
            <li>
              <b>Open a hedge</b> — from the console, or run the bot live:
              <CopyLine text="HEDGER_LIVE=true bun run hedger" />
            </li>
          </ol>
          <p className="g-p g-muted">
            Safety by default: paper mode until keys are set, a hard daily taker cap, funding auto-pause, margin
            auto-unwind, and Perpl API keys that can never withdraw.
          </p>
        </div>
      </section>

      {/* ── honest bits ── */}
      <section className="g-sec">
        <div className="g-num">06</div>
        <div className="g-body">
          <h2>The fine print (read this)</h2>
          <div className="g-callouts">
            <div className="g-callout">
              <div className="g-callout-h">Points come from Perpl trading only</div>
              <p>
                mPoints are awarded by Perpl for your <b>volume on Perpl</b> — the short + the churn. The on-chain{" "}
                <b>HedgeRegistry</b> contract is a public <i>receipt</i> of each hedge, not a point source; writing to
                it costs a little gas and earns nothing on its own.
              </p>
            </div>
            <div className="g-callout">
              <div className="g-callout-h">Delta-neutral ≠ margin-neutral</div>
              <p>
                If MON pumps hard, the short's margin is pressured even though your net PnL is flat. ZeroDrift runs low
                leverage (2×) and auto-unwinds before maintenance margin — but keep collateral healthy.
              </p>
            </div>
            <div className="g-callout">
              <div className="g-callout-h">Don't wash-trade</div>
              <p>
                Points programs flag mechanical churn. ZeroDrift jitters sizes and holds the base position for the
                long haul; keep sizes varied and don't hammer sub-minute cycles.
              </p>
            </div>
            <div className="g-callout">
              <div className="g-callout-h">Paper vs live</div>
              <p>
                The engine on this site is <b>paper</b> (simulated fills on live data) — it earns <b>zero real
                points</b>. Real points need a live session with your own keys and funds.
              </p>
            </div>
          </div>
        </div>
      </section>

      <div className="g-cta">
        <a className="btn" href="#/">
          Open the terminal →
        </a>
        <a
          className="btn secondary"
          href="https://monadscan.com/address/0x24BD952B9BaD090Eab24A1a91948fA130c8D3A48"
          target="_blank"
          rel="noreferrer"
        >
          View the contract
        </a>
      </div>

      <footer>
        <span>ZeroDrift · powered by NullTerminal · built for Monad Spark · not financial advice</span>
        <span>Monad 143</span>
      </footer>
    </div>
  );
}
