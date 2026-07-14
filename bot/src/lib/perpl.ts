// perpl.ts — Perpl (perp CLOB on Monad) PUBLIC market-data client. READ-ONLY:
// no API key, no signing, no orders — only the unauthenticated /pub/context REST
// endpoint and the /ws/v1/market-data WebSocket.
//
// Protocol reference: https://github.com/PerplFoundation/api-docs
//   - order-book@<market_id>  L2 book: snapshot mt:15, update mt:16 (levels with o:0 removed)
//   - funding@<chain_id>      funding events per market (mt:10), 1h interval
//   - market-state@<chain_id> oracle/mark/mid + volume/OI (mt:9)
// Prices/sizes are scaled ints — decimals come from /pub/context per market
// (NO hardcoding, per repo rule).

export interface PerplMarketInfo {
  id: number;
  name: string;
  priceDecimals: number;
  sizeDecimals: number;
  /** Micros (10^-6 fractions of notional). 690 = 6.9 bps. */
  takerFeeMicros: number;
  makerFeeMicros: number;
  fundingIntervalSec: number;
  /** Max blocks ahead an order's `lb` (last execution block) may be set. */
  orderTtlBlocks: number;
  orderRetryBlocks: number;
  /** Initial margin fraction in hundredths of a percent (1000 = 10% = 10x max). */
  initialMarginFrac: number;
  maintenanceMarginFrac: number;
  /** Per-market points boost (bps, 10000 = 1x). */
  pointsBoostBps: number;
  minPostingAmount: string;
}

export interface PerplLevel {
  p: number; // scaled price
  s: number; // scaled size
  o: number; // order count
}

export interface PerplBook {
  /** Bids best→worst, human prices/sizes already unscaled. */
  bids: Array<{ px: number; sz: number }>;
  /** Asks best→worst. */
  asks: Array<{ px: number; sz: number }>;
  atMs: number; // local receive time
}

export interface PerplFundingEvent {
  marketId: number;
  feb: number; // funding event block (dedupe key)
  rateMicros: number; // per funding interval
  idxPx: number; // scaled index price
  atMs: number;
}

export interface PerplMarketState {
  oracle: number; // human prices
  mark: number;
  mid: number;
  bid: number;
  ask: number;
  atMs: number;
}

interface ContextMarket {
  id: number;
  name: string;
  symbol?: string;
  funding_interval_sec: number;
  order_ttl_blocks?: number;
  order_retry_blocks?: number;
  points_boost_bps?: number;
  config: {
    is_open: boolean;
    price_decimals: number;
    size_decimals: number;
    maker_fee: number;
    taker_fee: number;
    initial_margin?: number;
    maintenance_margin?: number;
    min_posting_amount?: string;
  };
}

const API_URL = process.env.PERPL_API_URL || "https://app.perpl.xyz/api";
const WS_URL = process.env.PERPL_WS_URL || "wss://app.perpl.xyz";
const CHAIN_ID = Number(process.env.PERPL_CHAIN_ID) || 143;

/** Fetch market metadata (decimals, fees, funding interval) from the public context. */
export async function fetchPerplMarket(name: string): Promise<PerplMarketInfo> {
  const res = await fetch(`${API_URL}/v1/pub/context`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`perpl context HTTP ${res.status}`);
  const ctx = (await res.json()) as { markets?: ContextMarket[] };
  // Names differ per deployment (mainnet "MON" vs testnet "MON Perp") — match
  // symbol, exact name, or first word of the name.
  const m = (ctx.markets ?? []).find(
    (x) =>
      x.config?.is_open &&
      (x.symbol === name || x.name === name || x.name?.split(" ")[0] === name),
  );
  if (!m) throw new Error(`perpl market "${name}" not found or closed`);
  return {
    id: m.id,
    name: m.name,
    priceDecimals: m.config.price_decimals,
    sizeDecimals: m.config.size_decimals,
    takerFeeMicros: m.config.taker_fee,
    makerFeeMicros: m.config.maker_fee,
    fundingIntervalSec: m.funding_interval_sec,
    orderTtlBlocks: m.order_ttl_blocks ?? 20,
    orderRetryBlocks: m.order_retry_blocks ?? 5,
    initialMarginFrac: m.config.initial_margin ?? 1000,
    maintenanceMarginFrac: m.config.maintenance_margin ?? 2000,
    pointsBoostBps: m.points_boost_bps ?? 10_000,
    minPostingAmount: m.config.min_posting_amount ?? "0",
  };
}

