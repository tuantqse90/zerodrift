# MM trend-guard — fix prompt + re-validation loop

Why this exists: 41h of LIVE MM on MON (2026-07-20 → 07-22) lost **−$7.83 true PnL**
while the feed showed +$2.87. Anatomy from the fill log (1,401 fills): avg sell
0.022998 vs avg buy 0.023028 — **sold 12.4bps BELOW buys** across a +5.3% MON
uptrend, plus a 2,044 MON short marked against. Fees were $0.41 (irrelevant).
Two-sided quoting in a persistent trend is sell-low-buy-high on repeat: the exact
B2 pattern from docs/mm-lab-results.md, confirmed with real money. The churn engine
already has a TrendMonitor pause for this; the MM engine deliberately shipped
without one. This prompt adds it and re-validates before any human goes live again.

## The prompt (paste into Claude Code)

```
MM trend-guard: implement, test, and lab-validate. HARD RULES, no exceptions:
- PAPER ONLY: never set HEDGER_LIVE, never call /api/cloud/*, never ssh/rsync
  to any server, never touch running containers or deploy anything.
- Work only in bot/. All engines run locally with HEDGER_MODE=mm.
- Hedge mode (run.ts) behavior must remain byte-identical — do not touch its files
  except where listed below.

CONTEXT (read these first):
- docs/mm-trend-guard.md (this file) — the live post-mortem numbers.
- bot/src/hedger/run-mm.ts — the MM loop. TrendMonitor is already constructed and
  trend.update(mid, now) is already called every tick; only its pause verdict is
  unused. status already writes trendPaused: false (hardcoded).
- bot/src/hedger/trend.ts — TrendMonitor: strengthPct(), shouldPause(now),
  hysteresis via HEDGER_TREND_PAUSE_PCT (default 1.0) / HEDGER_TREND_RESUME_PCT
  (0.4) over HEDGER_TREND_WINDOW_MS (120s). Reuse it; do not fork it.
- bot/src/hedger/strategies/mm-quoter.ts — the quoter. flatten(exec) cancels both
  resting quotes; tick() re-places. Do NOT add trend logic inside the quoter —
  the guard belongs in the loop, same separation as the hedge engine.

IMPLEMENT (in run-mm.ts only, plus config if a new knob is needed):
1. In state QUOTING, when trend.shouldPause(Date.now()) is true:
   - call quoter.flatten(exec) once on entry (not every tick),
   - stop calling quoter.tick() while paused (no resting quotes at all — the
     conservative churn-engine pattern; do NOT try one-sided cleverness),
   - keep EVERYTHING else running: inventory guard → REBALANCING still fires,
     margin guard still fires, status still writes.
2. While paused, if |invMon| > baseMon * mmInvBandFrac (inventory stranded against
   a moving market), enter REBALANCING immediately rather than waiting for the
   0.5 hard cap — a trend is exactly when stranded inventory bleeds fastest.
3. Resume quoting only when shouldPause() goes false (TrendMonitor's own
   hysteresis; add no second threshold).
4. Status: replace the hardcoded trendPaused: false with the real flag, and pushEvent
   on every pause/resume transition so the feed shows when and why quoting stopped.
5. Log one console line on pause/resume with strengthPct at the moment.

TESTS (bun test, patterns per existing test/unit/*):
- Unit-test the pause decision wiring with a scripted TrendMonitor (constructor-
  inject or a tiny seam — HEDGER_CONFIG is a frozen import, knobs must be
  injectable): paused ⇒ quoter.tick not called AND flatten called once;
  band-breach while paused ⇒ REBALANCING; resume ⇒ quoting again.
- Do not weaken any existing test. Full suite + bunx tsc --noEmit must pass.

LAB RE-VALIDATION (this is the exit bar — code alone does not finish the task):
1. Rebuild the A/B harness from scratchpad if missing: run TWO paper engines
   side-by-side on live MON data, 4 HOURS each, separate HEDGER_DATA_DIR and
   HEDGER_STATUS_FILE, sampling status every 2 min into samples.jsonl:
     G-on:  defaults + the new guard active (default thresholds)
     G-off: identical but HEDGER_TREND_PAUSE_PCT=999 (guard disabled)
2. Score by equityPnlUsd (the honest paper number) and by trajectory:
   max drawdown of equity across samples, % of samples trendPaused (G-on),
   fills, spreadCap vs fees.
3. PASS iff: G-on final equityPnlUsd >= G-off final equityPnlUsd
   AND G-on max equity drawdown <= G-off max drawdown
   AND G-on still fills >= 4 times in 4h (a guard that never quotes is not a
   market maker — if fills = 0, the thresholds are too tight: loosen
   HEDGER_TREND_PAUSE_PCT one step and re-run, max 3 iterations).
4. If MON happens to be flat all 4 hours (trendPaused < 2% of samples in G-on),
   the run is INCONCLUSIVE for the guard — extend 4 more hours rather than
   declaring victory on a windless day.
5. Append a results table + 5-line verdict to docs/mm-trend-guard.md, commit
   everything with a message explaining WHY (cite the −$7.83/−12.4bps numbers).

DONE when: tests green, typecheck green, the A/B table is in this file with a
PASS or a documented FAIL, and the final message lists exactly what a human must
do to deploy + go live — and does NOT do it.
```

