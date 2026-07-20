// HedgeConsole — NT swap-card idiom. Three states: connect wallet → add Perpl
// key → drive the hedge. Spot stays in the wallet; the short earns points on
// Perpl. Keys live in this browser only and can never withdraw funds.

import { useCallback, useEffect, useRef, useState } from "react";
import { formatEther, keccak256, toHex, type Address, type WalletClient } from "viem";
import { connectWallet, eagerConnect, monad, publicClient, REGISTRY_ABI, REGISTRY_ADDRESS, watchAccount } from "../lib/chain";
import type { PerplBook, PerplMarketInfo } from "../lib/perplFeed";
import { clearKeys, loadKeys, saveKeys, TradingSession, type FillEvent } from "../lib/perplTrading";
import { asClipSize, AS_DEFAULTS, avellanedaQuote, realizedVol } from "../lib/avellaneda";
import { CloudRunner } from "./CloudRunner";

type Strategy = "churn" | "avellaneda";

interface HedgeLocal {
  targetMon: number;
  openedAt: number;
  epochId: number | null;
  fillOids: number[];
}
// Hedge bookkeeping is PER WALLET: a target size / epoch id belongs to one account.
// A pre-scoping build stored one global blob — it is discarded on sight rather than
// migrated, because showing wallet A's hedge to wallet B (and sizing orders from it)
// is far worse than asking for the size again.
const LS_HEDGE = "zerodrift.hedge";
const hedgeKey = (address: string) => `${LS_HEDGE}:${address.toLowerCase()}`;

function loadHedge(address: string | null | undefined): HedgeLocal | null {
  localStorage.removeItem(LS_HEDGE); // legacy global blob — never trusted
  if (!address) return null;
  try {
    return JSON.parse(localStorage.getItem(hedgeKey(address)) || "null");
  } catch {
    return null;
  }
}
function saveHedge(address: string | null | undefined, h: HedgeLocal | null): void {
  if (!address) return;
  if (h) localStorage.setItem(hedgeKey(address), JSON.stringify(h));
  else localStorage.removeItem(hedgeKey(address));
}

interface Props {
  market: PerplMarketInfo | null;
  book: PerplBook | null;
  session: TradingSession | null;
  setSession: (s: TradingSession | null) => void;
  onHedgeChange: (spotMon: number, target: number, working: boolean) => void;
  /** Report the active identity (wallet + Perpl exchange account) for the header chip. */
  onIdentity?: (id: { address: Address; perplAccountId: number | null } | null) => void;
}

