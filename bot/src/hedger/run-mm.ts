// run-mm.ts — standalone two-sided market-making entrypoint (HEDGER_MODE=mm).
//
// Quote bid+ask around an Avellaneda reservation price with target inventory ZERO on
// any Perpl market. No spot leg, no churn, no registry epochs — and deliberately NOT
// the run.ts FSM: that loop's guards all measure spot-vs-short delta, which has no
// meaning here, and threading a mode flag through 15 coupled branches of live-money
// code is how hedge instances get broken. This loop shares only the side-agnostic
// parts: executors, feed, quote math, MakerWorker, PnL ledger, status writer.
//
// FSM: QUOTING ⇄ REBALANCING → UNWINDING → CLOSED
// Inventory is SIGNED throughout: + = net short, − = net long, 0 = flat.
//
// PAPER by default; live needs HEDGER_LIVE=true + Perpl keys. A wallet key is never
// needed (there is no spot leg to trade), and can never be used (spot.ts is not
// imported here at all).

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { fetchPerplMarket, PerplFeed, type PerplFundingEvent } from "../lib/perpl";
import {
  hexToBytes,
  LivePerplExecutor,
  PaperPerplExecutor,
  type PerplExecutor,
  type PerpPosition,
} from "../lib/perpl-trade";
import { alertOnce, announceOnlineOnce, sendTelegram } from "../lib/telegram";
import { envBool, PERPL_CHAIN_ID } from "../lib/config";
import { HEDGER_CONFIG as CFG } from "./config";
import { FundingMonitor } from "./funding";
import { MakerWorker } from "./maker";
import { PnlLedger } from "./pnl";
import { pushEvent, recordHistory, writeStatus } from "./status";
import { TrendMonitor } from "./trend";
import { MmQuoter } from "./strategies/mm-quoter";

// Live arming for MM: exchange keys only. run.ts additionally requires a wallet key
// unless SPOT_MANAGED=false; here there is no spot leg, so that clause never applies.
const LIVE =
  envBool("HEDGER_LIVE", false) && !!process.env.PERPL_API_KEY && !!process.env.PERPL_ED25519_PRIVKEY;
const MODE = LIVE ? "LIVE" : "PAPER";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type MmState = "QUOTING" | "REBALANCING" | "UNWINDING" | "CLOSED";
const STATE_FILE = `${CFG.dataDir}mm-state.json`;

function loadMmState(): MmState {
  try {
    if (existsSync(STATE_FILE)) {
      const s = JSON.parse(readFileSync(STATE_FILE, "utf8")).state;
      if (s === "QUOTING" || s === "REBALANCING" || s === "UNWINDING" || s === "CLOSED") return s;
    }
  } catch {
    /* fresh */
  }
  return "QUOTING";
}

