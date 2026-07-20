# MM-Lab — paper-tuning loop for the standalone MM mode

A ready-to-paste goal prompt that iterates MM parameters against LIVE market data in
PAPER mode until a measurable bar is met, then stops and reports. It never touches
live money: that final decision (and wallet signature) stays human.

Why paper-only is a hard rule and not a preference: a goal whose exit condition is
"live PnL is good" pushes an agent to keep mutating a system that holds real
positions until a number moves. That is how accounts die. Tune on paper against the
real book; go live by hand.

## The prompt

Paste the block below into Claude Code (as a `/goal`, or just as a message). Adjust
markets/bar/iterations to taste before pasting — not mid-run.

```
MM-Lab paper tuning loop — HARD RULES, no exceptions:
- PAPER ONLY: never set HEDGER_LIVE, never call /api/cloud/*, never ssh/rsync to any
  server, never touch cloud instances or deploy anything.
- Work only inside bot/, running local engines with HEDGER_MODE=mm.
- Never edit strategy source mid-loop; iterate through env knobs only.

Goal: for each market in [MON, ZEC, HYPE], find an env knob set
  (HEDGER_AS_GAMMA, HEDGER_AS_KAPPA, HEDGER_AS_MIN_HALF_BPS, HEDGER_AS_MAX_HALF_BPS,
   HEDGER_MM_CLIP_FRAC, HEDGER_MM_INV_BAND_FRAC)
such that a 30-minute local paper run at HEDGER_NOTIONAL_USD=100 ends with:
  equityPnlUsd > 0        (the adverse-selection-honest number: realized + mark-to-mid)
  AND netPnlUsd > 0       (the spread-capture decomposition agrees)
  AND spreadCaptureUsd >= 2 × (makerFeesUsd + takerFeesUsd)
  AND max |invMon| observed < 0.5 × baseMon
  AND fillCount >= 6  (no-fill runs prove nothing)
reproduced in 2 consecutive runs with the same knobs. When equityPnlUsd and netPnlUsd
disagree, believe equityPnlUsd — spreadCapture books adverse fills as profit.

Loop per market (max 6 iterations, then mark FAILED and move on):
1. Start from repo defaults; change AT MOST ONE knob per iteration, chosen from the
   previous run's dominant failure mode. Know the gamma floor first: at the default
   HEDGER_AS_GAMMA=120 / KAPPA=1500 the AS formula alone floors the half-spread near
   ~6.4bps regardless of vol — on a 1.4bps market that quotes far off-touch and
   almost never fills. Tightening starts with LOWER gamma (e.g. 20) or HIGHER kappa.
   - fillCount < 6            → lower HEDGER_AS_GAMMA first; then lower
                                 HEDGER_AS_MIN_HALF_BPS toward the fee floor
                                 (never below 1.2) or raise HEDGER_MM_CLIP_FRAC one step
   - fees >= spread capture   → raise HEDGER_AS_MIN_HALF_BPS
   - inventory pinned at band → raise HEDGER_AS_GAMMA (stronger mean-reversion skew)
                                 or lower HEDGER_MM_CLIP_FRAC
   - REBALANCING entered      → lower HEDGER_MM_CLIP_FRAC or widen HEDGER_MM_INV_BAND_FRAC
2. Run exactly:
     HEDGER_MODE=mm HEDGER_MARKET=<mkt> HEDGER_NOTIONAL_USD=100 <knobs> \
       HEDGER_STATUS_FILE=<scratch>/<mkt>-i<N>.json HEDGER_DATA_DIR=<scratch>/<mkt>-i<N>/ \
       bun run mm
   for 30 minutes (background + timed kill). Sample the status file every 2 minutes;
   track the max |invMon| seen across samples (the end value hides excursions).
3. Record one row in docs/mm-lab-results.md:
   | market | iter | knobs changed | fills | spreadCap | fees | funding | netPnl | max|inv|/base | verdict |
4. Bar met twice consecutively → mark the market PASSED with its knob set.

Done when every market is PASSED or FAILED and docs/mm-lab-results.md ends with a
5-line summary: best (market, knobs), its measured numbers, and the honest caveat
that paper fills are optimistic (paper never rejects a crossing PostOnly and always
fills at the resting price; live has queue position and 3401-style rejections).
Finish by listing exactly what a human must do to go live — and do NOT do it.
```

## Reading the results

- `netPnlUsd = spreadCaptureUsd + fundingUsd − fees`. In MM mode funding is signed by
  inventory and near-zero on average — the edge, if any, is spread capture.
- Paper is optimistic by construction: PostOnly orders that would cross are filled as
  makers instead of rejected, and there is no queue at the touch. Treat a paper PASS
  as "worth a $10 live probe", never as "profitable".
- Market reality check (measured 2026-07-20): median top spreads — BTC 0.02bps,
  ETH 0.05, SOL 0.13, HYPE 0.57, ZEC 0.75, MON 1.40 — against a 1.8bps maker
  round-trip. Tight-book markets (BTC/ETH/SOL) mostly idle at the min-half floor;
  that is the design behaving, not a bug.
