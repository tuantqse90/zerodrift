// config.ts — hedger configuration from env. Paper by default: live requires
// HEDGER_LIVE=true AND all three secrets (wallet key, Perpl API key, Ed25519 key).

import { envBool, envNum, envStr } from "../lib/config";

export type HedgerStrategy = "churn" | "avellaneda";

export interface HedgerConfig {
  /** Active volume-farming strategy. churn = discrete round-trips; avellaneda = continuous MM. */
  strategy: HedgerStrategy;
  market: string;
  notionalUsd: number;
  /** Leverage in hundredths (200 = 2x). */
  leverage: number;
  churnIntervalMs: number;
  churnFraction: number;
  /** Adaptive churn: hard cap on the per-cycle clip as a fraction of the short. */
  churnMaxFraction: number;
  /** Adaptive churn: floor on the interval when funding lets us churn aggressively. */
  churnMinIntervalMs: number;
  /** Funding APR (earned by shorts) above which churn goes aggressive. */
  fundingBoostApr: number;
  /** Clip is capped to this fraction of top-of-book depth so it fills fast (throughput). */
  churnDepthCapPct: number;
  /** Skip starting a churn within this window before funding settlement (keep full short). */
  fundingSettleGuardSec: number;
  /** Trend filter: lookback window for the mid-price move that gates churn. */
  trendWindowMs: number;
  /** Pause churn when |mid move| over the window exceeds this % (adverse-selection guard). */
  trendPausePct: number;
  /** Resume churn once the move falls back below this % (hysteresis, < pause). */
  trendResumePct: number;
  /** Probability a soft-band delta correction is trued up on the SPOT leg instead of the perp. */
  spotRebalanceProb: number;
  // ── Avellaneda-Stoikov strategy knobs ─────────────────────────────────────
  asGamma: number;
  asKappa: number;
  asMinHalfBps: number;
  asMaxHalfBps: number;
  asMaxSkewBps: number;
  /** Re-quote a side when the target price drifts more than this (bps). */
  asRepriceBps: number;
  /** Clip size as a fraction of the hedge target (capped by book depth). */
  asClipFrac: number;
  /** Pull a quote side once the short strays this fraction from target (hard inventory band). */
  asInvBandFrac: number;
  deltaSoftPct: number;
  deltaHardPct: number;
  /** +1: rate>0 ⇒ longs pay shorts (we earn on our short). Flip to -1 if proven inverted. */
  fundingSign: 1 | -1;
  fundingPauseApr: number;
  fundingResumeApr: number;
  maxDailyTakerUsd: number;
  takerSlippageBps: number;
  /** Cancel+re-place a maker order at the new best price after this long unfilled. */
  repriceMs: number;
  registryAddress: string;
  unwind: boolean;
  live: boolean;
  loopMs: number;
  digestMs: number;
  /** Ledger/state directory — MUST differ per bot so multiple strategies don't clobber. */
  dataDir: string;
}

const LIVE =
  envBool("HEDGER_LIVE", false) &&
  !!process.env.HEDGER_PRIVATE_KEY &&
  !!process.env.PERPL_API_KEY &&
  !!process.env.PERPL_ED25519_PRIVKEY;

function parseStrategy(): HedgerStrategy {
  return envStr("HEDGER_STRATEGY", "churn").toLowerCase() === "avellaneda" ? "avellaneda" : "churn";
}

export const HEDGER_CONFIG: HedgerConfig = {
  strategy: parseStrategy(),
  market: envStr("HEDGER_MARKET", "MON"),
  notionalUsd: envNum("HEDGER_NOTIONAL_USD", 100),
  leverage: envNum("HEDGER_LEVERAGE", 200),
  churnIntervalMs: envNum("HEDGER_CHURN_INTERVAL_MS", 900_000),
  churnFraction: envNum("HEDGER_CHURN_FRACTION", 0.25),
  churnMaxFraction: envNum("HEDGER_CHURN_MAX_FRACTION", 0.5),
  churnMinIntervalMs: envNum("HEDGER_CHURN_MIN_INTERVAL_MS", 300_000),
  fundingBoostApr: envNum("HEDGER_FUNDING_BOOST_APR", 10),
  churnDepthCapPct: envNum("HEDGER_CHURN_DEPTH_CAP_PCT", 0.5),
  fundingSettleGuardSec: envNum("HEDGER_FUNDING_SETTLE_GUARD_SEC", 120),
  trendWindowMs: envNum("HEDGER_TREND_WINDOW_MS", 120_000),
  trendPausePct: envNum("HEDGER_TREND_PAUSE_PCT", 1.0),
  trendResumePct: envNum("HEDGER_TREND_RESUME_PCT", 0.4),
  spotRebalanceProb: envNum("HEDGER_SPOT_REBALANCE_PROB", 0.35),
  asGamma: envNum("HEDGER_AS_GAMMA", 120),
  asKappa: envNum("HEDGER_AS_KAPPA", 1500),
  asMinHalfBps: envNum("HEDGER_AS_MIN_HALF_BPS", 2),
  asMaxHalfBps: envNum("HEDGER_AS_MAX_HALF_BPS", 25),
  asMaxSkewBps: envNum("HEDGER_AS_MAX_SKEW_BPS", 8),
  asRepriceBps: envNum("HEDGER_AS_REPRICE_BPS", 1.5),
  asClipFrac: envNum("HEDGER_AS_CLIP_FRAC", 0.15),
  asInvBandFrac: envNum("HEDGER_AS_INV_BAND_FRAC", 0.03),
  deltaSoftPct: envNum("HEDGER_DELTA_SOFT_PCT", 1),
  deltaHardPct: envNum("HEDGER_DELTA_HARD_PCT", 3),
  fundingSign: envNum("HEDGER_FUNDING_SIGN", 1) < 0 ? -1 : 1,
  fundingPauseApr: envNum("HEDGER_FUNDING_PAUSE_APR", 10),
  fundingResumeApr: envNum("HEDGER_FUNDING_RESUME_APR", 5),
  maxDailyTakerUsd: envNum("HEDGER_MAX_DAILY_TAKER_USD", 25),
  takerSlippageBps: envNum("HEDGER_TAKER_SLIPPAGE_BPS", 50),
  repriceMs: envNum("HEDGER_REPRICE_MS", 60_000),
  registryAddress: envStr("HEDGER_REGISTRY_ADDRESS", ""),
  unwind: envBool("HEDGER_UNWIND", false),
  live: LIVE,
  loopMs: envNum("HEDGER_LOOP_MS", 5_000),
  digestMs: envNum("HEDGER_DIGEST_MS", 6 * 3600_000),
  dataDir: (() => {
    const d = envStr("HEDGER_DATA_DIR", new URL("../../data/", import.meta.url).pathname);
    return d.endsWith("/") ? d : `${d}/`;
  })(),
};
