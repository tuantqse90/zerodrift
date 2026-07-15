// perplTrading.ts — browser port of the authenticated Perpl trading client.
// Keys live in localStorage only (trade scope; withdrawals are impossible via
// API key by protocol design). Buffer-free: base64url/hex helpers inline.

import { ed25519 } from "@noble/curves/ed25519";
import { PERPL_API, PERPL_CHAIN_ID, PERPL_WS, type PerplMarketInfo } from "./perplFeed";

export interface PerplKeys {
  apiKey: string;
  edPrivHex: string;
}

// Keys are scoped PER WALLET — the Perpl account (and its enrolled API key) belongs
// to the wallet that enrolled it, so switching wallets must load different keys (or
// none). Legacy builds stored one global blob; it's migrated to the first wallet that
// connects so existing setups aren't lost.
const LS_PREFIX = "zerodrift.perpl-keys";
const LS_LEGACY = "zerodrift.perpl-keys";

function lsKey(address: string): string {
  return `${LS_PREFIX}:${address.toLowerCase()}`;
}

function readAt(storageKey: string): PerplKeys | null {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return null;
    const k = JSON.parse(raw) as PerplKeys;
    return k.apiKey && k.edPrivHex ? k : null;
  } catch {
    return null;
  }
}

export function loadKeys(address: string | null | undefined): PerplKeys | null {
  if (!address) return null;
  const scoped = readAt(lsKey(address));
  if (scoped) return scoped;
  // one-time migration of a pre-scoping global blob to this wallet
  const legacy = readAt(LS_LEGACY);
  if (legacy) {
    saveKeys(address, legacy);
    localStorage.removeItem(LS_LEGACY);
    return legacy;
  }
  return null;
}

export function saveKeys(address: string, k: PerplKeys): void {
  if (!address) return;
  localStorage.setItem(lsKey(address), JSON.stringify(k));
}

export function clearKeys(address: string): void {
  if (!address) return;
  localStorage.removeItem(lsKey(address));
}

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export type PerpSide = "short-open" | "short-close" | "long-open" | "long-close";
const ORDER_TYPE: Record<PerpSide, number> = { "long-open": 1, "short-open": 2, "long-close": 3, "short-close": 4 };

export interface FillEvent {
  oid: number;
  px: number;
  sz: number;
  feeUsd: number;
  maker: boolean;
}
export interface Position {
  side: "short" | "long" | "flat";
  sizeMon: number;
  entryPx: number;
}
export interface AccountView {
  id: number;
  balanceUsd: number;
  lockedUsd: number;
}
export interface AccountStats {
  totalVolumeUsd: number;
  realizedPnlUsd: number;
  trades: number;
  winRatePct: number;
}

