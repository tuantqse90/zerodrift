// run.ts — ZeroDrift hedger entrypoint.
//
// Delta-neutral Perpl points farmer: long spot MON (NullTerminal) + short MON-perp
// (Perpl, PostOnly maker) + periodic maker-volume churn + on-chain HedgeRegistry
// epochs. PAPER by default; live only with HEDGER_LIVE=true + operator keys.
//
// FSM: INIT → SPOT_FILLED → HEDGED ⇄ CHURNING/REBALANCING/PAUSED_FUNDING → UNWINDING → CLOSED

import { fetchPerplMarket, PerplFeed, type PerplBook, type PerplFundingEvent } from "../lib/perpl";
import {
  hexToBytes,
  LivePerplExecutor,
  PaperPerplExecutor,
  type FillEvent,
  type PerplExecutor,
} from "../lib/perpl-trade";
import { alertOnce, announceOnlineOnce, sendTelegram } from "../lib/telegram";
import { PERPL_CHAIN_ID } from "../lib/config";
import { Churner } from "./churn";
import { ChurnPolicy } from "./churn-policy";
import { HEDGER_CONFIG as CFG } from "./config";
import { FundingMonitor } from "./funding";
import { MakerWorker } from "./maker";
import { PnlLedger } from "./pnl";
import { closeEpochOnChain, openEpochOnChain } from "./registry";
import { buySpotMon, sellSpotMon, spotPriceUsd } from "./spot";
import { loadState, saveState, transition } from "./state";
import { pushEvent, recordHistory, writeStatus } from "./status";
import { TrendMonitor } from "./trend";
import { AvellanedaStrategy } from "./strategies/avellaneda-strategy";

