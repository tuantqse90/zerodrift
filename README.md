# ZeroDrift

**Farm Perpl points without betting on price — hold MON, short the perp, churn the volume.**

A delta-neutral points farmer for Perpl's "Purple Summer" mPoints, wrapped in a Perpl-style
trading terminal, backed by an autonomous bot and an immutable on-chain registry. Live,
deployed, and safe by default.

## Try it

**https://hedge.nullterminal.xyz** — a full trading terminal: MON-perp chart (5m/15m/1h/4h),
live on-chain order book, hedge console, a points estimator, and a streaming log from the
real engine running in the background. Everything on the page is live data — market feed,
funding APR, points boost, spot price, and the on-chain epoch feed — no mocks.

![ZeroDrift terminal — live chart, order book, engine log, points estimator, on-chain epochs](docs/assets/demo.gif)

## What it does

Points programs punish naive farming: taker fees plus directional exposure eat the reward.
ZeroDrift removes both.

- **Long spot MON** via the NullTerminal aggregator + **short MON-perp on Perpl** at equal
  notional → price moves cancel out. You hold the position with zero directional risk.
- **Churn maker volume**: every 15 minutes it re-cycles 25% of the short with **PostOnly
  maker orders** to accrue weekly volume on the MON market, which carries a **2× points
  boost**.
- **It's not free — it's cheap and hedged.** The only real costs are fees and funding:
  - Maker **0.9bps** vs taker **6.9bps** — a full churn round-trip is ~1.8bps of maker fees.
  - Funding is currently **+17.5% APR**, and because we're short, **shorts EARN it** — the
    carry is on your side while it stays positive. When funding turns expensive (>10% APR
    against us) the bot pauses churning automatically.

Net: PnL is fees minus funding, decomposed to the cent, while you accrue boosted volume.

## On-chain

`HedgeRegistry.sol` — a permissionless attestation log for hedge epochs — is **deployed and
Sourcify-verified** on Monad mainnet.

