// config.ts — hedger configuration from env. Paper by default: live requires
// HEDGER_LIVE=true AND all three secrets (wallet key, Perpl API key, Ed25519 key).

import { envBool, envNum, envStr } from "../lib/config";

export type HedgerStrategy = "churn" | "avellaneda";
/** hedge = spot + short with delta guards (run.ts); mm = standalone two-sided
 * market making with no spot leg and target inventory 0 (run-mm.ts). */
export type HedgerMode = "hedge" | "mm";

export interface HedgerConfig {
  /** Active volume-farming strategy. churn = discrete round-trips; avellaneda = continuous MM. */
  strategy: HedgerStrategy;
  mode: HedgerMode;
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
  /** false = owner holds the spot leg; the bot never buys/sells spot MON. */
  spotManaged: boolean;
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
  // ── Standalone MM (mode=mm) knobs — inventory is signed, target is 0 ──────
  /** Quote size as a fraction of baseMon (= notionalUsd/mid). */
  mmClipFrac: number;
  /** Pull the growing side once |inventory| exceeds this fraction of baseMon. */
  mmInvBandFrac: number;
  /** Force a maker rebalance toward flat beyond this fraction of baseMon. */
  mmMaxInvFrac: number;
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
  /** Abort a churn cycle whose current leg hasn't completed after this long — the
   * delta guard then restores the hedge (observed live 2026-07-19: a re-open leg
   * chased a falling ask for 7h, holding half the position unhedged). */
  churnLegTimeoutMs: number;
  registryAddress: string;
  unwind: boolean;
  live: boolean;
  loopMs: number;
  digestMs: number;
  /** Ledger/state directory — MUST differ per bot so multiple strategies don't clobber. */
  dataDir: string;
}

// false ⇒ the owner already holds the spot MON in their own wallet: the bot NEVER
// buys/sells spot (no wallet key needed on the box) and only manages the perp short.
const SPOT_MANAGED = envBool("HEDGER_SPOT_MANAGED", true);

const LIVE =
  envBool("HEDGER_LIVE", false) &&
  !!process.env.PERPL_API_KEY &&
  !!process.env.PERPL_ED25519_PRIVKEY &&
  // The wallet key is only needed when the bot itself trades the spot leg (and,
  // optionally, for on-chain epoch receipts — registry no-ops without it).
  (!!process.env.HEDGER_PRIVATE_KEY || !SPOT_MANAGED);

function parseStrategy(): HedgerStrategy {
  return envStr("HEDGER_STRATEGY", "churn").toLowerCase() === "avellaneda" ? "avellaneda" : "churn";
}

export function parseMode(raw: string): HedgerMode {
  return raw.toLowerCase() === "mm" ? "mm" : "hedge";
}

const NOTIONAL_USD = envNum("HEDGER_NOTIONAL_USD", 100);

/** The taker budget is an emergency valve for the delta guard, so it has to scale with
 * the position: a flat $25 (tuned at $100 notional) cannot restore a $2000 hedge, and
 * cloud instances never set the env — they only get HEDGER_NOTIONAL_USD. */
const DEFAULT_DAILY_TAKER_USD = Math.max(25, NOTIONAL_USD * 0.25);

export const HEDGER_CONFIG: HedgerConfig = {
  strategy: parseStrategy(),
  mode: parseMode(envStr("HEDGER_MODE", "hedge")),
  market: envStr("HEDGER_MARKET", "MON"),
  notionalUsd: NOTIONAL_USD,
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
  spotManaged: SPOT_MANAGED,
  asGamma: envNum("HEDGER_AS_GAMMA", 120),
  asKappa: envNum("HEDGER_AS_KAPPA", 1500),
  asMinHalfBps: envNum("HEDGER_AS_MIN_HALF_BPS", 2),
  asMaxHalfBps: envNum("HEDGER_AS_MAX_HALF_BPS", 25),
  asMaxSkewBps: envNum("HEDGER_AS_MAX_SKEW_BPS", 8),
  asRepriceBps: envNum("HEDGER_AS_REPRICE_BPS", 1.5),
  // Clip MUST stay below (hard − band) so a single fill can't vault the inventory band
  // into the hard-delta guard. 0.15 was a footgun (one fill = 15% delta jump).
  asClipFrac: envNum("HEDGER_AS_CLIP_FRAC", 0.03),
  asInvBandFrac: envNum("HEDGER_AS_INV_BAND_FRAC", 0.02),
  mmClipFrac: envNum("HEDGER_MM_CLIP_FRAC", 0.03),
  // Around a target of 0 the band is breathing room, not hedge tolerance: wide enough
  // for a few one-sided fills (≈5 clips) before the growing side gets pulled.
  mmInvBandFrac: envNum("HEDGER_MM_INV_BAND_FRAC", 0.15),
  mmMaxInvFrac: envNum("HEDGER_MM_MAX_INV_FRAC", 0.5),
  deltaSoftPct: envNum("HEDGER_DELTA_SOFT_PCT", 1),
  deltaHardPct: envNum("HEDGER_DELTA_HARD_PCT", 3),
  fundingSign: envNum("HEDGER_FUNDING_SIGN", 1) < 0 ? -1 : 1,
  fundingPauseApr: envNum("HEDGER_FUNDING_PAUSE_APR", 10),
  fundingResumeApr: envNum("HEDGER_FUNDING_RESUME_APR", 5),
  maxDailyTakerUsd: envNum("HEDGER_MAX_DAILY_TAKER_USD", DEFAULT_DAILY_TAKER_USD),
  takerSlippageBps: envNum("HEDGER_TAKER_SLIPPAGE_BPS", 50),
  repriceMs: envNum("HEDGER_REPRICE_MS", 60_000),
  churnLegTimeoutMs: envNum("HEDGER_CHURN_LEG_TIMEOUT_MS", 10 * 60_000),
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
