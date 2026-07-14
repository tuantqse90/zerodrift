// perpl-trade.ts — AUTHENTICATED Perpl trading client over /ws/v1/trading.
//
// Protocol: https://github.com/PerplFoundation/api-docs (websocket.md, types.md).
//   signin mt:29 (Ed25519 over "<chain_id>\ntrading-ws-signin\n<ts>\n<nonce>")
//   snapshots mt:19 wallet / mt:23 orders / mt:26 positions, then mt:21/24/25/27/28 updates
//   orders mt:22 with rq idempotency (seed from account.lfr) and lb expiry (head + order_ttl_blocks)
//   heartbeat mt:100 carries sn (must be prev+1 → else reconnect) and h (head block)
//
// The PerplExecutor interface is the paper/live seam: the hedger engine only sees
// placeMaker/placeTaker/cancel/onFill/position/account, so every line downstream is
// identical in paper and live mode.

import { ed25519 } from "@noble/curves/ed25519";
import { appendFileSync, mkdirSync } from "node:fs";
import { PERPL_WS_URL, PERPL_CHAIN_ID, envBool, envNum } from "./config";
import type { PerplBook, PerplFeed, PerplMarketInfo } from "./perpl";
import { vwapForNotional } from "./perpl";

// ── Ed25519 / frame helpers (shared with the enroll CLI and the web port) ────

export interface PerplAuth {
  apiKey: string;
  /** 32-byte Ed25519 secret. */
  edPriv: Uint8Array;
  chainId: number;
}

export function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  return Uint8Array.from(Buffer.from(clean, "hex"));
}

/** Build the ApiKeySignIn (mt:29) frame — MUST be the first frame after open. */
export function buildSignInFrame(auth: PerplAuth): Record<string, unknown> {
  const timestamp = Date.now().toString();
  const nonce = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const canonical = [auth.chainId, "trading-ws-signin", timestamp, nonce].join("\n");
  const signature = b64url(ed25519.sign(new TextEncoder().encode(canonical), auth.edPriv));
  return { mt: 29, chain_id: auth.chainId, api_key: auth.apiKey, timestamp, nonce, signature };
}

// ── Executor seam ─────────────────────────────────────────────────────────────

export type PerpSide = "short-open" | "short-close" | "long-open" | "long-close";

/** OrderType values (types.md): 1=OpenLong 2=OpenShort 3=CloseLong 4=CloseShort 5=Cancel. */
const ORDER_TYPE: Record<PerpSide, number> = {
  "long-open": 1,
  "short-open": 2,
  "long-close": 3,
  "short-close": 4,
};
/** Which book side a resting maker order sits on. Shorts/sells rest on the ask side. */
function makerRestsOnAsk(side: PerpSide): boolean {
  return side === "short-open" || side === "long-close";
}

export interface FillEvent {
  intentId: string;
  oid: number;
  px: number; // human price
  sz: number; // human size (MON)
  feeUsd: number; // negative = rebate
  maker: boolean;
  tsMs: number;
}

export interface PerpPosition {
  side: "short" | "long" | "flat";
  sizeMon: number;
  entryPx: number;
}

export interface AccountView {
  balanceUsd: number;
  lockedUsd: number;
}

export interface PerplExecutor {
  start(): Promise<void>;
  stop(): void;
  /** True once safe to place orders (live: first snapshot received). */
  isReady(): boolean;
  /** Place a PostOnly maker order; auto re-posts on lb expiry until filled or canceled. */
  placeMaker(side: PerpSide, px: number, sizeMon: number): Promise<string>;
  /** Immediate taker order (market: p=0, IOC) with a slippage bound. */
  placeTaker(side: PerpSide, sizeMon: number, slippageBps: number): Promise<string>;
  cancel(intentId: string): Promise<void>;
  /** Cancel every active intent (and any live resting orders). */
  cancelAll(): Promise<void>;
  onFill(cb: (f: FillEvent) => void): void;
  position(): PerpPosition;
  account(): AccountView | null;
  /** Latest known head block (live: from heartbeats; paper: 0). */
  headBlock(): number;
}

// ── Shared intent bookkeeping ────────────────────────────────────────────────

interface MakerIntent {
  intentId: string;
  side: PerpSide;
  px: number;
  remainingSz: number; // human units
  active: boolean;
  rq: number; // current request id (live only)
  oid?: number;
  statusSeen: boolean; // any status update received for current rq
  postedAtBlock: number;
  lb: number;
  reconnectEpoch: number; // reconnects invalidate "no status ⇒ expired" reasoning
  repostTimestamps: number[];
}

