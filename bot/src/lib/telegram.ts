// telegram.ts — best-effort signal alerts to a Telegram bot. The token comes from env
// (TG_BOT_TOKEN); the chat id is either TG_CHAT_ID or AUTO-DISCOVERED from getUpdates the
// first time the operator messages the bot, then cached to data/tg-chat.txt so it survives
// restarts. Nothing here throws — a down Telegram must never affect the detectors.

import { appendFileSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";

const TOKEN = process.env.TG_BOT_TOKEN || "";
const CHAT_ENV = process.env.TG_CHAT_ID || "";
const CACHE = new URL("../../data/tg-chat.txt", import.meta.url).pathname;

let cachedChat: string | null = CHAT_ENV || readCache();
let lastResolveAt = 0;

function readCache(): string | null {
  try { return readFileSync(CACHE, "utf8").trim() || null; } catch { return null; }
}
function writeCache(id: string): void {
  try {
    mkdirSync(new URL("../../data/", import.meta.url).pathname, { recursive: true });
    writeFileSync(CACHE, id);
  } catch { /* best-effort */ }
}

// Poll getUpdates for the most recent chat that messaged the bot. Throttled to once/60s so a
// chat-less bot doesn't hammer the API every alert.
async function resolveChat(): Promise<string | null> {
  if (cachedChat) return cachedChat;
  if (!TOKEN) return null;
  const now = Date.now();
  if (now - lastResolveAt < 60_000) return null;
  lastResolveAt = now;
  try {
    const r = await fetch(`https://api.telegram.org/bot${TOKEN}/getUpdates`, { signal: AbortSignal.timeout(8000) });
    const j: any = await r.json();
    if (!j?.ok || !Array.isArray(j.result)) return null;
    for (let i = j.result.length - 1; i >= 0; i--) {
      const m = j.result[i]?.message || j.result[i]?.channel_post;
      const id = m?.chat?.id;
      if (id != null) { cachedChat = String(id); writeCache(cachedChat); return cachedChat; }
    }
  } catch { /* ignore */ }
  return null;
}

/** Fire-and-forget a Telegram message. No-op if the token/chat aren't ready yet. */
export async function sendTelegram(text: string): Promise<boolean> {
  if (!TOKEN) return false;
  const chat = await resolveChat();
  if (!chat) return false;
  try {
    const r = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text, parse_mode: "Markdown", disable_web_page_preview: true }),
      signal: AbortSignal.timeout(8000),
    });
    return (await r.json())?.ok === true;
  } catch { return false; }
}

// One-time "bots online" confirmation, sent the moment the chat first resolves (i.e. as soon as
// the operator messages the bot). Call this on an interval; it fires exactly once.
let announced = false;
export async function announceOnlineOnce(text: string): Promise<void> {
  if (announced || !TOKEN) return;
  const chat = await resolveChat();
  if (!chat) return;
  announced = true;
  await sendTelegram(text);
}

// Per-key cooldown so a persistent signal doesn't spam every cycle.
const lastAlertAt = new Map<string, number>();
export async function alertOnce(key: string, cooldownMs: number, text: string): Promise<void> {
  const now = Date.now();
  if (now - (lastAlertAt.get(key) ?? 0) < cooldownMs) return;
  // Grad keys are per-pair (unbounded over a long run) — an expired entry is behaviourally
  // identical to an absent one, so prune stale keys before inserting to keep the Map bounded.
  for (const [k, t] of lastAlertAt) if (now - t >= cooldownMs) lastAlertAt.delete(k);
  lastAlertAt.set(key, now);
  const ok = await sendTelegram(text);
  try {
    mkdirSync(new URL("../../data/", import.meta.url).pathname, { recursive: true });
    appendFileSync(new URL("../../data/alerts.jsonl", import.meta.url).pathname,
      JSON.stringify({ ts: new Date().toISOString(), key, sent: ok, text }) + "\n");
  } catch { /* best-effort */ }
}
