# ZeroDrift — progress log

## Day 1 (2026-07-14)

**Contract** ✅
- `HedgeRegistry.sol`: immutable, permissionless, per-`msg.sender` epoch log. 9/9 foundry
  tests green (incl. fuzz round-trip, cross-owner isolation). Deploy script ready
  (`contracts/script/deploy-hedge-registry.sh`, forge create --legacy + cast smoke).
  Mainnet deploy pending operator key.

**Perpl trading client** ✅ code-complete, typecheck clean
- `bot/src/lib/perpl-trade.ts`: Ed25519 signin (mt:29), OrderRequest (mt:22) with docs-exact
  retry semantics (same-rq before status/lb, new-rq on expiry, sr:32 handling), heartbeat
  sn tracking + head block from mt:100, snapshot adoption after reconnect, repost-storm cap.
  `PaperPerplExecutor` simulates maker fills from the live L2 book — same interface.
- `bot/src/lib/perpl.ts`: extended market info (order_ttl_blocks, points_boost_bps,
  initial_margin, min_posting_amount) — all fetched from /pub/context, zero hardcoding.

**Testnet findings (probe: `bun run probe:testnet`)**
- Context: testnet MON market is id **64**, name "MON Perp" (mainnet: id 10, "MON") →
  market matching now by symbol/name/first-word. `order_ttl_blocks=6` (~2.4s!) confirms
  the re-post loop is mandatory. Testnet fees 1bps maker / 3.5bps taker. MON size_decimals=0.
- Enrollment: **Origin header must be ABSENT or whitelisted** — unlisted Origin → 400.
  Server-side enroll works with no Origin. Browser enroll from our domain will need Perpl
  whitelisting → paste-key stays the primary web UX.
- **viem EIP-712 gotcha**: must pass FULL `typed_data.types` INCLUDING `EIP712Domain`
  (hex-string chainId + salt in domain). Stripping it (ethers convention) changes the
  digest → 400. Verified digest parity with ethers.TypedDataEncoder.
- Enroll with valid signature → **404 "target profile not found"**: wallet needs a Perpl
  profile first (one-time connect on the Perpl web app). Signature path proven correct.
- Trading WS: bogus signin → close **3401 "unauthorized"** (matches docs; reconnect path
  validated).

**Blocked on operator (for Day 2 order-flow validation)**
1. Create a Perpl profile for the bot wallet: connect wallet once at testnet.perpl.xyz
   (and later app.perpl.xyz for mainnet).
2. Then either `bun run hedger:enroll` (CLI) or create the key at /apikeys and set
   `PERPL_API_KEY` + `PERPL_ED25519_PRIVKEY`.
3. Testnet order-flow validation: place/cancel PostOnly, measure lb expiry, verify fill
   parsing (`bun run probe:testnet` extension).

**Hedger engine** ✅ (pulled Day-3 work forward)
- Full FSM verified in paper mode on LIVE mainnet data: INIT (NT quote $100 → 4528 MON)
  → SPOT_FILLED → HEDGED (maker short fill, exactly 0.9bps fee) → CHURNING → full
  close/reopen round-trip (2×1339 MON maker fills) → HEDGED. Restart-safe (delta guard
  rebuilds the short from durable spot state).
- Bug caught by smoke run: raw delta guard tripped during the churn's own close leg
  (29% > 3% hard) → fixed via `Churner.pendingMon()` exclusion.
- **Mainnet MON market: `points_boost_bps=20000` → 2x points on MON.** ttl=20 blocks.
- Overnight paper run left running (15m churn) — check `bot/data/perpl-hedger*.jsonl`.

## Next

- Day 2: testnet order round-trip with real key (owner-blocked); pin Amount-string scaling.
- Day 3: review overnight paper ledgers; tune churn/reprice.
- Day 4: live smoke $50 + registry mainnet deploy + funding-sign verification.
- Day 5: web UI + deploy hedge.nullterminal.xyz.
- Day 6: polish + submission.