let intentSeq = 0;
function nextIntentId(prefix: string): string {
  intentSeq += 1;
  return `${prefix}-${Date.now()}-${intentSeq}`;
}

/**
 * Amount fields ("Amount = decimal string for large numbers") — parse defensively.
 * Observed format is a human decimal string; if it ever arrives as a raw integer
 * in collateral decimals the testnet probe will catch it (see probe-testnet.ts).
 */
export function parseAmount(a: unknown): number {
  if (typeof a === "number") return a;
  if (typeof a !== "string" || a.length === 0) return 0;
  const n = Number(a);
  return Number.isFinite(n) ? n : 0;
}

// ── Live executor ─────────────────────────────────────────────────────────────

const RETRY_DELAYS = [1000, 2000, 4000, 8000, 16000, 32000, 60000];
const DEBUG_FRAMES = envBool("PERPL_TRADE_DEBUG", false);
const DATA_DIR = new URL("../../data/", import.meta.url).pathname;

function debugFrame(dir: "in" | "out", msg: unknown): void {
  if (!DEBUG_FRAMES) return;
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    appendFileSync(
      `${DATA_DIR}perpl-trade-frames.jsonl`,
      JSON.stringify({ ts: new Date().toISOString(), dir, msg }) + "\n",
    );
  } catch {
    /* best-effort */
  }
}

export class LivePerplExecutor implements PerplExecutor {
  private ws: WebSocket | null = null;
  private stopped = false;
  private retry = 0;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;

  private ready = false;
  private lastSn: number | undefined;
  private head = 0;
  private reconnectEpoch = 0;

  private nextRq = 0;
  private accountId: number;
  private balance: AccountView | null = null;
  private pos: PerpPosition = { side: "flat", sizeMon: 0, entryPx: 0 };

  private intents = new Map<string, MakerIntent>();
  private intentByRq = new Map<number, MakerIntent>();
  private intentByOid = new Map<number, MakerIntent>();
  private seenFillKeys = new Set<string>();
  private fillCbs: Array<(f: FillEvent) => void> = [];

  private readonly maxRepostsPerMin = envNum("HEDGER_MAX_REPOSTS_PER_MIN", 30);
  /** Safety margin subtracted from order_ttl_blocks when setting lb. */
  private readonly lbMarginBlocks = envNum("PERPL_LB_MARGIN_BLOCKS", 5);

  constructor(
    private readonly market: PerplMarketInfo,
    private readonly auth: PerplAuth,
    accountId: number,
    private readonly leverageHundredths: number,
    private readonly onRepostStorm?: (intent: string) => void,
  ) {
    this.accountId = accountId;
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.ws?.close();
  }

  isReady(): boolean {
    return this.ready && this.ws?.readyState === WebSocket.OPEN;
  }

  headBlock(): number {
    return this.head;
  }

  onFill(cb: (f: FillEvent) => void): void {
    this.fillCbs.push(cb);
  }

  position(): PerpPosition {
    return this.pos;
  }

  account(): AccountView | null {
    return this.balance;
  }

  // ── order entry ────────────────────────────────────────────────────────────

  async placeMaker(side: PerpSide, px: number, sizeMon: number): Promise<string> {
    this.assertReady();
    const intent: MakerIntent = {
      intentId: nextIntentId("mk"),
      side,
      px,
      remainingSz: sizeMon,
      active: true,
      rq: 0,
      statusSeen: false,
      postedAtBlock: this.head,
      lb: 0,
      reconnectEpoch: this.reconnectEpoch,
      repostTimestamps: [],
    };
    this.intents.set(intent.intentId, intent);
    this.post(intent, /* postOnly */ true);
    return intent.intentId;
  }