function saveMmState(state: MmState): void {
  try {
    mkdirSync(CFG.dataDir, { recursive: true });
    const tmp = `${STATE_FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify({ state, updatedAt: new Date().toISOString() }));
    renameSync(tmp, STATE_FILE);
  } catch {
    /* best-effort */
  }
}

/** Signed inventory in MON from an executor position: + short, − long. */
export function signedInvMon(pos: PerpPosition): number {
  return pos.side === "short" ? pos.sizeMon : pos.side === "long" ? -pos.sizeMon : 0;
}

// ── trend gate ────────────────────────────────────────────────────────────────
// 41h live on MON proved what the review predicted: two-sided quotes in a
// persistent trend sell low and buy high on repeat (avg sell 12.4bps BELOW avg
// buy across a +5.3% move, −$7.83 true PnL). The churn engine sits trends out via
// TrendMonitor; the MM loop now does the same — both sides pulled, nothing clever.

export type QuotingPlan = "rebalance" | "hold-paused" | "quote";

/** Pure per-tick decision for the QUOTING state — exported for direct testing. */
export function quotingPlan(
  trendPaused: boolean,
  invMon: number,
  baseMon: number,
  k: { invBandFrac: number; maxInvFrac: number },
): QuotingPlan {
  if (baseMon > 0 && Math.abs(invMon) > baseMon * k.maxInvFrac) return "rebalance";
  // A trend is when stranded inventory bleeds fastest: while paused, rebalance as
  // soon as the ordinary band is breached instead of waiting for the hard cap.
  if (trendPaused && baseMon > 0 && Math.abs(invMon) > baseMon * k.invBandFrac) return "rebalance";
  if (trendPaused) return "hold-paused";
  return "quote";
}

/** One-shot flatten latch around the pause: quotes are pulled ONCE on entry, and
 * the resume callback fires ONCE on exit. Exported for direct testing. */
export class TrendGate {
  private pulled = false;

  async apply(
    plan: QuotingPlan,
    quoter: { flatten(exec: PerplExecutor): Promise<void> },
    exec: PerplExecutor,
    onPause?: () => void,
    onResume?: () => void,
  ): Promise<"skip" | "quote" | "rebalance"> {
    if (plan === "rebalance") {
      this.pulled = false; // re-entry to QUOTING re-evaluates from scratch
      return "rebalance";
    }
    if (plan === "hold-paused") {
      if (!this.pulled) {
        await quoter.flatten(exec);
        this.pulled = true;
        onPause?.();
      }
      return "skip";
    }
    if (this.pulled) {
      this.pulled = false;
      onResume?.();
    }
    return "quote";
  }
}

async function main(): Promise<void> {
  if (CFG.mode !== "mm") {
    console.error("run-mm.ts requires HEDGER_MODE=mm (this entrypoint never runs the hedge FSM)");
    process.exit(1);
  }

  console.log(
    `zerodrift mm starting · market=${CFG.market} notional=$${CFG.notionalUsd} lv=${CFG.leverage / 100}x ` +
      `clip=${CFG.mmClipFrac} band=${CFG.mmInvBandFrac} maxInv=${CFG.mmMaxInvFrac} mode=${MODE} chain=${PERPL_CHAIN_ID}`,
  );

  const market = await fetchPerplMarket(CFG.market);
  console.log(
    `market ${market.id} "${market.name}" pd=${market.priceDecimals} sd=${market.sizeDecimals} ` +
      `maker=${market.makerFeeMicros / 100}bps taker=${market.takerFeeMicros / 100}bps ` +
      `ttl=${market.orderTtlBlocks}blk boost=${market.pointsBoostBps}bps`,
  );

  let state: MmState = loadMmState();
  // A durably-CLOSED book is terminal, exactly like the hedge engine: exit before
  // alerting so a restart policy can't loop a finished unwind.
  if (state === "CLOSED" && !CFG.unwind) {
    console.log("mm state CLOSED — nothing to do, exiting");
    process.exit(0);
  }
  if (CFG.unwind && state !== "CLOSED") state = "UNWINDING";
  // Paper inventory lives in executor memory only — after a restart the book IS flat,
  // so any resumed mid-flight state collapses back to QUOTING. CLOSED stays terminal:
  // resurrecting it here would undo the exit guard above whenever HEDGER_UNWIND=true.
  if (!LIVE && state !== "UNWINDING" && state !== "CLOSED") state = "QUOTING";
  saveMmState(state);

  const pnl = new PnlLedger();
  const funding = new FundingMonitor(market);
  const trend = new TrendMonitor();
  const trendGate = new TrendGate();
  const quoter = new MmQuoter({
    gamma: CFG.asGamma,
    kappa: CFG.asKappa,
    minHalfBps: CFG.asMinHalfBps,
    maxHalfBps: CFG.asMaxHalfBps,
    maxSkewBps: CFG.asMaxSkewBps,
    repriceBps: CFG.asRepriceBps,
    clipFrac: CFG.mmClipFrac,
    invBandFrac: CFG.mmInvBandFrac,
    depthCapPct: CFG.churnDepthCapPct,
  });

  const feed = new PerplFeed(market, (ev: PerplFundingEvent) => {
    if (ev.marketId !== market.id) return;
    funding.update(ev);
    // Signed accrual: a short (+inv) earns when rate>0 under fundingSign=+1; a long
    // (−inv) pays the same amount. accrualUsd is linear in position size, so passing
    // the signed inventory gives the correct sign for both.
    const inv = signedInvMon(exec.position());
    if (inv !== 0) {
      const book = feed.getBook();
      const px = book ? (book.bids[0].px + book.asks[0].px) / 2 : exec.position().entryPx;
      pnl.recordFunding(funding.accrualUsd(ev, inv, px), ev.rateMicros);
    }
  });
  feed.start();

  const exec: PerplExecutor = LIVE
    ? new LivePerplExecutor(
        market,
        {
          apiKey: process.env.PERPL_API_KEY!,
          edPriv: hexToBytes(process.env.PERPL_ED25519_PRIVKEY!),
          chainId: PERPL_CHAIN_ID,
        },
        Number(process.env.PERPL_ACCOUNT_ID) || 0,
        CFG.leverage,
      )
    : new PaperPerplExecutor(market, feed);

  exec.onFundingCredit((usd) => {
    // Sign auto-verification assumes a SHORT earns under the configured convention —
    // a net-long book legitimately receives the opposite sign, which would flag a
    // false "inverted" and fire the loud alarm. Only verify while net short.
    if (signedInvMon(exec.position()) > 0) funding.observeCredit(usd);
    pushEvent("info", `funding settlement ${usd >= 0 ? "+" : ""}$${usd.toFixed(4)} · sign ${funding.signStatus}`);
  });

  // Declared BEFORE the fill callback is wired: a live fill can arrive during the
  // `await exec.start()` below, and a TDZ read inside the callback would crash the loop.
  const flatten: { w: MakerWorker | null } = { w: null };
  let takerSpentToday = 0;
  let takerDay = new Date().toISOString().slice(0, 10);

  exec.onFill((f) => {
    const fb = feed.getBook();
    const fillMid = fb ? (fb.bids[0].px + fb.asks[0].px) / 2 : undefined;
    pnl.recordFill(f, LIVE ? "live" : "paper", fillMid);
    flatten.w?.handleFill(f);
    // The taker budget is charged on ACTUAL fills, never on placement: a 0-fill IOC
    // must not burn the day's budget (review 2026-07-20 — one empty IOC locked taker
    // flattening out for the rest of the day).
    if (!f.maker) takerSpentToday += f.sz * f.px;
    // Close the stale-position window: live position() lags fills (mt:25 vs mt:27),
    // so a resting quote sized for the OLD inventory could fill against the new one.
    // Pull both immediately; the next tick re-derives sides/sizes from fresh state.
    void quoter.flatten(exec).catch(() => {});
    const dir = f.side ?? "?";
    console.log(
      `[${new Date().toISOString()}] fill ${f.maker ? "maker" : "taker"} ${dir} ${f.sz.toFixed(4)} @ ${f.px} ` +
        `fee=$${f.feeUsd.toFixed(4)} (${f.intentId})`,
    );
    pushEvent("fill", `fill ${f.maker ? "maker" : "taker"} ${dir} ${f.sz.toFixed(4)} @ ${f.px} fee=$${f.feeUsd.toFixed(4)}`);
  });

  // Live: opens the trading WS and signs in. Paper: starts the fill-simulation timer.
  // Forgetting this is silent — quotes "rest" forever and nothing ever fills.
  await exec.start();

  // Paper truth-anchor: spreadCapture books |fill−mid| as edge even when the fill was
  // adverse selection (mid then moves through us). The simulator's balance + mark-out
  // is the honest paper PnL — publish both and let them disagree in public.
  const paperBal0 = !LIVE ? (exec.account()?.balanceUsd ?? null) : null;

  await announceOnlineOnce(
    `🟢 ZeroDrift MM online (${MODE}) · ${market.name} $${CFG.notionalUsd} base · two-sided, target inv 0`,
  );

  const transition = (to: MmState, why: string): void => {
    console.log(`[${new Date().toISOString()}] mm ${state} → ${to} (${why})`);
    pushEvent("state", `${state} → ${to} · ${why}`);
    state = to;
    saveMmState(state);
    void alertOnce(`mm:state:${to}`, 600_000, `🌀 ZeroDrift MM: → ${to}\n${why}`);
  };

  let lastBookAt = Date.now();
  let lastReadyAt = Date.now();
  let bootInvLogged = false;
  let flattenStartedAt = 0;
  let lastDigest = Date.now();

  /** UTC-day rollover, callable on its own: the reset must run even on ticks where
   * nothing is affordable, or a burnt budget never comes back after midnight. */
  const rollTakerDay = (): void => {
    const day = new Date().toISOString().slice(0, 10);
    if (day !== takerDay) {
      takerDay = day;
      takerSpentToday = 0;
    }
  };

  /** Maker-first flatten toward zero, shared by REBALANCING and UNWINDING. The 10-min
   * timeout taker is BUDGETED here (unlike the hedge unwind): an MM book is not an
   * emergency hedge repair — running out of budget just means staying maker-only. */
  const flattenTick = async (invMon: number, label: string): Promise<void> => {
    const book = feed.getBook();
    if (!book || invMon === 0) return;
    const lot = 1 / 10 ** market.sizeDecimals;
    const side = invMon > 0 ? ("short-close" as const) : ("long-close" as const);
    const sz = Math.floor(Math.abs(invMon) / lot) * lot;
    if (sz < lot) return; // sub-lot dust — the state exit condition will treat it as flat
    if (flattenStartedAt === 0) flattenStartedAt = Date.now();
    // Recreate only on a side flip or a MATERIAL target drift. The worker's own fills
    // shrink `remaining` by themselves — recreating on every partial fill cancels a
    // resting order that was doing its job and pays the re-queue for nothing.
    const stale =
      !flatten.w ||
      flatten.w.side !== side ||
      flatten.w.done ||
      Math.abs(flatten.w.remaining - sz) > Math.max(lot, sz * 0.1);
    if (stale) {
      if (flatten.w) await flatten.w.cancel();
      flatten.w = new MakerWorker(side, sz, exec);
    }
    await flatten.w!.tick(book);
    if (Date.now() - flattenStartedAt > 10 * 60_000 && !flatten.w!.done) {
      const mid = (book.bids[0].px + book.asks[0].px) / 2;
      rollTakerDay(); // must run even when nothing is affordable, or midnight never resets a burnt budget
      // Chunked escape sized from the worker's FILL-ADJUSTED remaining, not the raw
      // position read at tick start: a partial fill in flight (mt:25 seen, mt:27
      // pending) would otherwise over-size the IOC into a close-beyond-position,
      // whose venue semantics are exactly what this engine promises never to test.
      const rem = Math.min(sz, flatten.w!.remaining);
      const budgetLeft = Math.max(0, CFG.maxDailyTakerUsd - takerSpentToday);
      const affordable = Math.floor(Math.min(rem, budgetLeft / mid) / lot) * lot;
      if (affordable >= lot) {
        await flatten.w!.cancel();
        flatten.w = null;
        // Budget is charged in onFill on actual taker fills — never on placement.
        await exec.placeTaker(side, affordable, CFG.takerSlippageBps);
        pushEvent("info", `${label}: taker flatten ${affordable.toFixed(4)}/${sz.toFixed(4)} after 10min unfilled`);
      } else {
        void alertOnce("mm:taker-budget", 3600_000, `⚠️ ZeroDrift MM: ${label} wants a taker flatten but the daily budget is spent — staying maker-only`);
      }
      flattenStartedAt = Date.now(); // position-update lag must not re-fire every tick
    }
  };

  for (;;) {
    try {
      const book = feed.getBook();

      if (book) lastBookAt = Date.now();
      else if (Date.now() - lastBookAt > 120_000) {
        void alertOnce("mm:ws-stale", 600_000, "⚠️ ZeroDrift MM: order book stale >2min — restarting feed");
        feed.stop();
        await sleep(1000);
        feed.start();
        lastBookAt = Date.now();
      }

      if (exec.isReady()) lastReadyAt = Date.now();
      else if (Date.now() - lastReadyAt > 120_000) {
        void alertOnce(
          "mm:exec-not-ready",
          600_000,
          `🚨 ZeroDrift MM: executor not ready for ${Math.round((Date.now() - lastReadyAt) / 60_000)}min — ` +
            `sign-in likely rejected. Book is UNMANAGED.`,
        );
      }

      if (!book || !exec.isReady()) {
        await sleep(CFG.loopMs);
        continue;
      }

      const mid = (book.bids[0].px + book.asks[0].px) / 2;
      trend.update(mid, Date.now());
      // Evaluated exactly once per tick (the monitor's hysteresis is stateful) so the
      // status feed and the QUOTING gate always agree on the same verdict.
      const trendPaused = trend.shouldPause(Date.now());
      const invMon = signedInvMon(exec.position());
      const baseMon = CFG.notionalUsd / mid;

      // A pre-existing position on this account (e.g. a hedge short left by a stopped
      // hedge instance) is inventory to the MM and WILL be mean-reverted toward flat.
      // Say so once, loudly, instead of quietly dismantling what the user built.
      if (!bootInvLogged && exec.isReady()) {
        bootInvLogged = true;
        if (Math.abs(invMon) > 0) {
          const msg = `MM found a pre-existing position: ${invMon.toFixed(2)} MON (signed, + = short). It will be reduced toward flat.`;
          console.log(`[${new Date().toISOString()}] ${msg}`);
          pushEvent("info", msg);
          void alertOnce("mm:boot-inventory", 3600_000, `⚠️ ZeroDrift MM: ${msg}`);
        }
      }

      // Margin guard (live): locked collateral crowding out equity → get flat and stop.
      const acct = exec.account();
      if (LIVE && acct && acct.balanceUsd > 0 && acct.lockedUsd / acct.balanceUsd > 0.9 && state !== "UNWINDING" && state !== "CLOSED") {
        await quoter.flatten(exec);
        transition("UNWINDING", `margin guard: locked ${acct.lockedUsd}/${acct.balanceUsd}`);
      }

      switch (state) {
        case "QUOTING": {
          const plan = quotingPlan(trendPaused, invMon, baseMon, {
            invBandFrac: CFG.mmInvBandFrac,
            maxInvFrac: CFG.mmMaxInvFrac,
          });
          const action = await trendGate.apply(
            plan,
            quoter,
            exec,
            () => {
              const msg = `trend pause: |move| ${trend.strengthPct().toFixed(2)}% over ${CFG.trendWindowMs / 1000}s — both quotes pulled`;
              console.log(`[${new Date().toISOString()}] ${msg}`);
              pushEvent("state", msg);
            },
            () => {
              const msg = `trend resume: |move| ${trend.strengthPct().toFixed(2)}% — quoting again`;
              console.log(`[${new Date().toISOString()}] ${msg}`);
              pushEvent("state", msg);
            },
          );
          if (action === "rebalance") {
            await quoter.flatten(exec);
            flattenStartedAt = 0;
            transition(
              "REBALANCING",
              trendPaused && Math.abs(invMon) <= baseMon * CFG.mmMaxInvFrac
                ? `inventory ${invMon.toFixed(2)} MON stranded against a trend (band breach while paused)`
                : `inventory ${invMon.toFixed(2)} MON beyond ±${(CFG.mmMaxInvFrac * 100).toFixed(0)}% of base`,
            );
            break;
          }
          if (action === "quote")
            await quoter.tick({ book, mid, invMon, baseMon, volFrac: trend.realizedVolFrac(), exec, market });
          break;
        }

        case "REBALANCING": {
          if (Math.abs(invMon) <= baseMon * CFG.mmInvBandFrac) {
            if (flatten.w) await flatten.w.cancel();
            flatten.w = null;
            flattenStartedAt = 0;
            transition("QUOTING", `inventory back inside ±${(CFG.mmInvBandFrac * 100).toFixed(0)}% band`);
            break;
          }
          await flattenTick(invMon, "rebalance");
          break;
        }

        case "UNWINDING": {
          if (Math.abs(invMon) < Math.max(baseMon * 1e-6, 1 / 10 ** market.sizeDecimals)) {
            if (flatten.w) await flatten.w.cancel();
            flatten.w = null;
            await quoter.flatten(exec);
            await exec.cancelAll();
            transition("CLOSED", "book flat");
            break;
          }
          await flattenTick(invMon, "unwind");
          break;
        }

        case "CLOSED": {
          pnl.snapshot({ reason: "mm closed", invMon });
          await sendTelegram(`⚪ ZeroDrift MM closed · ${market.name} · net $${(pnl.spreadCaptureUsd + pnl.fundingUsd - pnl.makerFeesUsd - pnl.takerFeesUsd).toFixed(4)}`);
          process.exit(0);
        }
      }

      const invPct = baseMon > 0 ? (invMon / baseMon) * 100 : 0;
      const posNow = exec.position();
      const uPnlUsd =
        posNow.side === "short"
          ? (posNow.entryPx - mid) * posNow.sizeMon
          : posNow.side === "long"
            ? (mid - posNow.entryPx) * posNow.sizeMon
            : 0;
      // Paper-only honest PnL: realized (balance delta, incl. fees) + mark-to-mid.
      const equityPnlUsd =
        paperBal0 != null ? Number((((exec.account()?.balanceUsd ?? paperBal0) - paperBal0) + uPnlUsd).toFixed(4)) : null;
      writeStatus({
        mode: MODE,
        strategy: "mm",
        state,
        marketName: market.name,
        mid,
        asHalfSpreadBps: Number(quoter.lastHalfBps.toFixed(2)),
        asSkewBps: Number(quoter.lastSkewBps.toFixed(2)),
        // Inventory wears the delta-family fields so the existing terminal renders
        // something truthful: |inv| as drift, signed inv (− = net long) as the needle.
        deltaPct: Number(Math.abs(invPct).toFixed(3)),
        deltaSignedPct: Number((-invPct).toFixed(3)),
        driftPct: Number(Math.abs(invPct).toFixed(3)),
        churnFraction: CFG.mmClipFrac,
        spotMon: 0,
        shortMon: Number(Math.max(invMon, 0).toFixed(2)),
        invMon: Number(invMon.toFixed(4)),
        baseMon: Number(baseMon.toFixed(2)),
        roundTrips: 0,
        fillCount: pnl.fillCount,
        weekVolumeUsd: Number(pnl.weekVolume().toFixed(2)),
        makerFeesUsd: Number(pnl.makerFeesUsd.toFixed(4)),
        takerFeesUsd: Number(pnl.takerFeesUsd.toFixed(4)),
        fundingUsd: Number(pnl.fundingUsd.toFixed(4)),
        fundingAprPct: Number(funding.earnAprPct().toFixed(2)),
        fundingSignStatus: funding.signStatus,
        churnIntensity: trendPaused && state === "QUOTING" ? "trend-paused" : quoter.intensity,
        trendStrengthPct: Number(trend.strengthPct().toFixed(3)),
        trendPaused,
        boostedVolumeUsd: Number((pnl.perpVolumeUsd * (market.pointsBoostBps / 10_000)).toFixed(2)),
        netCostUsd: Number((pnl.makerFeesUsd + pnl.takerFeesUsd - pnl.fundingUsd).toFixed(4)),
        spreadCaptureUsd: Number(pnl.spreadCaptureUsd.toFixed(4)),
        netPnlUsd: Number(
          (pnl.spreadCaptureUsd + pnl.fundingUsd - pnl.makerFeesUsd - pnl.takerFeesUsd).toFixed(4),
        ),
        // Adverse-selection-honest paper PnL (null in live): realized + mark-to-mid.
        // When this and netPnlUsd disagree, believe this one.
        equityPnlUsd,
        uPnlUsd: Number(uPnlUsd.toFixed(4)),
        costPer1kBoostedUsd: 0,
        config: {
          leverageX: CFG.leverage / 100,
          churnMin: 0,
          churnFraction: CFG.mmClipFrac,
          softPct: CFG.mmInvBandFrac * 100,
          hardPct: CFG.mmMaxInvFrac * 100,
          makerFeeBps: market.makerFeeMicros / 100,
          takerFeeBps: market.takerFeeMicros / 100,
          pointsBoostX: market.pointsBoostBps / 10_000,
        },
      });
      recordHistory(Date.now(), pnl.weekVolume(), pnl.makerFeesUsd + pnl.takerFeesUsd, pnl.fundingUsd);

      if (Date.now() - lastDigest > CFG.digestMs) {
        lastDigest = Date.now();
        pnl.snapshot({ state, invMon, baseMon, uPnlUsd: Number(uPnlUsd.toFixed(4)), equityPnlUsd });
      }
    } catch (e) {
      console.error(`[${new Date().toISOString()}] mm tick error:`, e);
      void alertOnce("mm:tick-error", 600_000, `⚠️ ZeroDrift MM tick error: ${String(e).slice(0, 200)}`);
    }
    await sleep(CFG.loopMs);
  }
}

// Guarded so tests can import signedInvMon without booting an engine.
if (import.meta.main) {
  main().catch((e) => {
    console.error("fatal:", e);
    process.exit(1);
  });
}