const MODE = CFG.live ? "LIVE" : "PAPER";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  console.log(
    `zerodrift hedger starting · strategy=${CFG.strategy} market=${CFG.market} notional=$${CFG.notionalUsd} ` +
      `lv=${CFG.leverage / 100}x churn=${CFG.churnIntervalMs / 60000}m×${CFG.churnFraction} ` +
      `delta=${CFG.deltaSoftPct}/${CFG.deltaHardPct}% mode=${MODE} chain=${PERPL_CHAIN_ID}`,
  );

  const market = await fetchPerplMarket(CFG.market);
  console.log(
    `market ${market.id} "${market.name}" pd=${market.priceDecimals} sd=${market.sizeDecimals} ` +
      `maker=${market.makerFeeMicros / 100}bps taker=${market.takerFeeMicros / 100}bps ` +
      `ttl=${market.orderTtlBlocks}blk boost=${market.pointsBoostBps}bps`,
  );

  const pnl = new PnlLedger();
  const funding = new FundingMonitor(market);
  const state = loadState();
  const churner = new Churner();
  const churnPolicy = new ChurnPolicy(market.fundingIntervalSec);
  const trend = new TrendMonitor();
  const asStrategy = new AvellanedaStrategy();
  let churnIntensity: string = "waiting";

  const feed = new PerplFeed(market, (ev: PerplFundingEvent) => {
    if (ev.marketId !== market.id) return;
    funding.update(ev);
    const pos = exec.position();
    if (pos.side === "short" && pos.sizeMon > 0) {
      const book = feed.getBook();
      const px = book ? (book.bids[0].px + book.asks[0].px) / 2 : pos.entryPx;
      const usd = funding.accrualUsd(ev, pos.sizeMon, px);
      pnl.recordFunding(usd, ev.rateMicros);
    }
  });
  feed.start();

  const exec: PerplExecutor = CFG.live
    ? new LivePerplExecutor(
        market,
        {
          apiKey: process.env.PERPL_API_KEY!,
          edPriv: hexToBytes(process.env.PERPL_ED25519_PRIVKEY!),
          chainId: PERPL_CHAIN_ID,
        },
        Number(process.env.PERPL_ACCOUNT_ID) || 0,
        CFG.leverage,
        (intentId) => void alertOnce("ph:repost-storm", 600_000, `⚠️ repost storm on ${intentId} — intent halted`),
      )
    : new PaperPerplExecutor(market, feed);
  await exec.start();

  // Funding-sign auto-verify (live): a realized funding credit that contradicts the
  // assumed sign would invert the pause logic — alert loudly if it ever happens.
  funding.onInverted = () =>
    void alertOnce(
      "ph:funding-sign",
      3600_000,
      `🚨 ZeroDrift: funding sign appears INVERTED vs HEDGER_FUNDING_SIGN — pause logic may be backwards. Verify and flip the env.`,
    );
  exec.onFundingCredit((usd) => {
    funding.observeCredit(usd);
    pushEvent("info", `funding settlement ${usd >= 0 ? "+" : ""}$${usd.toFixed(4)} · sign ${funding.signStatus}`);
  });

  // One fill stream feeds everything: ledger, workers, churner.
  let hedgeWorker: MakerWorker | null = null;
  let rebalanceWorker: MakerWorker | null = null;
  let unwindWorker: MakerWorker | null = null;
  // Which leg the current REBALANCING cycle corrects on: perp (fast/default) or a
  // one-shot spot swap (variation, chosen per-entry so the perp isn't the only tape).
  let rebalanceRoute: "perp" | "spot" | null = null;
  const fillLog: FillEvent[] = [];
  exec.onFill((f) => {
    const fb = feed.getBook();
    const fillMid = fb ? (fb.bids[0].px + fb.asks[0].px) / 2 : undefined;
    pnl.recordFill(f, CFG.live ? "live" : "paper", fillMid);
    fillLog.push(f);
    hedgeWorker?.handleFill(f);
    rebalanceWorker?.handleFill(f);
    unwindWorker?.handleFill(f);
    churner.handleFill(f);
    const dir = f.side ?? "?";
    console.log(
      `[${new Date().toISOString()}] fill ${f.maker ? "maker" : "taker"} ${dir} ${f.sz.toFixed(4)} @ ${f.px} ` +
        `fee=$${f.feeUsd.toFixed(4)} (${f.intentId})`,
    );
    pushEvent("fill", `fill ${f.maker ? "maker" : "taker"} ${dir} ${f.sz.toFixed(4)} @ ${f.px} fee=$${f.feeUsd.toFixed(4)}`);
  });

  await announceOnlineOnce(
    `🟢 ZeroDrift hedger online (${MODE}) · ${market.name} $${CFG.notionalUsd} target · churn ${CFG.churnIntervalMs / 60000}m`,
  );

  if (CFG.unwind && state.state !== "CLOSED") transition(state, "UNWINDING", "HEDGER_UNWIND=true at boot");

  // Paper mode holds the perp position in memory only, so a restart lands with a
  // durable "hedged" state but a flat executor. Re-open the short from SPOT_FILLED
  // instead of tripping the delta guard. (Live mode rebuilds the position from the
  // Perpl snapshot, so this only affects paper.)
  if (
    !CFG.live &&
    (state.state === "HEDGED" ||
      state.state === "CHURNING" ||
      state.state === "REBALANCING" ||
      state.state === "PAUSED_FUNDING")
  ) {
    transition(state, "SPOT_FILLED", "paper restart — re-establishing short from durable spot state");
  }

  let lastBookAt = Date.now();
  let takerSpentToday = 0;
  let takerDay = new Date().toISOString().slice(0, 10);
  let lastDigest = Date.now();
  let unwindStartedAt = 0;
  let unwindSpotDone = false;

  const takerBudgetOk = (usd: number): boolean => {
    const day = new Date().toISOString().slice(0, 10);
    if (day !== takerDay) {
      takerDay = day;
      takerSpentToday = 0;
    }
    return takerSpentToday + usd <= CFG.maxDailyTakerUsd;
  };

  for (;;) {
    try {
      const book = feed.getBook();

      // ── watchdog: stale market data ──────────────────────────────────────
      if (book) lastBookAt = Date.now();
      else if (Date.now() - lastBookAt > 120_000) {
        void alertOnce("ph:ws-stale", 600_000, "⚠️ ZeroDrift: order book stale >2min — restarting feed");
        feed.stop();
        await sleep(1000);
        feed.start();
        lastBookAt = Date.now();
      }

      if (!book || !exec.isReady()) {
        await sleep(CFG.loopMs);
        continue;
      }

      const mid = (book.bids[0].px + book.asks[0].px) / 2;
      trend.update(mid, Date.now());
      const trendPaused = trend.shouldPause(Date.now());
      const pos = exec.position();
      const shortMon = pos.side === "short" ? pos.sizeMon : 0;
      const deltaMon = state.spotMon - shortMon;
      const deltaPct = state.targetSizeMon > 0 ? Math.abs((deltaMon / state.targetSizeMon) * 100) : 0;

      // ── margin guard (live): locked balance crowding out equity ─────────
      const acct = exec.account();
      if (CFG.live && acct && acct.balanceUsd > 0 && acct.lockedUsd / acct.balanceUsd > 0.9) {
        if (state.state !== "UNWINDING" && state.state !== "CLOSED") {
          transition(state, "UNWINDING", `margin guard: locked ${acct.lockedUsd}/${acct.balanceUsd}`);
        }
      }

      switch (state.state) {
        case "INIT": {
          const px = (await spotPriceUsd()) ?? mid;
          state.targetSizeMon = CFG.notionalUsd / px;
          const fill = await buySpotMon(CFG.notionalUsd);
          if (!fill) {
            console.log("spot buy: no route — retrying next tick");
            break;
          }
          state.spotMon = fill.mon;
          state.spotCostUsd = fill.usd;
          state.spotTxHash = fill.txHash;
          state.targetSizeMon = fill.mon; // hedge exactly what we hold
          pnl.recordGas(fill.gasUsd);
          pnl.event("spot-buy", { ...fill, mode: MODE });
          transition(state, "SPOT_FILLED", `bought ${fill.mon.toFixed(4)} MON @ $${fill.px.toFixed(5)}`);
          break;
        }

        case "SPOT_FILLED": {
          if (!hedgeWorker) hedgeWorker = new MakerWorker("short-open", state.targetSizeMon - shortMon, exec);
          await hedgeWorker.tick(book);
          if (hedgeWorker.done || shortMon >= state.targetSizeMon * (1 - CFG.deltaSoftPct / 100)) {
            await hedgeWorker.cancel();
            hedgeWorker = null;
            state.epochId = await openEpochOnChain(
              market.id,
              CFG.notionalUsd,
              state.spotTxHash,
              `perp-${fillLog.length}`,
            );
            state.epochOpenedAt = Date.now();
            saveState(state);
            transition(state, "HEDGED", `short ${shortMon.toFixed(4)}/${state.targetSizeMon.toFixed(4)} MON`);
          }
          break;
        }

        case "HEDGED": {
          // ── Avellaneda-Stoikov: continuous two-sided quoting ─────────────
          if (CFG.strategy === "avellaneda") {
            // AS runs its own inventory band, so only a HARD breach is a safety event
            // (not the soft guard the churn strategy trips on).
            if (deltaPct > CFG.deltaHardPct) {
              await asStrategy.flatten(exec);
              transition(state, "REBALANCING", `delta ${deltaPct.toFixed(2)}% > hard (AS safety)`);
              break;
            }
            // NB: no funding pause here (unlike churn). AS earns the bid-ask spread,
            // and the hedge holds the short at target regardless — so funding is a sunk
            // carry either way; pausing would only forfeit spread capture. Spread edge
            // (~2bps/pair) dwarfs the clamped ±17.5% APR funding per fill, so we quote
            // through it.
            await asStrategy.tick({
              book,
              mid,
              shortMon,
              targetMon: state.targetSizeMon,
              volFrac: trend.realizedVolFrac(),
              exec,
              market,
            });
            churnIntensity = asStrategy.intensity;
            break;
          }

          // ── Churn: discrete round-trips ──────────────────────────────────
          if (deltaPct > CFG.deltaSoftPct) {
            transition(state, "REBALANCING", `delta ${deltaPct.toFixed(2)}% > soft ${CFG.deltaSoftPct}%`);
            break;
          }
          if (funding.shouldPause()) {
            transition(
              state,
              "PAUSED_FUNDING",
              `paying ${(-funding.earnAprPct()).toFixed(1)}% APR > ${CFG.fundingPauseApr}%`,
            );
            void alertOnce("ph:funding-pause", 3600_000, `⏸ churn paused: funding ${funding.earnAprPct().toFixed(1)}% APR (raw rate ${funding.raw()?.rateMicros}µ)`);
            break;
          }
          {
            const decision = churnPolicy.decide(
              shortMon,
              book,
              funding.earnAprPct(),
              Date.now(),
              Math.random(),
              trendPaused,
              trend.strengthPct(),
            );
            churnIntensity = decision.intensity;
            if (decision.churn) {
              churner.start(decision.clipMon);
              churnPolicy.markCycled(Date.now());
              transition(
                state,
                "CHURNING",
                `round-trip #${churner.roundTrips + 1} · clip ${decision.clipMon.toFixed(0)} MON · ${decision.reason}`,
              );
            }
          }
          break;
        }

        case "CHURNING": {
          const doneRt = await churner.tick(book, exec);
          // Raw delta includes the churn's own intentional gap — judge only the excess.
          const adjDeltaPct =
            state.targetSizeMon > 0
              ? Math.abs(((deltaMon - churner.pendingMon()) / state.targetSizeMon) * 100)
              : 0;
          if (doneRt) {
            pnl.event("churn-roundtrip", { n: churner.roundTrips, weekVolumeUsd: pnl.weekVolume() });
            transition(state, "HEDGED", `round-trip #${churner.roundTrips} complete`);
          } else if (adjDeltaPct > CFG.deltaHardPct) {
            await churner.abort();
            transition(state, "REBALANCING", `excess delta ${adjDeltaPct.toFixed(2)}% > hard during churn`);
          }
          break;
        }

        case "REBALANCING": {
          // delta > 0: spot exceeds short. delta < 0: short exceeds spot.
          const sz = Math.abs(deltaMon);

          // Pick the correction leg once per cycle. A hard breach always takes the
          // fast perp path; a soft drift is sometimes trued up on the SPOT leg
          // instead, so the perp doesn't show every correction (less wash-like) — but
          // only while that keeps the hedged size inside a ±15% band of nominal, so
          // repeated spot corrections can't quietly shrink or bloat the position.
          if (rebalanceRoute === null) {
            const spotAfter = state.spotMon + (deltaMon > 0 ? -sz : sz);
            const inBand =
              spotAfter > state.targetSizeMon * 0.85 && spotAfter < state.targetSizeMon * 1.15;
            rebalanceRoute =
              deltaPct <= CFG.deltaHardPct && inBand && Math.random() < CFG.spotRebalanceProb ? "spot" : "perp";
          }

          if (rebalanceRoute === "spot") {
            // One-shot spot swap to match the short (no Perpl volume, no round-trip).
            const sell = deltaMon > 0;
            const fill = sell ? await sellSpotMon(sz) : await buySpotMon(sz * mid);
            if (fill) {
              state.spotMon += sell ? -fill.mon : fill.mon;
              pnl.recordGas(fill.gasUsd);
              pnl.event("spot-rebalance", { side: sell ? "sell" : "buy", mon: fill.mon, usd: fill.usd, px: fill.px, mode: MODE });
              saveState(state);
              rebalanceRoute = null;
              transition(state, "HEDGED", `spot-side rebalance ${sell ? "sold" : "bought"} ${fill.mon.toFixed(2)} MON`);
            } else {
              rebalanceRoute = "perp"; // no spot route this tick → fall back to perp
            }
            break;
          }

          // Perp path: grow the short (delta>0) or shrink it (delta<0).
          const side = deltaMon > 0 ? "short-open" : "short-close";
          if (deltaPct > CFG.deltaHardPct) {
            const notional = sz * mid;
            if (takerBudgetOk(notional)) {
              takerSpentToday += notional;
              await rebalanceWorker?.cancel();
              rebalanceWorker = null;
              await exec.placeTaker(side, sz, CFG.takerSlippageBps);
              void alertOnce("ph:delta-hard", 600_000, `🚨 hard delta ${deltaPct.toFixed(2)}% → taker ${side} ${sz.toFixed(4)} MON`);
            } else {
              void alertOnce("ph:taker-cap", 3600_000, `⚠️ taker daily cap hit — maker-only rebalance`);
            }
          }
          if (!rebalanceWorker) rebalanceWorker = new MakerWorker(side, sz, exec);
          await rebalanceWorker.tick(book);
          if (deltaPct <= CFG.deltaSoftPct || rebalanceWorker.done) {
            await rebalanceWorker.cancel();
            rebalanceWorker = null;
            rebalanceRoute = null;
            transition(state, "HEDGED", `delta back to ${deltaPct.toFixed(2)}%`);
          }
          break;
        }

        case "PAUSED_FUNDING": {
          // AS never funding-pauses (it earns spread) — release immediately, e.g. after
          // a restart that loaded a churn-era paused snapshot.
          if (CFG.strategy === "avellaneda") {
            transition(state, "HEDGED", "AS resumes — quotes through funding");
            break;
          }
          if (deltaPct > CFG.deltaSoftPct) {
            transition(state, "REBALANCING", `delta ${deltaPct.toFixed(2)}% while paused`);
            break;
          }
          if (!funding.shouldPause()) {
            void alertOnce("ph:funding-resume", 3600_000, `▶️ churn resumed: funding ${funding.earnAprPct().toFixed(1)}% APR`);
            transition(state, "HEDGED", "funding recovered");
          }
          break;
        }

        case "UNWINDING": {
          if (unwindStartedAt === 0) unwindStartedAt = Date.now();
          await churner.abort();
          await asStrategy.flatten(exec);
          await hedgeWorker?.cancel();
          await rebalanceWorker?.cancel();
          hedgeWorker = rebalanceWorker = null;

          if (shortMon > 0) {
            if (!unwindWorker) unwindWorker = new MakerWorker("short-close", shortMon, exec);
            await unwindWorker.tick(book);
            // Maker didn't fill in time → pay taker to be flat.
            if (Date.now() - unwindStartedAt > 10 * 60_000 && !unwindWorker.done) {
              await unwindWorker.cancel();
              unwindWorker = null;
              await exec.placeTaker("short-close", shortMon, CFG.takerSlippageBps);
            }
            break;
          }

          if (state.spotMon > 0 && !unwindSpotDone) {
            const fill = await sellSpotMon(state.spotMon);
            if (fill) {
              unwindSpotDone = true;
              pnl.event("spot-sell", { ...fill, mode: MODE });
              const spotPnl = fill.usd - state.spotCostUsd;
              await closeEpochOnChain(state.epochId, fill.usd, fill.txHash, `perp-${fillLog.length}`);
              await sendTelegram(
                `📕 ZeroDrift unwound · spot PnL $${spotPnl.toFixed(2)} · fees $${(pnl.makerFeesUsd + pnl.takerFeesUsd).toFixed(2)} · funding $${pnl.fundingUsd.toFixed(2)} · volume $${pnl.perpVolumeUsd.toFixed(0)}`,
              );
              state.spotMon = 0;
              transition(state, "CLOSED", "unwind complete");
            }
            break;
          }
          if (state.spotMon === 0) transition(state, "CLOSED", "nothing to unwind");
          break;
        }

        case "CLOSED": {
          pnl.snapshot({ state: state.state, mode: MODE });
          console.log("hedge closed — exiting.");
          process.exit(0);
        }
      }

      // ── public status feed (served by the site's terminal card) ─────────
      // Two deltas, on purpose:
      //  • deltaPct  = RAW spot−short gap. Swings out to ~churnFraction during a
      //    churn cycle then snaps back — this is the visible heartbeat the gauge
      //    needle traces, and it's honest (the position really is momentarily
      //    un-hedged mid-cycle).
      //  • driftPct  = churn-ADJUSTED gap (subtract the clip we're committed to
      //    re-open, pendingMon; 0 when idle). This is TRUE hedge health — the same
      //    number the hard-delta guard judges — so the gauge can paint the churn
      //    swing green (healthy) instead of alarm-red, and only redden on a real
      //    breach.
      const driftPct =
        state.targetSizeMon > 0
          ? Math.abs(((deltaMon - churner.pendingMon()) / state.targetSizeMon) * 100)
          : 0;
      writeStatus({
        mode: MODE,
        strategy: CFG.strategy,
        state: state.state,
        marketName: market.name,
        mid,
        // AS quoting telemetry (0 while the churn strategy is active).
        asHalfSpreadBps: CFG.strategy === "avellaneda" ? Number(asStrategy.lastHalfBps.toFixed(2)) : 0,
        asSkewBps: CFG.strategy === "avellaneda" ? Number(asStrategy.lastSkewBps.toFixed(2)) : 0,
        deltaPct: Number(deltaPct.toFixed(3)),
        // Signed raw delta (+ = spot exceeds short, − = short exceeds spot) so the
        // gauge can rest at dead-center and swing out during a churn cycle.
        deltaSignedPct: Number((state.targetSizeMon > 0 ? (deltaMon / state.targetSizeMon) * 100 : 0).toFixed(3)),
        driftPct: Number(driftPct.toFixed(3)),
        churnFraction: CFG.churnFraction,
        spotMon: Number(state.spotMon.toFixed(2)),
        shortMon: Number(shortMon.toFixed(2)),
        roundTrips: churner.roundTrips,
        fillCount: pnl.fillCount,
        weekVolumeUsd: Number(pnl.weekVolume().toFixed(2)),
        makerFeesUsd: Number(pnl.makerFeesUsd.toFixed(4)),
        takerFeesUsd: Number(pnl.takerFeesUsd.toFixed(4)),
        fundingUsd: Number(pnl.fundingUsd.toFixed(4)),
        fundingAprPct: Number(funding.earnAprPct().toFixed(2)),
        fundingSignStatus: funding.signStatus,
        // Hedge-desk KPIs: boosted volume farmed + realized cost per $1k of it.
        churnIntensity,
        trendStrengthPct: Number(trend.strengthPct().toFixed(3)),
        trendPaused,
        boostedVolumeUsd: Number((pnl.perpVolumeUsd * (market.pointsBoostBps / 10_000)).toFixed(2)),
        netCostUsd: Number((pnl.makerFeesUsd + pnl.takerFeesUsd + pnl.gasUsd - pnl.fundingUsd).toFixed(4)),
        // Spread captured vs mid, and the net PnL that credits it (+ = profit).
        spreadCaptureUsd: Number(pnl.spreadCaptureUsd.toFixed(4)),
        netPnlUsd: Number(
          (pnl.spreadCaptureUsd + pnl.fundingUsd - pnl.makerFeesUsd - pnl.takerFeesUsd - pnl.gasUsd).toFixed(4),
        ),
        costPer1kBoostedUsd:
          pnl.perpVolumeUsd > 0
            ? Number(
                (
                  (Math.max(0, pnl.makerFeesUsd + pnl.takerFeesUsd + pnl.gasUsd - pnl.fundingUsd) /
                    (pnl.perpVolumeUsd * (market.pointsBoostBps / 10_000))) *
                  1000
                ).toFixed(4),
              )
            : 0,
        config: {
          leverageX: CFG.leverage / 100,
          churnMin: CFG.churnIntervalMs / 60_000,
          churnFraction: CFG.churnFraction,
          softPct: CFG.deltaSoftPct,
          hardPct: CFG.deltaHardPct,
          makerFeeBps: market.makerFeeMicros / 100,
          takerFeeBps: market.takerFeeMicros / 100,
          pointsBoostX: market.pointsBoostBps / 10_000,
        },
      });
      recordHistory(
        Date.now(),
        pnl.perpVolumeUsd,
        pnl.makerFeesUsd + pnl.takerFeesUsd,
        pnl.fundingUsd,
      );

      // ── periodic digest ──────────────────────────────────────────────────
      if (Date.now() - lastDigest > CFG.digestMs) {
        lastDigest = Date.now();
        const perpUPnl = pos.side === "short" ? (pos.entryPx - mid) * pos.sizeMon : 0;
        const spotUPnl = state.spotMon * mid - state.spotCostUsd;
        pnl.snapshot({ state: state.state, mode: MODE, mid, deltaPct, perpUPnl, spotUPnl });
        await sendTelegram(
          `📊 ZeroDrift ${MODE} digest\n` +
            `state=${state.state} mid=$${mid.toFixed(5)} delta=${deltaPct.toFixed(2)}%\n` +
            `short ${shortMon.toFixed(2)} MON / spot ${state.spotMon.toFixed(2)} MON\n` +
            `week volume $${pnl.weekVolume().toFixed(0)} · fills ${pnl.fillCount} · round-trips ${churner.roundTrips}\n` +
            `fees $${(pnl.makerFeesUsd + pnl.takerFeesUsd).toFixed(3)} · funding $${pnl.fundingUsd.toFixed(3)} APR ${funding.earnAprPct().toFixed(1)}%\n` +
            `uPnL spot $${spotUPnl.toFixed(2)} + perp $${perpUPnl.toFixed(2)} = $${(spotUPnl + perpUPnl).toFixed(2)}`,
        );
      }
    } catch (e) {
      console.error(`tick error: ${(e as Error).message}`);
    }
    await sleep(CFG.loopMs);
  }
}

main().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