  async placeTaker(side: PerpSide, sizeMon: number, slippageBps: number): Promise<string> {
    this.assertReady();
    const intent: MakerIntent = {
      intentId: nextIntentId("tk"),
      side,
      px: 0,
      remainingSz: sizeMon,
      active: true,
      rq: 0,
      statusSeen: false,
      postedAtBlock: this.head,
      lb: 0,
      reconnectEpoch: this.reconnectEpoch,
      repostTimestamps: [],
    };
    this.intents.set(intent.intentId, intent);
    const rq = this.takeRq();
    intent.rq = rq;
    this.intentByRq.set(rq, intent);
    intent.lb = this.lastValidBlock();
    this.send({
      mt: 22,
      rq,
      mkt: this.market.id,
      acc: this.accountId,
      t: ORDER_TYPE[side],
      p: 0, // market
      s: this.scaleSize(sizeMon),
      ms: slippageBps,
      fl: 4, // IOC
      lv: this.leverageHundredths,
      lb: intent.lb,
    });
    return intent.intentId;
  }

  async cancel(intentId: string): Promise<void> {
    const intent = this.intents.get(intentId);
    if (!intent || !intent.active) return;
    intent.active = false;
    if (intent.oid !== undefined) this.sendCancel(intent.oid);
  }

  async cancelAll(): Promise<void> {
    for (const intent of this.intents.values()) {
      if (intent.active) await this.cancel(intent.intentId);
    }
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private assertReady(): void {
    if (!this.isReady()) throw new Error("perpl executor not ready (no snapshot yet)");
  }

  private scalePrice(px: number): number {
    return Math.round(px * 10 ** this.market.priceDecimals);
  }

  private scaleSize(sz: number): number {
    return Math.round(sz * 10 ** this.market.sizeDecimals);
  }

  private unscalePrice(p: number): number {
    return p / 10 ** this.market.priceDecimals;
  }

  private unscaleSize(s: number): number {
    return s / 10 ** this.market.sizeDecimals;
  }

  private lastValidBlock(): number {
    const ttl = Math.max(2, this.market.orderTtlBlocks - this.lbMarginBlocks);
    return this.head + ttl;
  }

  private takeRq(): number {
    this.nextRq += 1;
    return this.nextRq;
  }

  private send(frame: Record<string, unknown>): void {
    debugFrame("out", frame);
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(frame));
  }

  private sendCancel(oid: number): void {
    this.send({
      mt: 22,
      rq: this.takeRq(),
      mkt: this.market.id,
      acc: this.accountId,
      oid,
      t: 5, // Cancel
      s: 0,
      fl: 0,
      lv: 0,
      lb: this.lastValidBlock(),
    });
  }

  /** Post (or re-post) a maker intent with a fresh rq + lb. */
  private post(intent: MakerIntent, postOnly: boolean): void {
    if (!intent.active || intent.remainingSz <= 0) return;

    // repost-storm guard
    const now = Date.now();
    intent.repostTimestamps = intent.repostTimestamps.filter((t) => now - t < 60_000);
    if (intent.repostTimestamps.length >= this.maxRepostsPerMin) {
      intent.active = false;
      this.onRepostStorm?.(intent.intentId);
      return;
    }
    intent.repostTimestamps.push(now);

    const rq = this.takeRq();
    if (intent.rq) this.intentByRq.delete(intent.rq);
    intent.rq = rq;
    intent.statusSeen = false;
    intent.oid = undefined;
    intent.postedAtBlock = this.head;
    intent.lb = this.lastValidBlock();
    intent.reconnectEpoch = this.reconnectEpoch;
    this.intentByRq.set(rq, intent);

    this.send({
      mt: 22,
      rq,
      mkt: this.market.id,
      acc: this.accountId,
      t: ORDER_TYPE[intent.side],
      p: this.scalePrice(intent.px),
      s: this.scaleSize(intent.remainingSz),
      fl: postOnly ? 1 : 0,
      lv: this.leverageHundredths,
      lb: intent.lb,
    });
  }

