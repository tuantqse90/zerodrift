# ZeroDrift — 75-second demo script (owner records)

Target: 60–90s screen recording for the Monad Spark submission. Site:
**hedge.nullterminal.xyz** (paper, live mainnet data). Record at 1440-wide, dark mode.
Keep the cursor deliberate; let each panel breathe ~3s. Voiceover optional — the
on-screen captions below work silently too.

---

### 0:00–0:10 — The hook
**Show:** landing / hero at the top of the site.
**Say / caption:** "Farming a points program usually means churning volume — paying
fees and eating directional risk. ZeroDrift farms it **delta-neutral**: long spot MON
on NullTerminal, short MON-perp on Perpl, equal size. Price risk cancels; you keep the
volume."

### 0:10–0:25 — The instrument (proof it's balanced)
**Show:** the **Drift indicator** card. Point at the balance beam sitting centred on
"hedged", "In balance", and the two legs (SPOT LONG ≈ PERP SHORT, same MON).
**Say:** "Here's the live hedge — spot and perp matched to the MON, drift held near
zero. The trace shows drift over time; each churn cycle is a pulse that snaps back."

### 0:25–0:45 — Two engines (the differentiator)
**Show:** the **Engine session** panel. Click the strategy picker: **Churn** →
**Avellaneda-Stoikov**. Watch STRATEGY flip to `quoting`, QUOTE SPREAD show ±6 bps,
INV SKEW, SPREAD CAPTURED, NET PnL.
**Say:** "It's strategy-pluggable. Churn does simple close/re-open round-trips.
Avellaneda-Stoikov is a real market maker — continuous two-sided quotes that capture
the spread and skew to hold the hedge. Both run as separate live bots."

### 0:45–1:00 — Live A/B (the money shot)
**Show:** open the **A/B COMPARE** tab. Let the table settle; hover the winner marks.
**Say:** "Same $100 hedge, both engines side by side. Churn farms multiples more raw
volume for points; Avellaneda captures far more spread per dollar and nets ahead.
Honest, measured, live — not a backtest."

### 1:00–1:12 — On-chain receipt
**Show:** the **ON-CHAIN EPOCHS** tab, then click through to the HedgeRegistry contract
on monadscan (nav → Contract), showing an `EpochOpened` event.
**Say:** "Every hedge is recorded on-chain in a permissionless HedgeRegistry — an
auditable receipt on Monad, no custody, no token."
> ⚠️ Needs ≥1 real epoch first (paper = no-op). Either go live briefly, or have Claude
> write 1–2 demo epochs via the relayer before recording. Otherwise skip this scene and
> show the deployed+verified contract page instead.

### 1:12–1:15 — Close
**Show:** the site URL + the status legend (Perpl + Monad marks lit green).
**Say / caption:** "ZeroDrift — delta-neutral points farming on Monad. Live at
hedge.nullterminal.xyz. Built on Monad, powered by Perpl and NullTerminal."

---

### Shot list / checklist
- [ ] Both bots HEDGED + quoting/churning before recording (check the panels are live, not re-hedging).
- [ ] A/B tab shows real numbers on both columns (not "—").
- [ ] Feed legend green (Perpl live). If it says RECONNECTING, wait.
- [ ] (If including) at least one epoch visible on monadscan.
- [ ] End card: URL legible.
