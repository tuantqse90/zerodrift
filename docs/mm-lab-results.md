# MM-Lab results — MON (2026-07-20)

30-minute paper runs against the live MON book, $100 base, sampled every 2 min.
Bar (docs/mm-lab.md): equityPnlUsd > 0 AND netPnlUsd > 0 AND spreadCap ≥ 2×fees
AND max |inv| < 50% base AND fills ≥ 6 — twice consecutively with the same knobs.

| market | iter | knobs (vs defaults)        | fills | spreadCap | fees   | edge*  | equity  | max\|inv\|/base | verdict |
|--------|------|----------------------------|-------|-----------|--------|--------|---------|-----------------|---------|
| MON    | A1   | (defaults, γ=120)          | 6     | $0.0033   | $0.0016| +$0.0017| +$0.126 | 18.1%          | pass (thin — equity was trend luck) |
| MON    | B1   | γ=20, minHalf=1.2          | 8     | $0.0026   | $0.0017| +$0.0009| +$0.123 | 18.1%          | FAIL — fees ≥ ½·spreadCap |
| MON    | C1   | γ=20, minHalf=2, clip=6%   | 3     | $0.0025   | $0.0016| +$0.0009| +$0.124 | 18.1%          | FAIL — fills < 6 |
| MON    | A2   | (defaults, confirm)        | 7     | $0.0080   | $0.0018| +$0.0062| +$0.025 | 8.0%           | **pass — clean** |
| MON    | B2   | γ=20, minHalf=2            | 9     | $0.0136   | $0.0022| +$0.0114| −$0.074 | 5.8%           | FAIL — equity < 0 |

*edge = spreadCaptureUsd − fees: the strategy's real earnings before inventory mark.

## Summary

1. **MON: PASSED with repo defaults** (γ=120, κ=1500, minHalf=2, clip=3%, band=15%) —
   two consecutive passes; the A2 run was the clean one: inventory oscillated
   −101→−373→−235 (both sides filling, mean-reverting), edge 3.6× fees.
2. Round 1's +$0.12 equity across ALL configs was one MON dip marking up a common
   long — directional luck, not MM. equityPnl vs edge told them apart on sight.
3. B2 is the cautionary row: BEST edge (+$0.0114) yet negative equity — it sat short
   274 MON into a rising mark. Tighter quotes buy more edge and more adverse
   inventory; the bar's equity clause exists exactly for this.
4. Honest scale: the confirmed edge is ~$0.006 / 30 min / $100 base ≈ **$0.29/day per
   $100** before paper optimism (infinite queue priority, no PostOnly rejects). Treat
   a live probe as validation spend, not yield.

To go live (human decision, wallet signature required): hedge.nullterminal.xyz →
standalone MM → MON → small notional → LIVE → Run. Watch equityPnlUsd vs netPnlUsd
in the status feed; if they diverge live the way B2 did on paper, stop.
