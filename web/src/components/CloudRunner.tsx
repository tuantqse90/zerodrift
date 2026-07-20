// CloudRunner — run YOUR bot 24/7 on the ZeroDrift server (no tab required).
// Start/stop are gated by a wallet personal_sign; the Perpl trade keys already in
// this browser are sent once over same-origin HTTPS and stored AES-encrypted on the
// server. They can trade only — Perpl API keys can never withdraw funds.
import { useCallback, useEffect, useState } from "react";
import type { Address, WalletClient } from "viem";
import { loadKeys, type TradingSession } from "../lib/perplTrading";

interface CloudStatus {
  exists: boolean;
  running?: boolean;
  live?: boolean;
  strategy?: string;
  notionalUsd?: number;
  startedAt?: string;
  /** Capability URL — only ever returned by the signature-gated start/feed calls. */
  feedUrl?: string;
}

// The feed URL is a secret (whoever has it reads your fills). Cache it per wallet so
// the link survives reloads without asking for another signature.
const feedKey = (a: string) => `zerodrift.cloud-feed:${a.toLowerCase()}`;

interface Props {
  address: Address;
  wallet: WalletClient | null;
  session: TradingSession | null;
  strategy: "churn" | "avellaneda";
}

export function CloudRunner({ address, wallet, session, strategy }: Props) {
  const [st, setSt] = useState<CloudStatus | null>(null);
  const [notional, setNotional] = useState("50");
  const [live, setLive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [ack, setAck] = useState(false);
  const [feed, setFeed] = useState<string | null>(() => localStorage.getItem(feedKey(address)));

  const refresh = useCallback(async () => {
    try {
      const r = await fetch(`/api/cloud/status?address=${address.toLowerCase()}`);
      if (r.ok) setSt((await r.json()) as CloudStatus);
    } catch {
      /* server may not be deployed yet — hide the card */
    }
  }, [address]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 15_000);
    return () => clearInterval(t);
  }, [refresh]);

  const sign = async (action: "start" | "stop", ts: number): Promise<`0x${string}` | null> => {
    if (!wallet) return null;
    return wallet.signMessage({
      account: address,
      message: `zerodrift-cloud:${action}:${address.toLowerCase()}:${ts}`,
    });
  };

  const doStart = async () => {
    const keys = loadKeys(address);
    const accountId = session?.account?.id;
    if (!keys || !accountId) {
      setMsg("Need an active key session first (paste keys above).");
      return;
    }
    const usd = Number(notional);
    if (!(usd >= 10 && usd <= 500)) {
      setMsg("Notional must be $10–$500.");
      return;
    }
    setBusy(true);
    setMsg("");
    try {
      const ts = Date.now();
      const sig = await sign("start", ts);
      if (!sig) throw new Error("signature rejected");
      const r = await fetch("/api/cloud/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          address: address.toLowerCase(),
          accountId: String(accountId),
          apiKey: keys.apiKey,
          edPrivHex: keys.edPrivHex,
          notionalUsd: usd,
          strategy,
          live,
          ts,
          sig,
        }),
      });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
      setSt(body as CloudStatus);
      if (body.feedUrl) {
        localStorage.setItem(feedKey(address), body.feedUrl);
        setFeed(body.feedUrl);
      }
      setMsg(`Server instance ${live ? "LIVE" : "paper"} started — you can close this tab.`);
    } catch (e) {
      setMsg(`Start failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const revealFeed = async () => {
    setBusy(true);
    try {
      const ts = Date.now();
      const sig = await wallet?.signMessage({
        account: address,
        message: `zerodrift-cloud:feed:${address.toLowerCase()}:${ts}`,
      });
      if (!sig) throw new Error("signature rejected");
      const r = await fetch("/api/cloud/feed", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address: address.toLowerCase(), ts, sig }),
      });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
      localStorage.setItem(feedKey(address), body.feedUrl);
      setFeed(body.feedUrl);
    } catch (e) {
      setMsg(`Could not fetch the feed link: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const doStop = async (unwind: boolean) => {
    setBusy(true);
    setMsg("");
    try {
      const ts = Date.now();
      const sig = await sign("stop", ts);
      if (!sig) throw new Error("signature rejected");
      const r = await fetch("/api/cloud/stop", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address: address.toLowerCase(), unwind, ts, sig }),
      });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
      setMsg(unwind ? "Unwinding cleanly — the instance exits itself when flat." : "Server instance stopped.");
      await refresh();
    } catch (e) {
      setMsg(`Stop failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  // Server not reachable (feature not deployed) → render nothing.
  if (st === null) return null;

  return (
    <div className="churn-row" style={{ marginTop: 10, flexDirection: "column", alignItems: "stretch", gap: 8 }}>
      <div>
        <div className="t">Cloud runner · 24/7</div>
        <div className="d">
          Runs this strategy headless on the ZeroDrift server — no tab needed. Keys are stored
          encrypted server-side and <b>still can't withdraw funds</b>. Spot stays in your wallet.
        </div>
      </div>

      {st.exists && st.running ? (
        <>
          <div className="fb-hint" style={{ textAlign: "center" }}>
            🟢 running {st.live ? "LIVE" : "paper"} · {st.strategy} · ${st.notionalUsd}
            {" · "}
            {feed ? (
              <a href={feed} target="_blank" rel="noreferrer">
                status feed
              </a>
            ) : (
              <button className="linkish" disabled={busy} onClick={revealFeed}>
                reveal feed link
              </button>
            )}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn secondary sm" style={{ flex: 1 }} disabled={busy} onClick={() => doStop(false)}>
              Stop
            </button>
            <button className="btn danger sm" style={{ flex: 1 }} disabled={busy} onClick={() => doStop(true)}>
              Stop + unwind
            </button>
          </div>
        </>
      ) : (
        <>
          {st.exists && <div className="fb-hint" style={{ textAlign: "center" }}>⚪ instance saved, not running</div>}
          <div style={{ display: "flex", gap: 12, alignItems: "flex-end" }}>
            <div className="field" style={{ flex: "0 0 110px", marginBottom: 0 }}>
              <label htmlFor="cloud-notional">NOTIONAL (USD)</label>
              <input
                id="cloud-notional"
                value={notional}
                onChange={(e) => setNotional(e.target.value.replace(/[^0-9]/g, ""))}
                inputMode="numeric"
              />
            </div>
            <label className="d" style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6, paddingBottom: 10 }}>
              <input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} />
              real orders (LIVE)
            </label>
          </div>
          <label className="d cloud-ack">
            <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
            <span>
              I understand: my Perpl <b>trade</b> keys are sent to the ZeroDrift server and stored
              encrypted there. They <b>cannot withdraw funds</b> (Perpl protocol), and my spot MON
              never leaves my wallet — but the server operator could read them. My wallet key is
              never involved.
            </span>
          </label>
          <button className="btn primary" disabled={busy || !wallet || !ack} onClick={doStart}>
            {busy ? "starting…" : `▶ Run ${strategy} on server${live ? " · LIVE" : " · paper"}`}
          </button>
        </>
      )}

      {msg && <div className="fb-hint" style={{ textAlign: "center" }}>{msg}</div>}
    </div>
  );
}
