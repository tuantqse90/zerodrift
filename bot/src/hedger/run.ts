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
import { HEDGER_CONFIG as CFG } from "./config";
import { FundingMonitor } from "./funding";
import { MakerWorker } from "./maker";
import { PnlLedger } from "./pnl";
import { closeEpochOnChain, openEpochOnChain } from "./registry";
import { buySpotMon, sellSpotMon, spotPriceUsd } from "./spot";
import { loadState, saveState, transition } from "./state";
import { pushEvent, writeStatus } from "./status";

const MODE = CFG.live ? "LIVE" : "PAPER";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  console.log(
    `zerodrift hedger starting · market=${CFG.market} notional=$${CFG.notionalUsd} ` +
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

  // One fill stream feeds everything: ledger, workers, churner.
  let hedgeWorker: MakerWorker | null = null;
  let rebalanceWorker: MakerWorker | null = null;
  let unwindWorker: MakerWorker | null = null;
  const fillLog: FillEvent[] = [];
  exec.onFill((f) => {
    pnl.recordFill(f, CFG.live ? "live" : "paper");
    fillLog.push(f);
    hedgeWorker?.handleFill(f);
    rebalanceWorker?.handleFill(f);
    unwindWorker?.handleFill(f);
    churner.handleFill(f);
    console.log(
      `[${new Date().toISOString()}] fill ${f.maker ? "maker" : "taker"} ${f.sz.toFixed(4)} @ ${f.px} ` +
        `fee=$${f.feeUsd.toFixed(4)} (${f.intentId})`,
    );
    pushEvent("fill", `fill ${f.maker ? "maker" : "taker"} ${f.sz.toFixed(4)} @ ${f.px} fee=$${f.feeUsd.toFixed(4)}`);
  });

  await announceOnlineOnce(
    `🟢 ZeroDrift hedger online (${MODE}) · ${market.name} $${CFG.notionalUsd} target · churn ${CFG.churnIntervalMs / 60000}m`,
  );

  if (CFG.unwind && state.state !== "CLOSED") transition(state, "UNWINDING", "HEDGER_UNWIND=true at boot");

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
          if (churner.due() && shortMon > 0) {
            churner.start(shortMon);
            transition(state, "CHURNING", `round-trip #${churner.roundTrips + 1}`);
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
          // delta > 0: spot exceeds short → grow the short. delta < 0: shrink it.
          const side = deltaMon > 0 ? "short-open" : "short-close";
          const sz = Math.abs(deltaMon);
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
            transition(state, "HEDGED", `delta back to ${deltaPct.toFixed(2)}%`);
          }
          break;
        }

        case "PAUSED_FUNDING": {
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
      writeStatus({
        mode: MODE,
        state: state.state,
        marketName: market.name,
        mid,
        deltaPct: Number(deltaPct.toFixed(3)),
        spotMon: Number(state.spotMon.toFixed(2)),
        shortMon: Number(shortMon.toFixed(2)),
        roundTrips: churner.roundTrips,
        fillCount: pnl.fillCount,
        weekVolumeUsd: Number(pnl.weekVolume().toFixed(2)),
        makerFeesUsd: Number(pnl.makerFeesUsd.toFixed(4)),
        takerFeesUsd: Number(pnl.takerFeesUsd.toFixed(4)),
        fundingUsd: Number(pnl.fundingUsd.toFixed(4)),
        fundingAprPct: Number(funding.earnAprPct().toFixed(2)),
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