/**
 * Live market-data feed for ONE market's book + all-market funding/state.
 * Maintains the L2 book from snapshot+updates, reconnects with backoff, and
 * treats any book sequence gap as fatal for the connection (reconnect → fresh
 * snapshot) — simplest correct handling per the docs.
 */
export class PerplFeed {
  private ws: WebSocket | null = null;
  private bidMap = new Map<number, PerplLevel>();
  private askMap = new Map<number, PerplLevel>();
  private bookAtMs = 0;
  private bookSid: number | undefined;
  private bookSn: number | undefined;
  private state: PerplMarketState | null = null;
  private funding: PerplFundingEvent | null = null;
  private retry = 0;
  private stopped = false;
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly market: PerplMarketInfo,
    /** Called once per NEW funding event on any market (deduped by caller if needed). */
    private readonly onFunding?: (ev: PerplFundingEvent, marketId: number) => void,
  ) {}

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.ws?.close();
  }

  /** Book is usable only if we have both sides and a message in the last 15s. */
  getBook(): PerplBook | null {
    if (Date.now() - this.bookAtMs > 15_000) return null;
    const pd = 10 ** this.market.priceDecimals;
    const sd = 10 ** this.market.sizeDecimals;
    const bids = [...this.bidMap.values()]
      .sort((a, b) => b.p - a.p)
      .map((l) => ({ px: l.p / pd, sz: l.s / sd }));
    const asks = [...this.askMap.values()]
      .sort((a, b) => a.p - b.p)
      .map((l) => ({ px: l.p / pd, sz: l.s / sd }));
    if (bids.length === 0 || asks.length === 0) return null;
    return { bids, asks, atMs: this.bookAtMs };
  }

  getState(): PerplMarketState | null {
    return this.state;
  }

  /** Latest funding event for THIS market (rate is per funding interval, in micros). */
  getFunding(): PerplFundingEvent | null {
    return this.funding;
  }

  private connect(): void {
    if (this.stopped) return;
    const ws = new WebSocket(`${WS_URL}/ws/v1/market-data`);
    this.ws = ws;

    ws.onopen = () => {
      this.retry = 0;
      this.bookSid = undefined;
      this.bookSn = undefined;
      ws.send(
        JSON.stringify({
          mt: 5, // SubscriptionRequest
          subs: [
            { stream: `order-book@${this.market.id}`, subscribe: true },
            { stream: `funding@${CHAIN_ID}`, subscribe: true },
            { stream: `market-state@${CHAIN_ID}`, subscribe: true },
          ],
        }),
      );
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ mt: 1, t: Date.now() }));
      }, 25_000);
    };

    ws.onmessage = (ev) => {
      let msg: any;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      this.handle(msg);
    };

    ws.onclose = () => {
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = null;
      // Stale book must not be served while disconnected.
      this.bookAtMs = 0;
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
    const delay = Math.min(1000 * 2 ** this.retry, 60_000);
    this.retry += 1;
    setTimeout(() => this.connect(), delay);
  }

  private handle(msg: any): void {
    switch (msg.mt) {
      case 6: {
        // SubscriptionResponse — capture the book stream's sid.
        for (const s of msg.subs ?? []) {
          if (s?.stream === `order-book@${this.market.id}` && s.sid != null) this.bookSid = s.sid;
        }
        break;
      }
      case 15: {
        // L2BookSnapshot — replace both sides.
        if (this.bookSid !== undefined && msg.sid !== this.bookSid) break;
        this.bidMap.clear();
        this.askMap.clear();
        for (const l of msg.bid ?? []) this.bidMap.set(l.p, l);
        for (const l of msg.ask ?? []) this.askMap.set(l.p, l);
        this.bookAtMs = Date.now();
        this.bookSn = typeof msg.sn === "number" ? msg.sn : undefined;
        break;
      }
      case 16: {
        // L2BookUpdate — upsert levels; o:0 removes. The book stream's sn is a
        // global block counter, not a per-stream +1 sequence (docs: "other streams
        // may have gaps"), so a "gap" is normal — do NOT reconnect on it (that was
        // a reconnect loop). Staleness is bounded by getBook()'s 15s guard.
        if (this.bookSid !== undefined && msg.sid !== this.bookSid) break;
        if (typeof msg.sn === "number") this.bookSn = msg.sn;
        for (const l of msg.bid ?? []) {
          if (l.o === 0) this.bidMap.delete(l.p);
          else this.bidMap.set(l.p, l);
        }
        for (const l of msg.ask ?? []) {
          if (l.o === 0) this.askMap.delete(l.p);
          else this.askMap.set(l.p, l);
        }
        this.bookAtMs = Date.now();
        break;
      }
      case 9: {
        // MarketStateUpdate — keyed by market id.
        const d = msg.d?.[String(this.market.id)] ?? msg.d?.[this.market.id];
        if (d) {
          const pd = 10 ** this.market.priceDecimals;
          this.state = {
            oracle: d.orl / pd,
            mark: d.mrk / pd,
            mid: d.mid / pd,
            bid: d.bid / pd,
            ask: d.ask / pd,
            atMs: Date.now(),
          };
        }
        break;
      }
      case 10: {
        // MarketFundingUpdate — map of market id -> FundingEvent, all markets.
        const entries = Object.entries(msg.d ?? {});
        for (const [mid, evAny] of entries) {
          const ev = evAny as { feb: number; rate: number; idx: number };
          if (!ev || typeof ev.feb !== "number") continue;
          const parsed: PerplFundingEvent = {
            marketId: Number(mid),
            feb: ev.feb,
            rateMicros: ev.rate,
            idxPx: ev.idx,
            atMs: Date.now(),
          };
          if (Number(mid) === this.market.id) this.funding = parsed;
          this.onFunding?.(parsed, Number(mid));
        }
        break;
      }
      default:
        break;
    }
  }
}