  private connect(): void {
    if (this.stopped) return;
    const ws = new WebSocket(`${PERPL_WS_URL}/ws/v1/trading`);
    this.ws = ws;
    this.ready = false;

    ws.onopen = () => {
      // First frame MUST be a freshly signed ApiKeySignIn.
      const frame = buildSignInFrame(this.auth);
      debugFrame("out", { ...frame, api_key: "<redacted>", signature: "<redacted>" });
      ws.send(JSON.stringify(frame));

      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ mt: 1, t: Date.now() }));
      }, 25_000);
      if (this.tickTimer) clearInterval(this.tickTimer);
      this.tickTimer = setInterval(() => this.expiryTick(), 500);
    };

    ws.onmessage = (ev) => {
      let msg: any;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      debugFrame("in", msg);
      this.handle(msg);
    };

    ws.onclose = (ev: any) => {
      if (this.pingTimer) clearInterval(this.pingTimer);
      if (this.tickTimer) clearInterval(this.tickTimer);
      this.pingTimer = null;
      this.tickTimer = null;
      this.ready = false;
      this.reconnectEpoch += 1; // invalidates "no status ⇒ expired" reasoning
      // 3401 = auth failure → reconnect re-signs with fresh timestamp/nonce anyway.
      this.reconnect();
    };
    ws.onerror = () => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    };
  }

  private reconnect(): void {
    if (this.stopped) return;
    const delay = RETRY_DELAYS[Math.min(this.retry, RETRY_DELAYS.length - 1)];
    this.retry += 1;
    setTimeout(() => this.connect(), delay);
  }

  /** Docs retry rule: head ≥ lb, no status for current rq, no reconnect since post → new rq. */
  private expiryTick(): void {
    if (!this.ready) return;
    for (const intent of this.intents.values()) {
      if (!intent.active || intent.remainingSz <= 0) continue;
      if (intent.oid !== undefined) continue; // resting — expiry arrives via mt:24 r:true
      if (intent.statusSeen) continue;
      if (intent.reconnectEpoch !== this.reconnectEpoch) {
        // A reconnect happened while in flight — snapshot didn't show it, so re-post.
        this.post(intent, intent.px > 0);
        continue;
      }
      if (intent.lb > 0 && this.head >= intent.lb) this.post(intent, intent.px > 0);
    }
  }

  private handle(msg: any): void {
    switch (msg.mt) {
      case 19: {
        // WalletSnapshot — authoritative reset point.
        this.lastSn = typeof msg.sn === "number" ? msg.sn : undefined;
        const accounts: any[] = msg.as ?? [];
        const acc =
          accounts.find((a) => a.id === this.accountId) ?? (accounts.length === 1 ? accounts[0] : undefined);
        if (acc) {
          if (this.accountId === 0) this.accountId = acc.id;
          this.nextRq = Math.max(this.nextRq, Number(acc.lfr) || 0);
          this.balance = { balanceUsd: parseAmount(acc.b), lockedUsd: parseAmount(acc.lb) };
        }
        this.retry = 0;
        this.ready = true;
        break;
      }
      case 23: {
        // OrdersSnapshot — adopt resting orders that match an active intent; the rest are ours
        // no longer (previous run, manual UI orders) and must not be touched.
        const orders: any[] = msg.d ?? [];
        for (const o of orders) {
          if (o.mkt !== this.market.id) continue;
          const intent = this.intentByRq.get(o.rq);
          if (intent && intent.active) {
            intent.oid = o.oid;
            intent.statusSeen = true;
            this.intentByOid.set(o.oid, intent);
          }
        }
        // Any active intent not adopted needs a re-post (its order died with the old session).
        for (const intent of this.intents.values()) {
          if (intent.active && intent.remainingSz > 0 && intent.oid === undefined && intent.px > 0) {
            this.post(intent, true);
          }
        }
        break;
      }
      case 26: {
        // PositionsSnapshot
        this.applyPositions(msg.d ?? []);
        break;
      }
      case 21: {
        // AccountUpdate
        if (msg.id === this.accountId || this.accountId === 0) {
          if (this.accountId === 0 && typeof msg.id === "number") this.accountId = msg.id;
          this.nextRq = Math.max(this.nextRq, Number(msg.lfr) || 0);
          this.balance = { balanceUsd: parseAmount(msg.b), lockedUsd: parseAmount(msg.lb) };
        }
        break;
      }
      case 24: {
        for (const o of msg.d ?? []) this.handleOrderUpdate(o);
        break;
      }
      case 25: {
        for (const f of msg.d ?? []) this.handleFill(f);
        break;
      }
      case 27: {
        this.applyPositions(msg.d ?? []);
        break;
      }
      case 100: {
        // Heartbeat: sn must be prev+1; h = head block.
        if (typeof msg.h === "number") this.head = msg.h;
        if (typeof msg.sn === "number") {
          if (this.lastSn !== undefined && msg.sn !== this.lastSn + 1) {
            this.ws?.close(); // gap → messages lost → resnapshot
            return;
          }
          this.lastSn = msg.sn;
        }
        break;
      }
      default:
        break;
    }
  }

  private handleOrderUpdate(o: any): void {
    if (o.mkt !== undefined && o.mkt !== this.market.id) return;
    let intent = this.intentByRq.get(o.rq);
    if (!intent && o.oid !== undefined) intent = this.intentByOid.get(o.oid);
    if (!intent) return;

    // Client-side dedup: first non-failure status is definitive for a given rq.
    if (o.rq === intent.rq) intent.statusSeen = true;
    if (o.oid !== undefined && intent.oid === undefined && o.rq === intent.rq) {
      intent.oid = o.oid;
      this.intentByOid.set(o.oid, intent);
    }

    const st: number = o.st ?? 0; // 2 Open, 3 PartFill, 4 Filled, 5 Canceled, 6 Expired, 7 Failed
    const removed: boolean = o.r === true;

    if (st === 7) {
      // Failed. sr 13 = CrossesBook (PostOnly rejected) → engine will re-price; sr 32 =
      // OrderDescIdTooLow → retry once with a fresh rq.
      const sr: number = o.sr ?? 0;
      if (sr === 32) {
        this.post(intent, intent.px > 0);
      } else {
        intent.active = false;
      }
      return;
    }

    if (removed && intent.active && intent.remainingSz > 0) {
      // Removed without being done from our side: expired (6) or canceled (5).
      if (st === 6) {
        this.post(intent, intent.px > 0); // lb expiry → re-post at same price
      } else if (st === 5) {
        intent.active = false; // canceled (by us or admin) — engine decides next step
      } else if (st === 4) {
        intent.active = false;
        intent.remainingSz = 0;
      }
    }
  }

  private handleFill(f: any): void {
    if (f.mkt !== this.market.id) return;
    const key = `${f.oid}-${f.at?.b ?? 0}-${f.at?.tx ?? 0}-${f.at?.l ?? 0}`;
    if (this.seenFillKeys.has(key)) return;
    this.seenFillKeys.add(key);

    const intent = this.intentByOid.get(f.oid);
    const sz = this.unscaleSize(f.s ?? 0);
    const px = this.unscalePrice(f.p ?? 0);
    if (intent) {
      intent.remainingSz = Math.max(0, intent.remainingSz - sz);
      if (intent.remainingSz <= 1e-9) intent.active = false;
    }
    const fill: FillEvent = {
      intentId: intent?.intentId ?? `ext-${f.oid}`,
      oid: f.oid,
      px,
      sz,
      feeUsd: parseAmount(f.f),
      maker: f.l === 1,
      tsMs: f.at?.t ?? Date.now(),
    };
    for (const cb of this.fillCbs) cb(fill);
  }

  private applyPositions(positions: any[]): void {
    for (const p of positions) {
      if (p.mkt !== this.market.id) continue;
      const st: number = p.st ?? 0; // 1 Open
      if (st === 1) {
        this.pos = {
          side: p.sd === 2 ? "short" : p.sd === 1 ? "long" : "flat",
          sizeMon: this.unscaleSize(p.s ?? 0),
          entryPx: this.unscalePrice(p.ep ?? 0),
        };
      } else {
        // Closed / liquidated / unwound → flat (a fresh open would arrive as st:1).
        this.pos = { side: "flat", sizeMon: 0, entryPx: 0 };
      }
    }
  }
}