function parseAmount(a: unknown): number {
  const n = typeof a === "number" ? a : Number(a ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/** Collateral (AUSD) amounts arrive as 6-decimal scaled ints — balance, locked,
 * volume, realized PnL, fees are all denominated in it. */
const COLLATERAL_DECIMALS = 6;
function parseCollateral(a: unknown): number {
  return parseAmount(a) / 10 ** COLLATERAL_DECIMALS;
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Authenticated trading session over /ws/v1/trading. One market. Emits state
 * changes through onChange; callers read .position/.account/.status.
 */
export class TradingSession {
  status: "connecting" | "ready" | "auth-failed" | "closed" = "connecting";
  position: Position = { side: "flat", sizeMon: 0, entryPx: 0 };
  account: AccountView | null = null;
  stats: AccountStats | null = null;
  headBlock = 0;
  lastError = "";
  onChange: (() => void) | null = null;
  onFill: ((f: FillEvent) => void) | null = null;

  /** Resting orders on this market, by oid. */
  openOrders = new Map<number, { oid: number; rq: number; px: number; remaining: number; type: number }>();

  private ws: WebSocket | null = null;
  private nextRq = 0;
  private lastSn: number | undefined;
  private stopped = false;
  private retry = 0;
  private pingTimer: number | null = null;
  private edPriv: Uint8Array;

  constructor(
    private readonly market: PerplMarketInfo,
    private readonly keys: PerplKeys,
    private readonly leverageHundredths = 200,
  ) {
    this.edPriv = hexToBytes(keys.edPrivHex);
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.ws?.close();
    this.status = "closed";
  }

  get ready(): boolean {
    return this.status === "ready" && this.ws?.readyState === WebSocket.OPEN;
  }

  private scalePx(px: number): number {
    return Math.round(px * 10 ** this.market.priceDecimals);
  }
  private scaleSz(sz: number): number {
    // Floor, never round: a 1.5-MON request must post 1 MON, not 2 — rounding up
    // would trade MORE than the strategy intended. Epsilon absorbs float error so
    // 0.9999999 still counts as 1.
    return Math.floor(sz * 10 ** this.market.sizeDecimals + 1e-9);
  }

  private lb(): number {
    return this.headBlock + Math.max(2, this.market.orderTtlBlocks - 5);
  }

  private takeRq(): number {
    this.nextRq += 1;
    return this.nextRq;
  }

  /** Order-lifecycle log — open the console to audit exactly what was sent/filled. */
  private log(...args: unknown[]): void {
    console.log("[zerodrift]", ...args);
  }

  /**
   * Refuse orders that can't be honestly placed: a size that rounds to 0 at the
   * market's size decimals (MON orders are whole numbers — 0.4 MON would silently
   * become s:0 and be rejected upstream), or placing before the first heartbeat
   * (headBlock=0 ⇒ lb in the past ⇒ instant expiry).
   */
  private orderGuard(side: PerpSide, sizeMon: number): number | null {
    const s = this.scaleSz(sizeMon);
    if (s <= 0) {
      this.log(`SKIP ${side} — size ${sizeMon.toFixed(4)} MON rounds to 0 at ${this.market.sizeDecimals} decimals`);
      return null;
    }
    if (this.headBlock <= 0) {
      this.log(`SKIP ${side} — no heartbeat yet (headBlock=0), lb would be stale`);
      return null;
    }
    return s;
  }

  /** PostOnly maker order joined at px. Returns rq for correlation (-1 = not sent). */
  placeMaker(side: PerpSide, px: number, sizeMon: number): number {
    if (!this.ready) throw new Error("session not ready");
    const s = this.orderGuard(side, sizeMon);
    if (s === null || !(px > 0)) return -1;
    const rq = this.takeRq();
    this.log(`place maker ${side} ${sizeMon.toFixed(2)} @ ${px} (rq ${rq})`);
    this.send({
      mt: 22,
      rq,
      mkt: this.market.id,
      acc: this.account?.id ?? 0,
      t: ORDER_TYPE[side],
      p: this.scalePx(px),
      s,
      fl: 1,
      lv: this.leverageHundredths,
      lb: this.lb(),
    });
    return rq;
  }

  placeTaker(side: PerpSide, sizeMon: number, slippageBps: number): number {
    if (!this.ready) throw new Error("session not ready");
    const s = this.orderGuard(side, sizeMon);
    if (s === null) return -1;
    const rq = this.takeRq();
    this.log(`place TAKER ${side} ${sizeMon.toFixed(2)} (slippage ${slippageBps}bps, rq ${rq})`);
    this.send({
      mt: 22,
      rq,
      mkt: this.market.id,
      acc: this.account?.id ?? 0,
      t: ORDER_TYPE[side],
      p: 0,
      s,
      ms: slippageBps,
      fl: 4,
      lv: this.leverageHundredths,
      lb: this.lb(),
    });
    return rq;
  }

  cancel(oid: number): void {
    if (!this.ready) return;
    this.log(`cancel oid ${oid}`);
    this.send({
      mt: 22,
      rq: this.takeRq(),
      mkt: this.market.id,
      acc: this.account?.id ?? 0,
      oid,
      t: 5,
      s: 0,
      fl: 0,
      lv: 0,
      lb: this.lb(),
    });
  }

  cancelAllMine(): void {
    for (const o of this.openOrders.values()) this.cancel(o.oid);
  }

  private send(frame: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(frame));
  }

  private applyStats(s: any): void {
    this.stats = {
      totalVolumeUsd: parseCollateral(s.tv),
      realizedPnlUsd: parseCollateral(s.trp),
      trades: Number(s.tt) || 0,
      winRatePct: (Number(s.wr) || 0) / 100, // wr is bps
    };
  }

  /**
   * Signed REST GET for the user's own data (e.g. mPoints). Uses the Ed25519 key
   * with Perpl's authed-REST canonical: chainId\nMETHOD\ntarget\nts\nnonce\nsha256(body).
   * Returns parsed JSON or null. The points path/shape may vary — callers degrade.
   */
  async signedGet(target: string): Promise<any | null> {
    try {
      const timestamp = Date.now().toString();
      const nonce = b64url(crypto.getRandomValues(new Uint8Array(16)));
      const bodyHash = await sha256Hex("");
      const canonical = [PERPL_CHAIN_ID, "GET", target, timestamp, nonce, bodyHash].join("\n");
      const sig = b64url(ed25519.sign(new TextEncoder().encode(canonical), this.edPriv));
      const res = await fetch(`${PERPL_API}${target}`, {
        headers: {
          "X-API-Key": this.keys.apiKey,
          "X-API-Timestamp": timestamp,
          "X-API-Nonce": nonce,
          "X-API-Signature": sig,
        },
      });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }

  private connect(): void {
    if (this.stopped) return;
    this.status = "connecting";
    const ws = new WebSocket(`${PERPL_WS}/ws/v1/trading`);
    this.ws = ws;

    ws.onopen = () => {
      // Fresh connection ⇒ stale book-keeping. An order that died while we were
      // disconnected never gets an r:true removal, so without this a phantom oid
      // would sit in openOrders forever and stall every loop that waits for the
      // book to clear. The post-signin snapshot (mt:23) rebuilds the real set.
      if (this.openOrders.size > 0) {
        this.log(`reconnect — dropping ${this.openOrders.size} stale open order(s), snapshot will rebuild`);
        this.openOrders.clear();
        this.onChange?.();
      }
      const timestamp = Date.now().toString();
      const nonce = b64url(crypto.getRandomValues(new Uint8Array(16)));
      const canonical = [PERPL_CHAIN_ID, "trading-ws-signin", timestamp, nonce].join("\n");
      const signature = b64url(ed25519.sign(new TextEncoder().encode(canonical), this.edPriv));
      ws.send(
        JSON.stringify({ mt: 29, chain_id: PERPL_CHAIN_ID, api_key: this.keys.apiKey, timestamp, nonce, signature }),
      );
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = window.setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ mt: 1, t: Date.now() }));
      }, 25_000);
    };

    ws.onmessage = (ev) => {
      try {
        this.handle(JSON.parse(String(ev.data)));
      } catch {
        /* ignore */
      }
    };

    ws.onclose = (ev) => {
      if (this.pingTimer) clearInterval(this.pingTimer);
      if (ev.code === 3401) {
        this.status = "auth-failed";
        this.lastError = "Key rejected (3401). Check the token and private key.";
        console.warn("[zerodrift] sign-in rejected (3401) — key/token mismatch");
        this.onChange?.();
        return; // don't hammer a bad key
      }
      if (!this.stopped) {
        const delay = Math.min(1000 * 2 ** this.retry, 30_000);
        this.retry += 1;
        setTimeout(() => this.connect(), delay);
      }
    };
    ws.onerror = () => ws.close();
  }

  private handle(msg: any): void {
    switch (msg.mt) {
      case 19: {
        this.lastSn = typeof msg.sn === "number" ? msg.sn : undefined;
        const acc = (msg.as ?? [])[0];
        if (acc) {
          this.nextRq = Math.max(this.nextRq, Number(acc.lfr) || 0);
          this.account = { id: acc.id, balanceUsd: parseCollateral(acc.b), lockedUsd: parseCollateral(acc.lb) };
        }
        const st = (msg.sts ?? [])[0];
        if (st) this.applyStats(st);
        this.retry = 0;
        this.status = "ready";
        this.log(`session ready — account #${this.account?.id ?? "?"}, rq seeded at ${this.nextRq}`);
        this.onChange?.();
        break;
      }
      case 28:
        this.applyStats(msg);
        this.onChange?.();
        break;
      case 21:
        if (this.account && msg.id === this.account.id) {
          this.nextRq = Math.max(this.nextRq, Number(msg.lfr) || 0);
          this.account = { id: msg.id, balanceUsd: parseCollateral(msg.b), lockedUsd: parseCollateral(msg.lb) };
          this.onChange?.();
        }
        break;
      case 23:
      case 24:
        for (const o of msg.d ?? []) {
          if (o.mkt !== this.market.id || o.oid === undefined) continue;
          if (o.r === true) {
            if (this.openOrders.has(o.oid)) this.log(`order removed oid ${o.oid} (filled/canceled/expired)`);
            this.openOrders.delete(o.oid);
          } else if ((o.st ?? 0) === 2 || (o.st ?? 0) === 3) {
            if (!this.openOrders.has(o.oid))
              this.log(`order resting oid ${o.oid} t=${o.t} px ${(o.p ?? 0) / 10 ** this.market.priceDecimals}`);
            this.openOrders.set(o.oid, {
              oid: o.oid,
              rq: o.rq,
              px: (o.p ?? 0) / 10 ** this.market.priceDecimals,
              remaining: ((o.os ?? 0) - (o.fs ?? 0)) / 10 ** this.market.sizeDecimals,
              type: o.t,
            });
          }
        }
        this.onChange?.();
        break;
      case 25:
        for (const f of msg.d ?? []) {
          if (f.mkt !== this.market.id) continue;
          const px = (f.p ?? 0) / 10 ** this.market.priceDecimals;
          const sz = (f.s ?? 0) / 10 ** this.market.sizeDecimals;
          const t = f.t ?? this.openOrders.get(f.oid)?.type;
          const sideName = t === 2 ? "short-open" : t === 4 ? "short-close" : t === 1 ? "long-open" : t === 3 ? "long-close" : "?";
          this.log(`FILL ${f.l === 1 ? "maker" : "taker"} ${sideName} ${sz} @ ${px} (oid ${f.oid})`);
          // Apply the fill to the position OPTIMISTICALLY. Fills (mt:25), order
          // removals (mt:24) and position updates (mt:27) arrive as separate frames;
          // a timer tick landing between removal and position update would size its
          // next order off a stale position — the double-fill race. The authoritative
          // mt:26/27 frame overwrites this moments later.
          if (t === 2 || t === 4) {
            const cur = this.position.side === "short" ? this.position.sizeMon : 0;
            const next = Math.max(0, cur + (t === 2 ? sz : -sz));
            this.position =
              next > 0
                ? { side: "short", sizeMon: next, entryPx: this.position.side === "short" ? this.position.entryPx : px }
                : { side: "flat", sizeMon: 0, entryPx: 0 };
          }
          this.onFill?.({ oid: f.oid, px, sz, feeUsd: parseCollateral(f.f), maker: f.l === 1 });
          this.onChange?.();
        }
        break;
      case 26:
      case 27:
        for (const p of msg.d ?? []) {
          if (p.mkt !== this.market.id) continue;
          if ((p.st ?? 0) === 1) {
            this.position = {
              side: p.sd === 2 ? "short" : p.sd === 1 ? "long" : "flat",
              sizeMon: (p.s ?? 0) / 10 ** this.market.sizeDecimals,
              entryPx: (p.ep ?? 0) / 10 ** this.market.priceDecimals,
            };
          } else {
            this.position = { side: "flat", sizeMon: 0, entryPx: 0 };
          }
          this.onChange?.();
        }
        break;
      case 100:
        if (typeof msg.h === "number") this.headBlock = msg.h;
        if (typeof msg.sn === "number") {
          // Only a FORWARD gap means we missed a message. Duplicate/reordered
          // heartbeats (sn <= lastSn — observed live: 87979895 → 87979895) are
          // harmless and must NOT force a reconnect.
          if (this.lastSn !== undefined && msg.sn <= this.lastSn) break;
          if (this.lastSn !== undefined && msg.sn > this.lastSn + 1) {
            this.log(`heartbeat sn gap (${this.lastSn} → ${msg.sn}) — reconnecting for a fresh snapshot`);
            this.ws?.close();
            return;
          }
          this.lastSn = msg.sn;
        }
        break;
    }
  }
}