export function HedgeConsole({ market, book, session, setSession, onHedgeChange, onIdentity }: Props) {
  const [address, setAddress] = useState<Address | null>(null);
  const [wallet, setWallet] = useState<WalletClient | null>(null);
  const [monBalance, setMonBalance] = useState(0);
  const [apiKey, setApiKey] = useState("");
  const [edPriv, setEdPriv] = useState("");
  const [sizeInput, setSizeInput] = useState("");
  const [working, setWorking] = useState<"idle" | "opening" | "closing">("idle");
  const [churnOn, setChurnOn] = useState(false);
  const [strategy, setStrategy] = useState<Strategy>(() =>
    localStorage.getItem("zerodrift.strategy") === "avellaneda" ? "avellaneda" : "churn",
  );
  const pickStrategy = (s: Strategy) => {
    session?.cancelAllMine();
    setStrategy(s);
    localStorage.setItem("zerodrift.strategy", s);
  };
  const [note, setNote] = useState<{ kind: "ok" | "err" | ""; text: string }>({ kind: "", text: "" });
  const [hedge, setHedge] = useState<HedgeLocal | null>(null);
  const [keysVersion, setKeysVersion] = useState(0); // bump to reload keys for the active wallet
  const [, force] = useState(0);
  const rerender = useCallback(() => force((n) => n + 1), []);

  const churnPhase = useRef<"idle" | "closing" | "reopening">("idle");
  const churnSize = useRef(0);
  const lastChurnAt = useRef(Date.now());
  // Always-current book so the timer loops don't get reset on every WS tick (book
  // changes identity constantly — keeping it out of effect deps lets intervals fire).
  const bookRef = useRef(book);
  bookRef.current = book;
  const midBuf = useRef<number[]>([]); // rolling mids for the AS vol estimate
  const workStartRef = useRef(0); // when the current open/close began (for the taker fallback)
  const takerArmRef = useRef(false); // cancel-then-taker is two-phase to avoid double fills
  const armSnapRef = useRef<number | null>(null); // remaining snapshot for the quiescence gate
  const churnGoalRef = useRef(0); // short size a churn close leg is working DOWN to
  // Live hedge target the timer loops read. Keeping `hedge` itself OUT of effect deps
  // matters: every fill mutates it (fillOids) and would otherwise tear down/re-create
  // the loops — including the AS cleanup canceling both quotes on every single fill.
  const hedgeTargetRef = useRef(0);
  hedgeTargetRef.current = hedge?.targetMon ?? 0;

  useEffect(() => {
    if (!address) return;
    let live = true;
    const tick = async () => {
      try {
        const b = await publicClient.getBalance({ address });
        if (live) setMonBalance(Number(formatEther(b)));
      } catch {
        /* ignore */
      }
    };
    tick();
    const t = setInterval(tick, 15_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [address]);

  useEffect(() => {
    onHedgeChange(hedge ? hedge.targetMon : 0, hedge?.targetMon ?? 0, working !== "idle");
  }, [hedge, working, onHedgeChange]);

  useEffect(() => {
    if (!session) return;
    session.onChange = rerender;
    session.onFill = (f: FillEvent) => {
      setHedge((h) => {
        if (!h) return h;
        const next = { ...h, fillOids: [...new Set([...h.fillOids, f.oid])] };
        saveHedge(address, next);
        return next;
      });
      rerender();
    };
  }, [session, rerender]);

  // Surface WHICH wallet and WHICH Perpl account are live, so a wallet/account
  // mismatch (keys from a different exchange account) is visible at a glance.
  const perplAccountId = session?.account?.id ?? null;
  useEffect(() => {
    onIdentity?.(address ? { address, perplAccountId } : null);
  }, [address, perplAccountId, onIdentity]);

  // Hedge bookkeeping follows the active wallet: switching accounts must never leave
  // the previous wallet's target size / epoch id on screen (it would size real orders).
  useEffect(() => {
    setHedge(loadHedge(address));
    setSizeInput("");
    setChurnOn(false); // never carry auto-farm across an account switch
  }, [address]);

  // Silently restore the wallet on load if it's still authorized, then track account
  // switches / disconnects — so keys and the session re-scope to the active address.
  useEffect(() => {
    eagerConnect().then((c) => {
      if (c) {
        setAddress(c.address);
        setWallet(c.wallet);
      }
    });
    return watchAccount((c) => {
      setAddress(c?.address ?? null);
      setWallet(c?.wallet ?? null);
    });
  }, []);

  // The trading session is scoped PER WALLET: (re)start it from the connected wallet's
  // own stored keys whenever the address, market, or keys change — never a global blob.
  useEffect(() => {
    if (!address || !market) {
      setSession(null);
      return;
    }
    const k = loadKeys(address);
    if (!k) {
      setSession(null);
      return;
    }
    const s = new TradingSession(market, k);
    s.start();
    setSession(s);
    return () => s.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, market, keysVersion]);

  // maker keep-alive: keep one PostOnly order working while opening/closing
  useEffect(() => {
    if (working === "idle" || !session || !market) return;
    const minSize = 1 / 10 ** market.sizeDecimals; // smallest placeable order (1 MON here)
    workStartRef.current = Date.now();
    takerArmRef.current = false;
    const t = setInterval(() => {
      if (!session.ready) return;
      const b = bookRef.current;
      if (!b) return;
      const target = hedgeTargetRef.current;
      const pos = session.position;
      const shortMon = pos.side === "short" ? pos.sizeMon : 0;
      const opening = working === "opening";
      // Done when what's left is smaller than the minimum placeable order — a
      // fractional remainder would round to size 0 and spam rejected orders.
      const remaining = opening ? target - shortMon : shortMon;
      if (remaining < minSize) {
        // Cancel any remnant still resting (e.g. filled 19.6/20 → 0.4 left on the
        // book) so a late fill can't push the short past the target after we go idle.
        if (session.openOrders.size > 0) session.cancelAllMine();
        setWorking("idle");
        setNote({
          kind: "ok",
          text: opening ? `Hedged: ${shortMon.toFixed(1)} MON short.` : "Perp leg closed — back to plain spot MON.",
        });
        return;
      }
      const side = opening ? "short-open" : "short-close";
      const touch = opening ? b.asks[0].px : b.bids[0].px;
      const orders = [...session.openOrders.values()];

      // Taker fallback is TWO-PHASE: first cancel the maker, then only fire the
      // taker once the book confirms nothing rests. Doing both in one tick risks the
      // in-flight maker filling anyway → double position.
      if (takerArmRef.current) {
        if (orders.length > 0) {
          // Re-issue every tick (idempotent) — a cancel lost across a reconnect
          // would otherwise leave this branch waiting forever.
          session.cancelAllMine();
          armSnapRef.current = null;
          return;
        }
        // Quiescence gate: the fill (mt:25) / removal (mt:24) / position (mt:27)
        // frames are independent, so an empty book alone doesn't prove `remaining`
        // is current. Fire only after remaining holds steady across two ticks.
        if (armSnapRef.current === null || Math.abs(armSnapRef.current - remaining) > 1e-9) {
          armSnapRef.current = remaining;
          return;
        }
        armSnapRef.current = null;
        takerArmRef.current = false;
        workStartRef.current = Date.now();
        session.placeTaker(side, remaining, 100);
        setNote({ kind: "", text: `${opening ? "Opening" : "Closing"} via taker — the maker quote wasn't getting lifted.` });
        return;
      }
      if (Date.now() - workStartRef.current > 40_000) {
        takerArmRef.current = true;
        armSnapRef.current = null;
        if (orders.length > 0) session.cancelAllMine();
        return;
      }

      if (orders.length === 0) {
        session.placeMaker(side, touch, remaining);
      } else {
        // Follow the market: re-price the resting order if the touch moved away.
        const o = orders[0];
        if (Math.abs(o.px - touch) / touch > 0.0008) session.cancel(o.oid); // re-placed next tick
      }
    }, 4000);
    return () => clearInterval(t);
  }, [working, session, market]);

  // churn loop (tab-open only) — discrete close/re-open round-trips. Each leg works
  // toward an explicit GOAL size and re-places only the REMAINING amount — re-posting
  // the full clip after a partial fill + expiry would over-close/over-open the hedge.
  useEffect(() => {
    if (strategy !== "churn" || !churnOn || !session || !market) return;
    const minSize = 1 / 10 ** market.sizeDecimals;
    const t = setInterval(() => {
      if (!session.ready || working !== "idle") return;
      const b = bookRef.current;
      if (!b) return;
      const target = hedgeTargetRef.current;
      const pos = session.position;
      const shortMon = pos.side === "short" ? pos.sizeMon : 0;
      if (target <= 0) return;
      // Flat-short guard applies ONLY between cycles: mid-cycle a fully-closed leg
      // (shortMon 0 on a small hedge) must still reach the reopening transition.
      if (churnPhase.current === "idle" && shortMon < minSize) return;
      // One resting order at a time — also guards the INITIAL clip against a stale
      // quote left by a strategy switch that hasn't confirmed its cancel yet.
      if (session.openOrders.size > 0) return;

      if (churnPhase.current === "idle") {
        if (Date.now() - lastChurnAt.current < 15 * 60_000) return;
        const clip = Math.max(minSize, shortMon * 0.25 * (0.8 + Math.random() * 0.4));
        churnSize.current = clip;
        churnGoalRef.current = Math.max(0, shortMon - clip); // close leg works down to this
        churnPhase.current = "closing";
        lastChurnAt.current = Date.now();
        session.placeMaker("short-close", b.bids[0].px, clip);
        return;
      }

      if (churnPhase.current === "closing") {
        const remaining = shortMon - churnGoalRef.current;
        if (remaining < minSize) {
          churnPhase.current = "reopening";
          const reopen = target - shortMon;
          if (reopen >= minSize) session.placeMaker("short-open", b.asks[0].px, reopen);
        } else {
          session.placeMaker("short-close", b.bids[0].px, remaining);
        }
      } else {
        const remaining = target - shortMon;
        if (remaining < minSize) {
          churnPhase.current = "idle";
          setNote({
            kind: "ok",
            text: `Churn round-trip done — +$${(churnSize.current * b.bids[0].px * 2).toFixed(2)} maker volume.`,
          });
        } else {
          session.placeMaker("short-open", b.asks[0].px, remaining);
        }
      }
    }, 5000);
    return () => clearInterval(t);
  }, [strategy, churnOn, session, market, working]);

  // Turning auto-farm off OR leaving the churn strategy must not leave orders working
  // or a half-done churn phase behind (a stale "closing" phase would otherwise resume
  // with a stale goal when churn is next enabled).
  useEffect(() => {
    if ((!churnOn || strategy !== "churn") && session) {
      churnPhase.current = "idle";
      churnGoalRef.current = 0;
      churnSize.current = 0;
      if (!churnOn && session.openOrders.size > 0) session.cancelAllMine();
    }
  }, [churnOn, strategy, session]);

  // Avellaneda loop (tab-open only) — maintain a resting bid (buy-back) and ask
  // (add-short) around the AS reservation price; re-quote a side on price drift, pull
  // it when the short strays past the inventory band. Every order is a PostOnly maker.
  useEffect(() => {
    if (strategy !== "avellaneda" || !churnOn || !session || !market) return;
    const mkt = market;
    const t = setInterval(() => {
      if (!session.ready || working !== "idle") return;
      const b = bookRef.current;
      if (!b) return;
      const mid = (b.bids[0].px + b.asks[0].px) / 2;
      const buf = midBuf.current;
      buf.push(mid);
      if (buf.length > 40) buf.shift();

      const short = session.position.side === "short" ? session.position.sizeMon : 0;
      const target = hedgeTargetRef.current;
      if (short <= 0 || target <= 0) return;

      const q = avellanedaQuote({
        mid,
        volFrac: realizedVol(buf),
        inventoryDev: short - target,
        invScale: target,
        gamma: AS_DEFAULTS.gamma,
        kappa: AS_DEFAULTS.kappa,
        feeFrac: mkt.makerFeeMicros / 1e6,
        minHalfBps: AS_DEFAULTS.minHalfBps,
        maxHalfBps: AS_DEFAULTS.maxHalfBps,
        maxSkewBps: AS_DEFAULTS.maxSkewBps,
      });
      const tick = 1 / 10 ** mkt.priceDecimals;
      const clip = asClipSize(target, mkt.sizeDecimals);
      const overShort = short > target * (1 + AS_DEFAULTS.invBandFrac);
      const underShort = short < target * (1 - AS_DEFAULTS.invBandFrac);
      const bidPx = Math.min(q.bidPx, b.asks[0].px - tick); // rests on the bid, never crosses
      const askPx = Math.max(q.askPx, b.bids[0].px + tick); // rests on the ask, never crosses

      const orders = [...session.openOrders.values()];
      const restingBid = orders.find((o) => o.type === 4); // short-close (buy-back)
      const restingAsk = orders.find((o) => o.type === 2); // short-open (add-short)
      const drifted = (rp: number, tp: number) => (Math.abs(tp - rp) / rp) * 1e4 > AS_DEFAULTS.repriceBps;

      // Buy-back leg: pull while under target, else keep resting / re-quote on drift.
      if (underShort || clip <= 0) {
        if (restingBid) session.cancel(restingBid.oid);
      } else if (!restingBid) session.placeMaker("short-close", bidPx, clip);
      else if (drifted(restingBid.px, bidPx)) session.cancel(restingBid.oid); // re-placed next tick

      // Add-short leg: pull while over target.
      if (overShort || clip <= 0) {
        if (restingAsk) session.cancel(restingAsk.oid);
      } else if (!restingAsk) session.placeMaker("short-open", askPx, clip);
      else if (drifted(restingAsk.px, askPx)) session.cancel(restingAsk.oid);
    }, 4000);
    return () => {
      session.cancelAllMine();
      clearInterval(t);
    };
  }, [strategy, churnOn, session, market, working]);

  const doConnect = async () => {
    const c = await connectWallet();
    if (!c) {
      setNote({ kind: "err", text: "No wallet found. Install MetaMask or any injected wallet." });
      return;
    }
    setAddress(c.address);
    setWallet(c.wallet);
    setNote({ kind: "", text: "" });
  };

  const doSaveKeys = () => {
    if (!address) {
      setNote({ kind: "err", text: "Connect your wallet first — keys are stored per wallet." });
      return;
    }
    if (!apiKey.trim() || !edPriv.trim() || !market) {
      setNote({ kind: "err", text: "Both the API key token and the Ed25519 private key are required." });
      return;
    }
    saveKeys(address, { apiKey: apiKey.trim(), edPrivHex: edPriv.trim() });
    setKeysVersion((v) => v + 1); // the session effect starts it for this wallet
    setApiKey("");
    setEdPriv("");
  };

  const doClearKeys = () => {
    if (address) clearKeys(address);
    setChurnOn(false);
    setKeysVersion((v) => v + 1); // the session effect tears it down (no keys)
  };

  const doOpen = () => {
    const step = market ? 1 / 10 ** market.sizeDecimals : 1;
    // Snap DOWN to the market's size grid — a fractional target on a whole-number
    // market would leave the keep-alive chasing a remainder it can never place.
    const size = Math.floor((Number(sizeInput) || 0) / step) * step;
    if (size < step) {
      setNote({ kind: "err", text: `Minimum hedge is ${step} MON.` });
      return;
    }
    if (size > monBalance) {
      setNote({
        kind: "err",
        text: `You hold ${monBalance.toFixed(1)} MON — the hedge can't be bigger than the spot leg.`,
      });
      return;
    }
    const h: HedgeLocal = { targetMon: size, openedAt: Date.now(), epochId: null, fillOids: [] };
    setHedge(h);
    saveHedge(address, h);
    setWorking("opening");
    setNote({ kind: "", text: "Working a PostOnly short at the ask — fills at 0.9bps maker fee." });
  };

  // One-click auto-pilot: hedge ALL the MON you hold, then churn automatically. Every
  // order is signed in-browser with the Perpl key — no wallet pop-ups, no per-trade
  // confirmation. Runs while this tab is open.
  const doAutoPilot = () => {
    const step = market ? 1 / 10 ** market.sizeDecimals : 1;
    const size = Math.floor(monBalance / step) * step; // hedge what's actually placeable
    if (size < step) {
      setNote({ kind: "err", text: `You need at least ${step} MON to hedge — swap some USDC → MON first.` });
      return;
    }
    const h: HedgeLocal = { targetMon: size, openedAt: Date.now(), epochId: null, fillOids: [] };
    setHedge(h);
    saveHedge(address, h);
    setSizeInput(size.toFixed(2));
    setWorking("opening");
    setChurnOn(true); // churn kicks in automatically once the short is filled
    setNote({
      kind: "ok",
      text: `Auto-pilot on — hedging ${size.toFixed(1)} MON then ${
        strategy === "avellaneda" ? "quoting both sides (Avellaneda)" : "churning"
      }. No confirmations; runs while this tab is open.`,
    });
  };

  const doClose = () => {
    setChurnOn(false);
    setWorking("closing");
    setNote({ kind: "", text: "Working a PostOnly buy at the bid to close the short." });
  };

  const doAttest = async () => {
    if (!wallet || !address || !hedge || !market || !book) return;
    try {
      const notional = BigInt(Math.round(hedge.targetMon * book.bids[0].px * 1e6));
      const perpRef = keccak256(toHex(hedge.fillOids.join(",")));
      const hash = await wallet.writeContract({
        address: REGISTRY_ADDRESS,
        abi: REGISTRY_ABI,
        functionName: "openEpoch",
        args: [market.id, notional, `0x${"0".repeat(64)}`, perpRef],
        chain: monad,
        account: address,
      });
      setNote({ kind: "ok", text: `Epoch attested on-chain: ${hash.slice(0, 14)}…` });
      const next = { ...hedge, epochId: 0 };
      setHedge(next);
      saveHedge(address, next);
    } catch (e) {
      setNote({ kind: "err", text: `Attestation failed: ${(e as Error).message.slice(0, 120)}` });
    }
  };

  const keys = loadKeys(address);
  const pos = session?.position;
  const shortMon = pos?.side === "short" ? pos.sizeMon : 0;
  const midPx = book ? (book.bids[0].px + book.asks[0].px) / 2 : 0;

  return (
    <section className="card glass-strong gradient-border">
      <div className="card-head">
        <span className="title">
          <i />
          Hedge
        </span>
        <span className="meta mono">{session?.status === "ready" ? "keys active" : "non-custodial"}</span>
      </div>
      <p className="card-sub">
        Short the MON you hold. Spot stays in your wallet; the short earns points on Perpl. Keys never leave this
        browser and can't withdraw funds.
      </p>

      {!address ? (
        <>
          <div className="hedge-legs">
            <div className="fieldbox">
              <div className="fb-label">SPOT LONG — YOU HOLD</div>
              <div className="fb-row">
                <span className="fb-main mono muted">0.0</span>
                <span className="fb-token">
                  <img src="/mon.svg" className="coin" alt="" />
                  MON
                </span>
              </div>
            </div>
            <div className="leg-connector" aria-hidden="true">
              <span>δ0</span>
            </div>
            <div className="fieldbox">
              <div className="fb-label">PERP SHORT — YOU OPEN</div>
              <div className="fb-row">
                <span className="fb-main mono muted">0.0</span>
                <span className="fb-token">
                  <img src="/mon.svg" className="coin" alt="" />
                  MON-PERP
                </span>
              </div>
            </div>
          </div>
          <button className="btn block" onClick={doConnect}>
            Connect Wallet
          </button>
          <div className="console-note">
            Read-only without a wallet — the gauge, book, and registry stay live either way.
          </div>
        </>
      ) : !keys || !session ? (
        <>
          <div className="kv">
            <span className="k">WALLET</span>
            <span className="mono">
              {address.slice(0, 6)}…{address.slice(-4)} · {monBalance.toFixed(1)} MON
            </span>
          </div>
          <div style={{ height: 14 }} />
          <div className="field">
            <label htmlFor="apikey">PERPL API KEY TOKEN</label>
            <input
              id="apikey"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="from app.perpl.xyz/apikeys"
            />
          </div>
          <div className="field">
            <label htmlFor="edpriv">ED25519 PRIVATE KEY (0x…)</label>
            <input
              id="edpriv"
              type="password"
              value={edPriv}
              onChange={(e) => setEdPriv(e.target.value)}
              placeholder="shown once when the key is created"
            />
          </div>
          <button className="btn block" onClick={doSaveKeys}>
            Save keys locally
          </button>
          <div className="console-note">
            Create a trade-scope key at{" "}
            <a href="https://app.perpl.xyz/apikeys" target="_blank" rel="noreferrer">
              app.perpl.xyz/apikeys
            </a>{" "}
            (connect wallet → create key). Stored in this browser only.
          </div>
        </>
      ) : (
        <>
          {shortMon <= 0.01 && working === "idle" ? (
            <>
              <div className="fieldbox">
                <div className="fb-label">SPOT LONG — YOU HOLD</div>
                <div className="fb-row">
                  <span className="fb-main mono">{monBalance.toFixed(1)}</span>
                  <span className="fb-token">
                    <img src="/mon.svg" className="coin" alt="" />
                    MON
                  </span>
                </div>
                <div className="fb-hint">
                  {address.slice(0, 6)}…{address.slice(-4)} · ${(monBalance * midPx).toFixed(2)}
                </div>
              </div>
              <div className="fieldbox">
                <div className="fb-label">PERP SHORT — YOU OPEN</div>
                <div className="fb-row">
                  <input
                    className="fb-main mono"
                    value={sizeInput}
                    onChange={(e) => setSizeInput(e.target.value)}
                    placeholder={monBalance > 0 ? monBalance.toFixed(0) : "0.0"}
                    inputMode="decimal"
                    aria-label="Hedge size in MON"
                  />
                  <span className="fb-token">
                    <img src="/mon.svg" className="coin" alt="" />
                    MON-PERP
                  </span>
                </div>
                <div className="fb-hint">
                  PostOnly at the ask · account{" "}
                  {session.status === "ready" && session.account
                    ? `#${session.account.id} · $${session.account.balanceUsd.toFixed(2)} free`
                    : session.status === "auth-failed"
                      ? "key rejected"
                      : "connecting…"}
                </div>
              </div>
              <div className="fb-label" style={{ marginBottom: 6 }}>FARMING STRATEGY</div>
              <div className="strat-picker" style={{ marginBottom: 4 }}>
                <button className={strategy === "churn" ? "active" : ""} onClick={() => pickStrategy("churn")}>
                  Churn
                </button>
                <button
                  className={strategy === "avellaneda" ? "active" : ""}
                  onClick={() => pickStrategy("avellaneda")}
                >
                  Avellaneda
                </button>
              </div>
              <div className="fb-hint" style={{ marginBottom: 10 }}>
                {strategy === "avellaneda"
                  ? "Two-sided market making — quotes both sides, captures the spread, self-balances."
                  : "Discrete close/re-open round-trips — simple, robust volume."}
              </div>
              <button className="btn block" onClick={doAutoPilot} disabled={session.status !== "ready"}>
                ⚡ Auto-pilot — hedge + {strategy === "avellaneda" ? "quote" : "churn"}
              </button>
              <button
                className="btn secondary block"
                style={{ marginTop: 8 }}
                onClick={doOpen}
                disabled={session.status !== "ready"}
              >
                Open hedge only (manual)
              </button>
              <div className="fb-hint" style={{ textAlign: "center", marginTop: 8 }}>
                Orders sign in-browser with your Perpl key — no wallet pop-ups, no per-trade confirm.
              </div>
            </>
          ) : (
            <>
              <div className="kv">
                <span className="k">PERP SHORT</span>
                <span className="mono">
                  {shortMon > 0 ? `${shortMon.toFixed(1)} MON @ ${pos!.entryPx.toFixed(6)}` : "flat"}
                </span>
              </div>
              <div className="kv">
                <span className="k">ACCOUNT</span>
                <span className="mono">
                  {session.account ? `#${session.account.id} · $${session.account.balanceUsd.toFixed(2)} free` : "—"}
                </span>
              </div>

              {working !== "idle" && (
                <div className="console-note">
                  {working === "opening" ? "Working the short at the ask…" : "Closing the short at the bid…"} PostOnly
                  orders re-post automatically while this tab stays open.
                </div>
              )}

              <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
                {working === "idle" ? (
                  <>
                    <button className="btn danger" style={{ flex: 1 }} onClick={doClose}>
                      Close hedge
                    </button>
                    {hedge && hedge.epochId === null && (
                      <button className="btn secondary" style={{ flex: 1 }} onClick={doAttest}>
                        Attest epoch on-chain
                      </button>
                    )}
                  </>
                ) : (
                  <button
                    className="btn secondary"
                    style={{ flex: 1 }}
                    onClick={() => {
                      session.cancelAllMine();
                      setWorking("idle");
                      setNote({ kind: "", text: "" });
                    }}
                  >
                    Stop working orders
                  </button>
                )}
              </div>

              <div className="strat-picker" style={{ marginTop: 14 }}>
                <button className={strategy === "churn" ? "active" : ""} onClick={() => pickStrategy("churn")}>
                  Churn
                </button>
                <button
                  className={strategy === "avellaneda" ? "active" : ""}
                  onClick={() => pickStrategy("avellaneda")}
                >
                  Avellaneda
                </button>
              </div>
              <div className="churn-row">
                <div>
                  <div className="t">Auto-farm · {strategy === "avellaneda" ? "Avellaneda" : "Churn"}</div>
                  <div className="d">
                    {strategy === "avellaneda"
                      ? "Two-sided maker quotes around the spread, self-balancing."
                      : "Close/re-open 25% every 15 min."}{" "}
                    Signed in-browser, no confirmations. Tab-open only.
                  </div>
                </div>
                <button
                  className={`toggle ${churnOn ? "on" : ""}`}
                  role="switch"
                  aria-checked={churnOn}
                  aria-label="Toggle auto-farm"
                  onClick={() => setChurnOn(!churnOn)}
                >
                  <i />
                </button>
              </div>
              {churnOn && (
                <div className="fb-hint" style={{ marginTop: 8, textAlign: "center" }}>
                  {session.openOrders.size > 0
                    ? `🟢 ${session.openOrders.size} maker order${session.openOrders.size > 1 ? "s" : ""} resting on Perpl`
                    : working !== "idle"
                      ? "opening the hedge first…"
                      : strategy === "avellaneda"
                        ? "placing quotes…"
                        : "waiting for next churn cycle…"}
                </div>
              )}
            </>
          )}

          {address && <CloudRunner address={address} wallet={wallet} session={session} strategy={strategy} />}

          <div style={{ marginTop: 14, display: "flex", justifyContent: "flex-end" }}>
            <button className="btn secondary sm" onClick={doClearKeys}>
              Clear keys
            </button>
          </div>
        </>
      )}

      {note.text && <div className={`console-note ${note.kind}`}>{note.text}</div>}

      <div className="spec">
        <span>
          leverage <b>2.0×</b>
        </span>
        <span>
          churn <b>15 min</b>
        </span>
        <span>
          soft/hard δ <b>1% / 3%</b>
        </span>
        <span>
          round trip <b>~1.8bps</b>
        </span>
      </div>
    </section>
  );
}