// ── Paper executor ────────────────────────────────────────────────────────────

/**
 * Simulates maker/taker fills from the live public L2 book (same PerplFeed the
 * engine runs). A resting maker sell fills when the best bid crosses up through
 * its price; a maker buy when the best ask crosses down. Fees from market config.
 */
export class PaperPerplExecutor implements PerplExecutor {
  private intents = new Map<string, MakerIntent>();
  private fillCbs: Array<(f: FillEvent) => void> = [];
  private pos: PerpPosition = { side: "flat", sizeMon: 0, entryPx: 0 };
  private bal: AccountView;
  private timer: ReturnType<typeof setInterval> | null = null;
  private oidSeq = 1;

  constructor(
    private readonly market: PerplMarketInfo,
    private readonly feed: PerplFeed,
    initialBalanceUsd = envNum("HEDGER_PAPER_BALANCE_USD", 1000),
  ) {
    this.bal = { balanceUsd: initialBalanceUsd, lockedUsd: 0 };
  }

  async start(): Promise<void> {
    this.timer = setInterval(() => this.tick(), 500);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  isReady(): boolean {
    return this.feed.getBook() !== null;
  }

  headBlock(): number {
    return 0;
  }

  onFill(cb: (f: FillEvent) => void): void {
    this.fillCbs.push(cb);
  }

  position(): PerpPosition {
    return this.pos;
  }

  account(): AccountView | null {
    return this.bal;
  }

  async placeMaker(side: PerpSide, px: number, sizeMon: number): Promise<string> {
    const intent: MakerIntent = {
      intentId: nextIntentId("pmk"),
      side,
      px,
      remainingSz: sizeMon,
      active: true,
      rq: 0,
      statusSeen: true,
      postedAtBlock: 0,
      lb: 0,
      reconnectEpoch: 0,
      repostTimestamps: [],
    };
    this.intents.set(intent.intentId, intent);
    return intent.intentId;
  }

  async placeTaker(side: PerpSide, sizeMon: number, _slippageBps: number): Promise<string> {
    const book = this.feed.getBook();
    const id = nextIntentId("ptk");
    if (!book) return id; // stale book → no action (engine guards this anyway)
    const takerBuys = !makerRestsOnAsk(side); // shorts sell; closing a short buys
    const mid = (book.bids[0].px + book.asks[0].px) / 2;
    const vwap = vwapForNotional(book, takerBuys ? "buy" : "sell", sizeMon * mid);
    const sz = Math.min(sizeMon, vwap.filledSz);
    this.emitFill(id, this.oidSeq++, vwap.avgPx, sz, false);
    this.applyFillToPosition(side, vwap.avgPx, sz);
    return id;
  }

  async cancel(intentId: string): Promise<void> {
    const i = this.intents.get(intentId);
    if (i) i.active = false;
  }

  async cancelAll(): Promise<void> {
    for (const i of this.intents.values()) i.active = false;
  }

  private tick(): void {
    const book = this.feed.getBook();
    if (!book) return;
    for (const intent of this.intents.values()) {
      if (!intent.active || intent.remainingSz <= 0) continue;
      const restsOnAsk = makerRestsOnAsk(intent.side);
      const crossed = restsOnAsk ? book.bids[0].px >= intent.px : book.asks[0].px <= intent.px;
      if (!crossed) continue;
      // Fill up to the size visible at the crossing level — honest partial fills.
      const oppTop = restsOnAsk ? book.bids[0] : book.asks[0];
      const sz = Math.min(intent.remainingSz, oppTop.sz);
      if (sz <= 0) continue;
      intent.remainingSz -= sz;
      if (intent.remainingSz <= 1e-9) intent.active = false;
      this.emitFill(intent.intentId, this.oidSeq++, intent.px, sz, true);
      this.applyFillToPosition(intent.side, intent.px, sz);
    }
  }

  private emitFill(intentId: string, oid: number, px: number, sz: number, maker: boolean): void {
    const feeMicros = maker ? this.market.makerFeeMicros : this.market.takerFeeMicros;
    const feeUsd = (px * sz * feeMicros) / 1_000_000;
    this.bal.balanceUsd -= feeUsd;
    const fill: FillEvent = { intentId, oid, px, sz, feeUsd, maker, tsMs: Date.now() };
    for (const cb of this.fillCbs) cb(fill);
  }

  private applyFillToPosition(side: PerpSide, px: number, sz: number): void {
    const p = this.pos;
    const opening = side === "short-open" || side === "long-open";
    const dir = side.startsWith("short") ? "short" : "long";
    if (opening) {
      if (p.side === "flat" || p.side === dir) {
        const newSize = p.sizeMon + sz;
        p.entryPx = p.sizeMon > 0 ? (p.entryPx * p.sizeMon + px * sz) / newSize : px;
        p.sizeMon = newSize;
        p.side = dir;
      } else {
        // Opening against an existing opposite position nets it down.
        p.sizeMon -= sz;
        if (p.sizeMon <= 1e-9) this.pos = { side: "flat", sizeMon: 0, entryPx: 0 };
      }
    } else {
      // Closing: realize PnL into the balance.
      const closing = Math.min(sz, p.sizeMon);
      const pnl = p.side === "short" ? (p.entryPx - px) * closing : (px - p.entryPx) * closing;
      this.bal.balanceUsd += pnl;
      p.sizeMon -= closing;
      if (p.sizeMon <= 1e-9) this.pos = { side: "flat", sizeMon: 0, entryPx: 0 };
    }
  }
}
