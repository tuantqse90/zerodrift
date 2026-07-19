# ZeroDrift — Monad Spark submission kit

> **Delta-neutral points farming on Monad.** Long spot MON + short MON-perp on Perpl at
> equal size → zero price risk. Farm Perpl mPoints for near-free, two ways: simple
> **churn** or a real **Avellaneda-Stoikov market maker**. Non-custodial, on-chain receipts.

- **Live app:** https://hedge.nullterminal.xyz
- **HedgeRegistry (verified):** [`0x24BD952B9BaD090Eab24A1a91948fA130c8D3A48`](https://monadscan.com/address/0x24BD952B9BaD090Eab24A1a91948fA130c8D3A48)
- **Built on:** Monad · **Powered by:** Perpl (perp DEX) + NullTerminal (spot aggregator)

---

## The pitch (30 seconds)

Farming a points program the naïve way means churning volume — paying fees and eating
directional risk. ZeroDrift does it **delta-neutral**: you hold spot MON, short the same
size of MON-perp on Perpl, and the price exposure cancels. What's left is boosted maker
volume (points) at ~0.9bps cost. It ships as a **public, non-custodial web app** *and* a
headless engine, with the hedge recorded **on-chain** in a permissionless registry.

## Why it's different

1. **Two real strategies, measured live.** `Churn` (discrete close/re-open round-trips)
   vs `Avellaneda-Stoikov` (continuous two-sided market making that *captures the spread*
   and self-balances inventory). Switch on the fly.
2. **A live A/B tab** runs both engines on the same $100 hedge and shows, honestly, the
   trade-off: churn farms more raw volume; Avellaneda earns more spread per dollar and
   nets ahead.
3. **Honest accounting.** A `spread captured = Σ|fill − mid|·size` metric — the true
   maker edge, direction-independent — plus a net-PnL that credits it.
4. **Non-custodial.** Perpl keys live in the browser (per wallet), sign in-browser, and
   **can never withdraw** (protocol guarantee). Orders need no wallet pop-up.
5. **On-chain, no token, no custody.** Each hedge writes an `EpochOpened`/`EpochClosed`
   receipt to the HedgeRegistry (UUPS-free, immutable, permissionless).
6. **Farm-as-a-service.** Any user can run their own 24/7 instance on our server with
   **one wallet signature** — per-user containers, AES-encrypted keys that still can't
   withdraw, personal live status feed, signed stop/unwind. Live now:
   `curl https://hedge.nullterminal.xyz/api/cloud/health`.
7. **Proven with real money.** The full flow ran with real funds on mainnet, on camera:
   2,818 MON spot vs 2,818 MON short (drift 0.00%), Avellaneda quoting 42-MON clips
   ±6.5bps, and a live maker fill reducing the position mid-recording.

## Architecture (one glance)

```
Browser (non-custodial)                 Headless engine (24/7, paper→live)
  wallet + Perpl key (in-browser)         same FSM + strategies
  ├─ spot: hold MON (NullTerminal)        ├─ churn  ─┐
  ├─ perp: Perpl WS, Ed25519-signed       ├─ AS MM  ─┤→ Perpl (PostOnly maker)
  └─ attest → HedgeRegistry (on-chain)    └─ status.json → the live site
```

Stack: React + viem + @noble/curves (web) · Bun + TypeScript (engine) · Foundry / solc
0.8.24 (contracts, chain 143). No wallet SDK — injected `window.ethereum` only.

---

## 🎬 Demo recording script (~80s, Avellaneda-forward)

Record at 1440-wide, dark mode, on **hedge.nullterminal.xyz**. Captions in quotes.

**0:00–0:10 — Hook.** Land on the site; the MON-perp chart + drift gauge in view.
> "Farming points usually costs you fees and price risk. ZeroDrift farms it
> delta-neutral — long spot MON, short MON-perp, zero drift."

**0:10–0:22 — The hedge is balanced.** Point at the **Drift indicator**: marker centred
on *hedged*, "In balance", spot leg ≈ perp leg.
> "Live hedge — spot and perp matched, drift held at zero. The trace is drift over time;
> each cycle pulses and snaps back."

**0:22–0:42 — Avellaneda (the star).** In the **Engine session** panel, click the picker
→ **Avellaneda-Stoikov**. Show STRATEGY `quoting`, **QUOTE SPREAD ±6 bps**, INV SKEW,
SPREAD CAPTURED, NET PnL.
> "It's strategy-pluggable. Avellaneda-Stoikov is a real market maker — it quotes both
> sides around the mid, captures the spread, and skews its quotes to hold the hedge. No
> timer, no wash — genuine two-sided liquidity."

**0:42–0:58 — Live A/B (money shot).** Open the **A/B COMPARE** tab. Let it settle.
> "Same $100 hedge, both engines side by side. Churn farms more raw volume for points;
> Avellaneda captures far more spread per dollar and nets ahead. Measured live, not a
> backtest."

**0:58–1:10 — On-chain + non-custodial.** Nav → **Contract** (monadscan, verified). Then
back to the **Hedge** card: "keys active", "no wallet pop-ups".
> "Every hedge is an on-chain receipt in a permissionless registry on Monad. Keys stay in
> your browser and can't withdraw — non-custodial by design."

**1:10–1:20 — Close.** End on the site URL + the Perpl/Monad marks lit green.
> "ZeroDrift — delta-neutral points farming on Monad. Live at hedge.nullterminal.xyz.
> Built on Monad, powered by Perpl and NullTerminal."

### Shot checklist
- [ ] Engine panel on **Avellaneda** shows `quoting` + a non-zero QUOTE SPREAD.
- [ ] A/B tab shows real numbers in **both** columns.
- [ ] Status legend green (Perpl feed live).
- [ ] (Optional) an epoch visible on monadscan, or the verified contract page.

---

## Talking points / likely questions

- **"Is churn just wash trading?"** Churn is discrete and disclosed; Avellaneda is genuine
  two-sided market making (posts liquidity, captures spread). We surface both honestly.
- **"How do points accrue?"** Boosted maker volume on Perpl (MON market carries a 2×
  points boost). Delta-neutral means we farm it without directional bets.
- **"Custody / safety?"** Perpl API keys can't withdraw funds — worst case is trading
  loss, which the hedge minimises. Keys never leave the browser (per wallet).
- **"On-chain component?"** HedgeRegistry (deployed + Sourcify-verified) records each
  hedge epoch — an auditable, permissionless receipt.

## Status at submission
Web + both paper engines live 24/7 on a self-hosted VPS, plus the **zd-cloud
farm-as-a-service API** (per-user 24/7 instances, wallet-signature-gated — see
`docs/cloud.md`). The live-trading path is **not hypothetical**: it ran with real funds
on Perpl mainnet (hedge opened, Avellaneda quoting, real maker fills) and is a
one-command runbook for anyone else (`docs/golive.md`). Tests: 9/9 Foundry + 71 Bun,
plus a production e2e of the cloud API with a burner wallet.
