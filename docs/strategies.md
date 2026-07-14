# Farming strategies

ZeroDrift's engine is strategy-pluggable via `HEDGER_STRATEGY`. Each strategy runs
delta-neutral (long spot MON on NullTerminal + short MON-perp on Perpl); they differ
in *how* they work the perp leg to accrue boosted maker volume.

Deploy one bot per strategy — they run side by side, each writing its own status feed
and ledgers. The web engine panel has a picker that switches which bot's feed it shows.

## `churn` (default)

Discrete close→re-open round-trips of a clip of the short (two maker fills/cycle at
0.9bps). Funding-adaptive intensity, depth-aware clip sizing, settlement guard,
anti-sybil jitter, a trend filter (sits out fast moves), and a spot-leg rebalance
variation (some corrections trued up on spot so the perp isn't the only tape).

Objective: maximise boosted volume at minimum cost. Robust and predictable.

## `avellaneda`

Continuous two-sided market making (Avellaneda-Stoikov). Maintains a resting
short-close (bid) and short-open (ask) around the AS reservation price:

- **Inventory skew** mean-reverts the short to the hedge *target* (not flat), so the
  perp self-balances and the hedge stays tight.
- **Half-spread** widens with realized vol (AS term) but is floored strictly above the
  0.9bps maker fee, so every matched pair *captures* the spread — profit, with points
  as a byproduct. It quotes through any funding regime.
- **κ clamp**: the AS spread is bounded to an interpretable bps band so thin-market
  mis-calibration can't blow it up. A hard inventory band pulls a side before the delta
  guard trips.

Objective: capture the bid-ask spread while farming. Less wash-like (genuine two-sided
liquidity). Telemetry: `QUOTE SPREAD` (half-spread bps) + `INV SKEW`.

Tuning: `HEDGER_AS_GAMMA` (risk aversion), `HEDGER_AS_KAPPA` (book intensity),
`HEDGER_AS_MIN/MAX_HALF_BPS`, `HEDGER_AS_MAX_SKEW_BPS`, `HEDGER_AS_REPRICE_BPS`,
`HEDGER_AS_CLIP_FRAC`, `HEDGER_AS_INV_BAND_FRAC`.

## Deploying multiple bots

Each bot MUST have its own status file **and** data dir (`HEDGER_DATA_DIR`), or they
clobber each other's state/ledgers. Caddy serves `/status*.json` from the status dir.

```bash
# churn bot (default)
docker run -d --name zd-hedger --network host --restart unless-stopped \
  -v /opt/zerodrift:/opt/zerodrift -w /opt/zerodrift/bot \
  -e HEDGER_STATUS_FILE=/opt/zerodrift/status/status.json \
  -e MONAD_RPC_URL=https://rpc.monad.xyz \
  oven/bun:1-alpine bun run hedger

# avellaneda bot (own status feed + own data dir; tight-inventory tuning)
docker run -d --name zd-hedger-as --network host --restart unless-stopped \
  -v /opt/zerodrift:/opt/zerodrift -w /opt/zerodrift/bot \
  -e HEDGER_STRATEGY=avellaneda \
  -e HEDGER_STATUS_FILE=/opt/zerodrift/status/status-avellaneda.json \
  -e HEDGER_DATA_DIR=/opt/zerodrift/bot/data-avellaneda \
  -e HEDGER_AS_INV_BAND_FRAC=0.015 \
  -e HEDGER_AS_CLIP_FRAC=0.012 \
  -e HEDGER_LOOP_MS=1500 \
  -e MONAD_RPC_URL=https://rpc.monad.xyz \
  oven/bun:1-alpine bun run hedger
```

Inventory-control rule of thumb: `AS_CLIP_FRAC < AS_INV_BAND_FRAC < deltaHardPct`, so a
single fill can't vault the band into the hard-delta guard, and the band pulls the
offending side before a fast move breaches. A shorter `HEDGER_LOOP_MS` reprices sooner
(reacts faster in volatile markets) at the cost of more order churn.

Redeploy code: `rsync -az bot/src/ root@<VPS>:/opt/zerodrift/bot/src/` then
`docker restart zd-hedger zd-hedger-as` (bun runs the source directly — no build step).
Adding a strategy to the web picker = one entry in `STRATEGIES` (web/src/App.tsx) with
its `src` status path. **Both bots stay PAPER unless the live env keys are set.**
