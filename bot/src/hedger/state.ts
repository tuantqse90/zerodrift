// state.ts — hedger finite-state machine with a durable snapshot so a restart
// resumes where it left off (the perp position itself lives on Perpl; the spot
// cost basis and epoch id only exist here).

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { alertOnce } from "../lib/telegram";
import { pushEvent } from "./status";

export type HedgerState =
  | "INIT"
  | "SPOT_FILLED"
  | "HEDGED"
  | "CHURNING"
  | "REBALANCING"
  | "PAUSED_FUNDING"
  | "UNWINDING"
  | "CLOSED";

export interface DurableState {
  state: HedgerState;
  /** Spot leg inventory attributed to the hedge (human MON). */
  spotMon: number;
  /** USD paid for the spot leg (cost basis). */
  spotCostUsd: number;
  spotTxHash: string;
  /** Target perp short size (human MON). */
  targetSizeMon: number;
  /** On-chain HedgeRegistry epoch id (-1 = none). */
  epochId: number;
  epochOpenedAt: number;
  updatedAt: string;
}

const DATA_DIR = new URL("../../data/", import.meta.url).pathname;
const STATE_FILE = `${DATA_DIR}perpl-hedger-state.json`;

export function loadState(): DurableState {
  try {
    const raw = readFileSync(STATE_FILE, "utf8");
    return { ...defaultState(), ...(JSON.parse(raw) as DurableState) };
  } catch {
    return defaultState();
  }
}

function defaultState(): DurableState {
  return {
    state: "INIT",
    spotMon: 0,
    spotCostUsd: 0,
    spotTxHash: "",
    targetSizeMon: 0,
    epochId: -1,
    epochOpenedAt: 0,
    updatedAt: new Date().toISOString(),
  };
}

export function saveState(s: DurableState): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    s.updatedAt = new Date().toISOString();
    const tmp = `${STATE_FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify(s, null, 2));
    renameSync(tmp, STATE_FILE); // atomic swap — never a torn file
  } catch (e) {
    console.error(`state save failed: ${(e as Error).message}`);
  }
}

export function transition(s: DurableState, to: HedgerState, reason: string): void {
  if (s.state === to) return;
  const from = s.state;
  s.state = to;
  saveState(s);
  console.log(`[${new Date().toISOString()}] state ${from} → ${to} (${reason})`);
  pushEvent("state", `state ${from} → ${to} (${reason})`);
  void alertOnce(`ph:state:${from}-${to}`, 300_000, `🌀 ZeroDrift: ${from} → ${to}\n${reason}`);
}
