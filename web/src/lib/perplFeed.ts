// perplFeed.ts — browser port of the bot's public Perpl market-data client.
// Same protocol: /v1/pub/context + /ws/v1/market-data (mt:15/16 book, mt:10 funding,
// mt:9 market state). Prices/sizes unscaled from per-market decimals — no hardcoding.

export interface PerplMarketInfo {
  id: number;
  name: string;
  priceDecimals: number;
  sizeDecimals: number;
  takerFeeMicros: number;
  makerFeeMicros: number;
  fundingIntervalSec: number;
  orderTtlBlocks: number;
  initialMarginFrac: number;
  pointsBoostBps: number;
}

export interface BookLevel {
  px: number;
  sz: number;
}
export interface PerplBook {
  bids: BookLevel[];
  asks: BookLevel[];
  atMs: number;
}
export interface FundingEvent {
  marketId: number;
  feb: number;
  rateMicros: number;
  atMs: number;
}

// Perpl rejects foreign browser Origins on both REST (no CORS headers) and the
// WebSocket (close 1002) — verified 2026-07-14. Everything therefore goes through
// a same-origin `/perpl/*` reverse proxy (vite dev proxy locally, Caddy in prod)
// that rewrites the Origin header.
const wsOrigin = location.protocol === "https:" ? `wss://${location.host}` : `ws://${location.host}`;
export const PERPL_API = import.meta.env.VITE_PERPL_API_URL || "/perpl/api";
export const PERPL_WS = import.meta.env.VITE_PERPL_WS_URL || `${wsOrigin}/perpl`;
export const PERPL_CHAIN_ID = Number(import.meta.env.VITE_PERPL_CHAIN_ID) || 143;

export async function fetchPerplMarket(name: string): Promise<PerplMarketInfo> {
  const res = await fetch(`${PERPL_API}/v1/pub/context`);
  if (!res.ok) throw new Error(`perpl context HTTP ${res.status}`);
  const ctx = (await res.json()) as { markets?: any[] };
  const m = (ctx.markets ?? []).find(
    (x) => x.config?.is_open && (x.symbol === name || x.name === name || x.name?.split(" ")[0] === name),
  );
  if (!m) throw new Error(`market "${name}" not found`);
  return {
    id: m.id,
    name: m.name,
    priceDecimals: m.config.price_decimals,
    sizeDecimals: m.config.size_decimals,
    takerFeeMicros: m.config.taker_fee,
    makerFeeMicros: m.config.maker_fee,
    fundingIntervalSec: m.funding_interval_sec,
    orderTtlBlocks: m.order_ttl_blocks ?? 20,
    initialMarginFrac: m.config.initial_margin ?? 1000,
    pointsBoostBps: m.points_boost_bps ?? 10_000,
  };
}

export class PerplFeed {
  private ws: WebSocket | null = null;
  private bidMap = new Map<number, any>();
  private askMap = new Map<number, any>();
  private bookAtMs = 0;
  private bookSid: number | undefined;
  private bookSn: number | undefined;
  private retry = 0;
  private stopped = false;
  private pingTimer: number | null = null;
  funding: FundingEvent | null = null;
  onUpdate: (() => void) | null = null;

  constructor(private readonly market: PerplMarketInfo) {}

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.ws?.close();
  }

  getBook(): PerplBook | null {
    if (Date.now() - this.bookAtMs > 15_000) return null;
    const pd = 10 ** this.market.priceDecimals;
    const sd = 10 ** this.market.sizeDecimals;
    const bids = [...this.bidMap.values()].sort((a, b) => b.p - a.p).map((l) => ({ px: l.p / pd, sz: l.s / sd }));
    const asks = [...this.askMap.values()].sort((a, b) => a.p - b.p).map((l) => ({ px: l.p / pd, sz: l.s / sd }));
    if (!bids.length || !asks.length) return null;
    return { bids, asks, atMs: this.bookAtMs };
  }

  private connect(): void {
    if (this.stopped) return;
    const ws = new WebSocket(`${PERPL_WS}/ws/v1/market-data`);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.bookSid = undefined;
      this.bookSn = undefined;
      ws.send(
        JSON.stringify({
          mt: 5,
          subs: [
            { stream: `order-book@${this.market.id}`, subscribe: true },
            { stream: `funding@${PERPL_CHAIN_ID}`, subscribe: true },
          ],
        }),
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
    ws.onclose = () => {
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.bookAtMs = 0;
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
      case 6:
        for (const s of msg.subs ?? []) {
          if (s?.stream === `order-book@${this.market.id}` && s.sid != null) this.bookSid = s.sid;
        }
        break;
      case 15:
        if (this.bookSid !== undefined && msg.sid !== this.bookSid) break;
        this.bidMap.clear();
        this.askMap.clear();
        for (const l of msg.bid ?? []) this.bidMap.set(l.p, l);
        for (const l of msg.ask ?? []) this.askMap.set(l.p, l);
        this.bookAtMs = Date.now();
        this.bookSn = typeof msg.sn === "number" ? msg.sn : undefined;
        this.onUpdate?.();
        break;
      case 16:
        if (this.bookSid !== undefined && msg.sid !== this.bookSid) break;
        if (typeof msg.sn === "number" && this.bookSn !== undefined && msg.sn !== this.bookSn + 1) {
          this.ws?.close();
          return;
        }
        if (typeof msg.sn === "number") this.bookSn = msg.sn;
        for (const l of msg.bid ?? []) l.o === 0 ? this.bidMap.delete(l.p) : this.bidMap.set(l.p, l);
        for (const l of msg.ask ?? []) l.o === 0 ? this.askMap.delete(l.p) : this.askMap.set(l.p, l);
        this.bookAtMs = Date.now();
        this.onUpdate?.();
        break;
      case 10: {
        const ev = (msg.d ?? {})[String(this.market.id)];
        if (ev && typeof ev.feb === "number") {
          this.funding = { marketId: this.market.id, feb: ev.feb, rateMicros: ev.rate, atMs: Date.now() };
          this.onUpdate?.();
        }
        break;
      }
    }
  }
}

export function fundingAprPct(rateMicros: number, intervalSec: number): number {
  return (rateMicros / 1_000_000) * ((365 * 24 * 3600) / intervalSec) * 100;
}
