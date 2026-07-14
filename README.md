# ZeroDrift

**Delta-neutral points farming for Perpl on Monad.** Farm Perpl mPoints ("Purple Summer")
without directional risk: long spot MON via the [NullTerminal](https://nullterminal.xyz)
aggregator, short MON-perp on [Perpl](https://perpl.xyz) at equal notional, churn maker
volume — and record every hedge epoch on-chain in the `HedgeRegistry`.

Built for the **Monad Spark** hackathon. Powered by NullTerminal.

## Why

Points farming naively is expensive: taker fees + directional exposure. ZeroDrift keeps you
delta-neutral (spot long ≈ perp short), uses PostOnly maker orders (0.9bps vs 6.9bps on
mainnet), watches funding (shorts *earn* when funding is positive), and decomposes every
cent of cost so you know exactly what a point costs you.

## Architecture

```
bot/        Bun + TypeScript hedging engine
            ├── lib/perpl.ts        public market-data WS (L2 book, funding, market state)
            ├── lib/perpl-trade.ts  authenticated trading WS (Ed25519, mt:22 orders,
            │                       rq idempotency, lb re-post loop, paper/live seam)
            └── hedger/             engine FSM + spot leg (NullTerminal) + CLIs
contracts/  Foundry — HedgeRegistry.sol (permissionless on-chain hedge-epoch attestations)
web/        Public dashboard + one-click hedging (non-custodial)
```

## Safety model

- **Paper by default.** Live trading requires `HEDGER_LIVE=true` **and** the operator's
  keys in env. Code never generates, stores, or logs private keys.
- Perpl API keys can never withdraw funds (protocol guarantee).
- Hard caps: notional, leverage (2x default), daily taker spend.

## Status

Day 1/6 — contract done (9/9 tests), Perpl trading client + enrollment verified against
testnet. See `docs/progress.md`.
