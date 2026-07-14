// status.ts — public status feed for the web terminal. When HEDGER_STATUS_FILE is
// set, the engine mirrors its recent events + running totals into a small JSON
// file (atomic rename). The ZeroDrift site serves that file statically, so the
// landing-page terminal shows the engine's REAL rolling output.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { envStr } from "../lib/config";

export interface StatusEvent {
  ts: string;
  kind: "fill" | "state" | "info";
  text: string;
}

/** One cumulative datapoint for the history sparkline. */
export interface HistoryPoint {
  t: number; // unix ms
  vol: number; // cumulative week volume USD
  fees: number; // cumulative fees USD
  funding: number; // cumulative funding USD
  net: number; // funding − fees
}

const STATUS_FILE = envStr("HEDGER_STATUS_FILE", "");
const HISTORY_FILE = STATUS_FILE ? STATUS_FILE.replace(/\.json$/, "-history.json") : "";
const MAX_EVENTS = 12;
const MAX_HISTORY = 240;
/** Append a history point at most this often (ms) to keep the series compact. */
const HISTORY_MIN_GAP_MS = 5 * 60_000;

const events: StatusEvent[] = [];
let history: HistoryPoint[] = loadHistory();
let lastHistoryAt = history.length ? history[history.length - 1].t : 0;

function loadHistory(): HistoryPoint[] {
  if (!HISTORY_FILE || !existsSync(HISTORY_FILE)) return [];
  try {
    const arr = JSON.parse(readFileSync(HISTORY_FILE, "utf8"));
    return Array.isArray(arr) ? arr.slice(-MAX_HISTORY) : [];
  } catch {
    return [];
  }
}

export function pushEvent(kind: StatusEvent["kind"], text: string): void {
  events.push({ ts: new Date().toISOString(), kind, text });
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
}

/** Record a cumulative snapshot into the durable history series (rate-limited). */
export function recordHistory(nowMs: number, vol: number, fees: number, funding: number): void {
  if (!HISTORY_FILE) return;
  if (nowMs - lastHistoryAt < HISTORY_MIN_GAP_MS) return;
  lastHistoryAt = nowMs;
  history.push({ t: nowMs, vol, fees, funding, net: funding - fees });
  if (history.length > MAX_HISTORY) history = history.slice(-MAX_HISTORY);
  try {
    const tmp = `${HISTORY_FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify(history));
    renameSync(tmp, HISTORY_FILE);
  } catch {
    /* best-effort */
  }
}

export function writeStatus(data: Record<string, unknown>): void {
  if (!STATUS_FILE) return;
  try {
    mkdirSync(dirname(STATUS_FILE), { recursive: true });
    const tmp = `${STATUS_FILE}.tmp`;
    writeFileSync(
      tmp,
      JSON.stringify({ generatedAt: new Date().toISOString(), events, history: history.slice(-120), ...data }),
    );
    renameSync(tmp, STATUS_FILE);
  } catch {
    /* best-effort — a broken status file must never hurt the engine */
  }
}