| | |
|---|---|
| **Address** | [`0x24BD952B9BaD090Eab24A1a91948fA130c8D3A48`](https://monadscan.com/address/0x24BD952B9BaD090Eab24A1a91948fA130c8D3A48) |
| **Chain** | Monad mainnet (143) |
| **Deploy tx** | `0x9d63893c688b0e57c5f9ecccba6a5b53aaa6592261e4d9ce148a283ab1481dfc` |
| **Verification** | Sourcify `exact_match` |
| **Tests** | 9/9 Foundry (incl. fuzz round-trip + cross-owner isolation) |

It is **immutable, ownerless, and holds no funds.** Anyone can record their own hedge
epochs, keyed by `msg.sender`: `openEpoch()` pairs a spot leg (a NullTerminal swap tx) with
a perp leg (a Perpl fill digest) at equal notional; `closeEpoch()` finalizes it. Records are
immutable once closed and readable via `epochCount` / `getEpoch` views, with
`EpochOpened` / `EpochClosed` events. The terminal reads these views to render the live epoch
feed (the mainnet RPC caps `eth_getLogs` at 100 blocks, so the feed is view-driven plus a
rolling live scan).

## How the bot works

The engine is a **real autonomous bot**, not a UI toy. It runs 24/7 as the `zd-hedger`
docker container on a VPS in **paper mode** — simulating maker fills against the live
mainnet order book — and streams its rolling log, state, and volume to the site via
`status.json`. The exact same code path goes live with operator keys.

**FSM:**

```
INIT → SPOT_FILLED → HEDGED ⇄ CHURNING / REBALANCING / PAUSED_FUNDING → UNWINDING → CLOSED
```

- **INIT** buys spot MON through NullTerminal and hedges exactly what it holds.
- **HEDGED** is steady state; it opens an on-chain epoch and idles until a churn is due.
- **CHURNING** cycles a maker round-trip; **REBALANCING** corrects delta drift (maker first,
  taker only past the hard threshold); **PAUSED_FUNDING** stops churning when carry turns
  costly; **UNWINDING** exits cleanly and closes the epoch on-chain.

**Autonomy & safety rails (in code):**

| Guard | Behavior |
|---|---|
| Paper by default | Live requires `HEDGER_LIVE=true` **and** all four operator env vars — otherwise it can only simulate |
| Delta guard | Soft 1% / hard 3%; rebalances maker-first, taker only past hard |
| Funding pause | Auto-pauses churn above 10% APR against the position, resumes below 5% |
| Taker cap | Hard daily taker-spend cap (`$25` default); over budget → maker-only |
| Non-custodial | Perpl API keys **cannot withdraw**; the bot never generates, stores, or logs private keys |
| Kill switch | `docker stop zd-hedger`, or unwind the position cleanly first |
| Watchdogs | Stale-book restart, margin-pressure auto-unwind, Telegram alerts on every live action |

Defaults: `$100` notional, 2× leverage, 15-min churn at 25% fraction, 5s control loop.

## Architecture

Three packages, one design system.

```
zerodrift/
├── contracts/   Foundry — HedgeRegistry.sol (+ tests, deploy script)
├── bot/         Bun + TypeScript — the autonomous engine
│   └── src/
│       ├── lib/perpl.ts        public market-data WS (L2 book, funding, candles)
│       ├── lib/perpl-trade.ts  authenticated trading WS (Ed25519, orders,
│       │                       rq idempotency, re-post loop, paper/live seam)
│       └── hedger/             FSM (run.ts) · churn · funding · maker · pnl ·
│                               spot leg (NullTerminal) · on-chain registry ·
│                               CLIs (enroll, bootstrap)
└── web/         Vite + React + viem — the live terminal
    └── src/components/  chart · book ladder · hedge console · drift gauge ·
                         engine terminal · epoch history · points estimator
```

The UI carries the **NullTerminal design system** — Space Grotesk + JetBrains Mono, a
violet/mint glass palette — rendered as an avionics-style instrument terminal.

## Integrations

| Integration | What it powers |
|---|---|
| **Perpl** (perp CLOB) | Market-data WS (L2 book, funding), candle stream, and an authenticated trading WS signed with **Ed25519** API keys |
| **NullTerminal** aggregator | The spot leg — quote → swap for the MON long, via NT's public API |
| **Monad mainnet** | `HedgeRegistry` epoch attestations + all on-chain reads |

**Engineering worth noting** (each was a real wall we hit and solved):

- Perpl rejects foreign browser Origins (REST sends no CORS headers, WS closes `1002`) → a
  same-origin `/perpl` proxy via Caddy rewrites the `Origin` header so the browser can talk
  to Perpl directly.
- `rpc.monad.xyz` caps `eth_getLogs` at 100 blocks → the epoch feed is built from contract
  views plus a rolling 100-block scan instead of a full log query.
- viem's EIP-712 signing needs the **full** type set (including `EIP712Domain`, hex-string
  `chainId`) to reproduce Perpl's exact digest — the ethers convention of stripping it breaks
  auth with a 400.

## Run it yourself

The engine already runs by itself; going live is an operator flip, fully documented in
[`docs/golive.md`](docs/golive.md). In short:

```bash
cd bot && bun install

# enroll a Perpl trading key (EIP-712; never writes secrets to disk)
ENROLL_PRIVATE_KEY=0x<key> bun run hedger:enroll

# on-chain exchange account + AUSD deposit
HEDGER_PRIVATE_KEY=0x<key> MONAD_RPC_URL=https://rpc.monad.xyz bun run hedger:bootstrap --deposit 50

# run the engine — PAPER by default; add HEDGER_LIVE=true + the four keys to go live
bun run hedger
```

Contract side: `cd contracts && forge test` (9/9), deploy via
`script/deploy-hedge-registry.sh`.

## Tests

| Suite | Command | Coverage |
|---|---|---|
| Contract | `cd contracts && forge test` | 9/9 — HedgeRegistry store/emit, close guards, cross-owner isolation, fuzz round-trip |
| Bot unit | `cd bot && bun run test:unit` | 30/30 — churn-policy regimes & safety rails, funding APR/hysteresis, VWAP math, Ed25519 sign-in round-trip, ISO-week bucketing |
| Bot integration | `cd bot && bun run test:integration` | 5/5 — PaperPerplExecutor order lifecycle (maker fill → position → balance, taker close) + **live Perpl mainnet** (context, L2 book, coherence) |

Full bot suite: `cd bot && bun test` (35/35). Live tests skip with `SKIP_LIVE=1`.

## Built for Monad Spark

A 6-day on-chain build: an immutable verified contract on Monad mainnet, an autonomous bot
running live, and a polished terminal that streams the whole thing — deployed at
**https://hedge.nullterminal.xyz** and safe by default.

---

*Powered by [NullTerminal](https://nullterminal.xyz).*
