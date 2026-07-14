// status.ts — public status feed for the web terminal. When HEDGER_STATUS_FILE is
// set, the engine mirrors its recent events + running totals into a small JSON
// file (atomic rename). The ZeroDrift site serves that file statically, so the
// landing-page terminal shows the engine's REAL rolling output.

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { envStr } from "../lib/config";

export interface StatusEvent {
  ts: string;
  kind: "fill" | "state" | "info";
  text: string;
}

const STATUS_FILE = envStr("HEDGER_STATUS_FILE", "");
const MAX_EVENTS = 12;

const events: StatusEvent[] = [];

export function pushEvent(kind: StatusEvent["kind"], text: string): void {
  events.push({ ts: new Date().toISOString(), kind, text });
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
}

export function writeStatus(data: Record<string, unknown>): void {
  if (!STATUS_FILE) return;
  try {
    mkdirSync(dirname(STATUS_FILE), { recursive: true });
    const tmp = `${STATUS_FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify({ generatedAt: new Date().toISOString(), events, ...data }));
    renameSync(tmp, STATUS_FILE);
  } catch {
    /* best-effort — a broken status file must never hurt the engine */
  }
}
