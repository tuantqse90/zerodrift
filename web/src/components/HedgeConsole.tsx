// HedgeConsole — NT swap-card idiom. Three states: connect wallet → add Perpl
// key → drive the hedge. Spot stays in the wallet; the short earns points on
// Perpl. Keys live in this browser only and can never withdraw funds.

import { useCallback, useEffect, useRef, useState } from "react";
import { formatEther, keccak256, toHex, type Address, type WalletClient } from "viem";
import { connectWallet, eagerConnect, monad, publicClient, REGISTRY_ABI, REGISTRY_ADDRESS, watchAccount } from "../lib/chain";
import type { PerplBook, PerplMarketInfo } from "../lib/perplFeed";
import { clearKeys, loadKeys, saveKeys, TradingSession, type FillEvent } from "../lib/perplTrading";

interface HedgeLocal {
  targetMon: number;
  openedAt: number;
  epochId: number | null;
  fillOids: number[];
}
const LS_HEDGE = "zerodrift.hedge";

function loadHedge(): HedgeLocal | null {
  try {
    return JSON.parse(localStorage.getItem(LS_HEDGE) || "null");
  } catch {
    return null;
  }
}
function saveHedge(h: HedgeLocal | null): void {
  if (h) localStorage.setItem(LS_HEDGE, JSON.stringify(h));
  else localStorage.removeItem(LS_HEDGE);
}

interface Props {
  market: PerplMarketInfo | null;
  book: PerplBook | null;
  session: TradingSession | null;
  setSession: (s: TradingSession | null) => void;
  onHedgeChange: (spotMon: number, target: number, working: boolean) => void;
}

export function HedgeConsole({ market, book, session, setSession, onHedgeChange }: Props) {
  const [address, setAddress] = useState<Address | null>(null);
  const [wallet, setWallet] = useState<WalletClient | null>(null);
  const [monBalance, setMonBalance] = useState(0);
  const [apiKey, setApiKey] = useState("");
  const [edPriv, setEdPriv] = useState("");
  const [sizeInput, setSizeInput] = useState("");
  const [working, setWorking] = useState<"idle" | "opening" | "closing">("idle");
  const [churnOn, setChurnOn] = useState(false);
  const [note, setNote] = useState<{ kind: "ok" | "err" | ""; text: string }>({ kind: "", text: "" });
  const [hedge, setHedge] = useState<HedgeLocal | null>(loadHedge());
  const [keysVersion, setKeysVersion] = useState(0); // bump to reload keys for the active wallet
  const [, force] = useState(0);
  const rerender = useCallback(() => force((n) => n + 1), []);

  const churnPhase = useRef<"idle" | "closing" | "reopening">("idle");
  const churnSize = useRef(0);
  const lastChurnAt = useRef(Date.now());

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
        saveHedge(next);
        return next;
      });
      rerender();
    };
  }, [session, rerender]);

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
    if (working === "idle" || !session || !book || !market) return;
    const target = hedge?.targetMon ?? 0;
    const t = setInterval(() => {
      if (!session.ready) return;
      const b = book;
      const pos = session.position;
      const shortMon = pos.side === "short" ? pos.sizeMon : 0;

      if (working === "opening") {
        if (shortMon >= target * 0.99) {
          setWorking("idle");
          setNote({ kind: "ok", text: `Hedged: ${shortMon.toFixed(1)} MON short at maker fees.` });
          return;
        }
        if (session.openOrders.size === 0) session.placeMaker("short-open", b.asks[0].px, target - shortMon);
      } else {
        if (shortMon <= 0.01) {
          setWorking("idle");
          setNote({ kind: "ok", text: "Perp leg closed. You're back to plain spot MON." });
          return;
        }
        if (session.openOrders.size === 0) session.placeMaker("short-close", b.bids[0].px, shortMon);
      }
    }, 4000);
    return () => clearInterval(t);
  }, [working, session, book, market, hedge]);

  // churn loop (tab-open only)
  useEffect(() => {
    if (!churnOn || !session || !market) return;
    const t = setInterval(() => {
      if (!session.ready || working !== "idle") return;
      const b = book;
      if (!b) return;
      const pos = session.position;
      const shortMon = pos.side === "short" ? pos.sizeMon : 0;
      if (shortMon <= 0) return;

      if (churnPhase.current === "idle") {
        if (Date.now() - lastChurnAt.current < 15 * 60_000) return;
        churnSize.current = shortMon * 0.25 * (0.8 + Math.random() * 0.4);
        churnPhase.current = "closing";
        lastChurnAt.current = Date.now();
        session.placeMaker("short-close", b.bids[0].px, churnSize.current);
      } else if (session.openOrders.size === 0) {
        if (churnPhase.current === "closing" && shortMon <= (hedge?.targetMon ?? 0) - churnSize.current * 0.9) {
          churnPhase.current = "reopening";
          session.placeMaker("short-open", b.asks[0].px, churnSize.current);
        } else if (churnPhase.current === "reopening" && shortMon >= (hedge?.targetMon ?? 0) * 0.99) {
          churnPhase.current = "idle";
          setNote({
            kind: "ok",
            text: `Churn round-trip done — +$${(churnSize.current * b.bids[0].px * 2).toFixed(0)} maker volume.`,
          });
        } else {
          const side = churnPhase.current === "closing" ? "short-close" : "short-open";
          const px = side === "short-close" ? b.bids[0].px : b.asks[0].px;
          session.placeMaker(side, px, churnSize.current);
        }
      }
    }, 5000);
    return () => clearInterval(t);
  }, [churnOn, session, market, book, working, hedge]);

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
    const size = Number(sizeInput);
    if (!size || size <= 0) {
      setNote({ kind: "err", text: "Enter the MON size to hedge." });
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
    saveHedge(h);
    setWorking("opening");
    setNote({ kind: "", text: "Working a PostOnly short at the ask — fills at 0.9bps maker fee." });
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
      saveHedge(next);
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
              <button className="btn block" onClick={doOpen} disabled={session.status !== "ready"}>
                Open hedge — maker short
              </button>
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

              <div className="churn-row">
                <div>
                  <div className="t">Volume churn</div>
                  <div className="d">Close and re-open 25% every 15 min with maker orders. Tab-open only.</div>
                </div>
                <button
                  className={`toggle ${churnOn ? "on" : ""}`}
                  role="switch"
                  aria-checked={churnOn}
                  aria-label="Toggle volume churn"
                  onClick={() => setChurnOn(!churnOn)}
                >
                  <i />
                </button>
              </div>
            </>
          )}

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