## Post-mortem data for reference

| metric | value |
|---|---|
| window | 2026-07-20 17:07 → 2026-07-22 09:55 UTC (41h LIVE, $450 base) |
| fills | 1,401 (100% maker, 0 takers) |
| bought / sold | 195,338 MON @ 0.023028 / 197,382 MON @ 0.022998 |
| avg sell − avg buy | **−12.4 bps** (a working MM must be positive) |
| ending inventory | short 2,044 MON into a +5.3% uptrend |
| fees / funding | $0.41 / +$0.05 |
| true PnL | **−$7.83** · feed netPnlUsd claimed +$2.87 (spreadCapture blindness) |

## Validation round 1 — INCONCLUSIVE, and a design flaw found (2026-07-23)

4-hour guard-on vs guard-off paper A/B on live MON (run on the VPS, not local, after
two laptop-sleep interruptions):

| leg   | fills | final equity | max drawdown | paused samples | max trend (120s) |
|-------|-------|--------------|--------------|----------------|------------------|
| G-on  | 9     | −$0.071      | −$0.278      | **0 / 120**    | 0.677%           |
| G-off | 11    | −$0.066      | −$0.217      | 0 / 120        | 0.677%           |

**Verdict: INCONCLUSIVE.** MON drifted <0.7% in any 120s window all 4 hours, below the
1.0% pause line, so the guard never activated (0/120) and the two legs are noise-apart.
The bar's own escape clause applies: never declare victory on a windless day.

**But the run exposed the real problem.** Reconstructing the 120s-window trend strength
over the actual 48.7h losing session (from midAtFill in the fills ledger — direction-
independent, so trustworthy unlike a PnL replay):

| window | max strength | % of windows over the 1.0% churn line |
|--------|--------------|----------------------------------------|
| 120s (churn default) | 2.865% | **2.6%** |
| 30 min               | 4.608% | **27.1%** |

The churn engine's 120s window is tuned for fast adverse spikes. What bled the MM was a
slow grind — +2.2–5.3% over tens of hours — which barely registers over 120s. With the
original guard the pause would have fired ~2.6% of the time: near-useless. A 30-min
window sees the grind (27%).

**Fix shipped:** MM now runs TrendMonitor on its own window (HEDGER_MM_TREND_WINDOW_MS
default 30min, pause 0.6% / resume 0.3%) via a constructor override; churn's 120s is
untouched. The fills ledger now persists `side` so a post-mortem PnL replay is possible
next time (it was not — the direction had to be inferred and the inferred inventory came
out −37,950 MON vs the real ~+2,500, so no PnL claim is made from this run).

**Still not proven.** A longer window is data-motivated but unvalidated live: a windless
market can't test it, and the current ledger can't backtest PnL. Next: re-run the A/B
with the new MM defaults during a session that actually trends (pause samples > 2% in
G-on), scored on equity + drawdown, before any human re-enables live.