export interface VwapFill {
  /** Size-weighted average human price over the walked levels. */
  avgPx: number;
  /** Base size filled (human units, e.g. MON). */
  filledSz: number;
  /** USD notional actually covered (collateral AUSD ≈ $1). */
  filledUsd: number;
  /** True when the book had enough depth for the whole notional. */
  full: boolean;
}

/**
 * Walk one side of the book and compute the taker VWAP for a USD notional.
 * side="sell" hits bids (we sell the perp), side="buy" lifts asks.
 */
export function vwapForNotional(book: PerplBook, side: "buy" | "sell", usd: number): VwapFill {
  const levels = side === "sell" ? book.bids : book.asks;
  let remainingUsd = usd;
  let costUsd = 0;
  let sz = 0;
  for (const l of levels) {
    const lvlUsd = l.px * l.sz;
    const takeUsd = Math.min(lvlUsd, remainingUsd);
    costUsd += takeUsd;
    sz += takeUsd / l.px;
    remainingUsd -= takeUsd;
    if (remainingUsd <= 0) break;
  }
  const filledUsd = usd - Math.max(0, remainingUsd);
  return {
    avgPx: sz > 0 ? costUsd / sz : 0,
    filledSz: sz,
    filledUsd,
    full: remainingUsd <= 0,
  };
}
