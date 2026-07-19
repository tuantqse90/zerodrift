// server.ts — zd-cloud: run YOUR ZeroDrift bot 24/7 on our box, keyed to your wallet.
//
// Every mutating call is gated by an EIP-191 personal_sign from the wallet that owns
// the instance: message = `zerodrift-cloud:<action>:<address>:<ts>` with |now-ts| ≤ 5min.
// Perpl keys are AES-256-GCM encrypted at rest (secret.key on the box, 0600) and are
// decrypted only into the user's own container env at spawn. They are never logged.
// EOA signatures only (ecrecover) — smart-contract wallets are not supported here.
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync, readdirSync, rmSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { verifyMessage } from "viem";
import { decryptJson, encryptJson, newSecretHex } from "./crypto";
import {
  containerName, countRunningUserBots, inspectInstance, startInstance, statusFileName,
  stopInstance, type InstanceConfig, type UserKeys,
} from "./spawn";

const PORT = Number(process.env.CLOUD_PORT || 8796);
const CLOUD_DIR = process.env.CLOUD_DIR || "/opt/zerodrift/cloud";
const MAX_INSTANCES = Number(process.env.CLOUD_MAX_INSTANCES || 8);
const MAX_NOTIONAL = Number(process.env.CLOUD_MAX_NOTIONAL_USD || 200);
const SITE = process.env.CLOUD_SITE_BASE || "https://hedge.nullterminal.xyz";
const SIG_WINDOW_MS = 5 * 60 * 1000;

const INSTANCES = join(CLOUD_DIR, "instances");

let SECRET = ""; // initialised in main() — tests import the pure helpers only
function initState(): void {
  mkdirSync(INSTANCES, { recursive: true });
  const secretFile = join(CLOUD_DIR, "secret.key");
  if (!existsSync(secretFile)) {
    writeFileSync(secretFile, newSecretHex(), { mode: 0o600 });
    chmodSync(secretFile, 0o600);
  }
  SECRET = readFileSync(secretFile, "utf8").trim();
}

interface StoredInstance {
  config: InstanceConfig;
  encKeys: string; // encryptJson({apiKey, edPrivHex})
}

function instPath(address: string): string {
  return join(INSTANCES, `${address.toLowerCase()}.json`);
}

function loadInstance(address: string): StoredInstance | null {
  const p = instPath(address);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8")) as StoredInstance;
}

function saveInstance(inst: StoredInstance): void {
  const p = instPath(inst.config.address);
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(inst, null, 2), { mode: 0o600 });
  renameSync(tmp, p);
}

// ── validation ───────────────────────────────────────────────────────────────
export function canonicalMessage(action: "start" | "stop", address: string, ts: number): string {
  return `zerodrift-cloud:${action}:${address.toLowerCase()}:${ts}`;
}

export interface StartBody {
  address: string; accountId: string; apiKey: string; edPrivHex: string;
  notionalUsd: number; strategy: "churn" | "avellaneda"; live: boolean;
  ts: number; sig: `0x${string}`;
}

export function validateStart(b: Partial<StartBody>): string | null {
  if (!/^0x[0-9a-fA-F]{40}$/.test(b.address ?? "")) return "bad address";
  if (!/^\d{1,12}$/.test(b.accountId ?? "")) return "bad accountId";
  if (typeof b.apiKey !== "string" || b.apiKey.length < 8 || b.apiKey.length > 300) return "bad apiKey";
  if (!/^0x[0-9a-fA-F]{64}$/.test(b.edPrivHex ?? "")) return "bad edPrivHex";
  if (typeof b.notionalUsd !== "number" || !(b.notionalUsd >= 10 && b.notionalUsd <= MAX_NOTIONAL))
    return `notionalUsd must be 10..${MAX_NOTIONAL}`;
  if (b.strategy !== "churn" && b.strategy !== "avellaneda") return "bad strategy";
  if (typeof b.live !== "boolean") return "bad live flag";
  if (typeof b.ts !== "number" || Math.abs(Date.now() - b.ts) > SIG_WINDOW_MS) return "stale ts";
  if (typeof b.sig !== "string" || !b.sig.startsWith("0x")) return "bad sig";
  return null;
}

async function verifySig(action: "start" | "stop", address: string, ts: number, sig: `0x${string}`): Promise<boolean> {
  try {
    return await verifyMessage({
      address: address as `0x${string}`,
      message: canonicalMessage(action, address, ts),
      signature: sig,
    });
  } catch {
    return false;
  }
}

// ── tiny per-IP rate limit ───────────────────────────────────────────────────
const hits = new Map<string, number[]>();
function limited(ip: string, max = 12, windowMs = 60_000): boolean {
  const now = Date.now();
  const arr = (hits.get(ip) ?? []).filter((t) => now - t < windowMs);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > max;
}

const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

function publicView(inst: StoredInstance, running: boolean, startedAt?: string) {
  const { config } = inst;
  return {
    exists: true,
    running,
    startedAt,
    live: config.live,
    strategy: config.strategy,
    notionalUsd: config.notionalUsd,
    createdAt: config.createdAt,
    container: containerName(config.address),
    statusUrl: `${SITE}/${statusFileName(config.address)}`,
  };
}

function main(): void {
  initState();
  Bun.serve({
  port: PORT,
  async fetch(req, srv) {
    const url = new URL(req.url);
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || srv.requestIP(req)?.address || "?";
    if (limited(ip)) return json({ error: "rate limited" }, 429);

    try {
      if (req.method === "GET" && url.pathname === "/api/cloud/status") {
        const address = (url.searchParams.get("address") || "").toLowerCase();
        if (!/^0x[0-9a-f]{40}$/.test(address)) return json({ error: "bad address" }, 400);
        const inst = loadInstance(address);
        if (!inst) return json({ exists: false });
        const state = await inspectInstance(address);
        return json(publicView(inst, state.running, state.startedAt));
      }

      if (req.method === "POST" && url.pathname === "/api/cloud/start") {
        const b = (await req.json()) as Partial<StartBody>;
        const bad = validateStart(b);
        if (bad) return json({ error: bad }, 400);
        const body = b as StartBody;
        const address = body.address.toLowerCase();
        if (!(await verifySig("start", address, body.ts, body.sig))) return json({ error: "bad signature" }, 401);

        const existing = loadInstance(address);
        if (!existing && (await countRunningUserBots()) >= MAX_INSTANCES)
          return json({ error: "server full — try later" }, 503);

        const config: InstanceConfig = {
          address,
          accountId: body.accountId,
          notionalUsd: body.notionalUsd,
          strategy: body.strategy,
          live: body.live,
          createdAt: existing?.config.createdAt ?? new Date().toISOString(),
        };
        const keys: UserKeys = { apiKey: body.apiKey, edPrivHex: body.edPrivHex };
        saveInstance({ config, encKeys: encryptJson(keys, SECRET) });
        await startInstance(config, keys);
        console.log(`[cloud] start ${containerName(address)} live=${config.live} strat=${config.strategy} $${config.notionalUsd}`);
        const state = await inspectInstance(address);
        return json(publicView({ config, encKeys: "" }, state.running, state.startedAt));
      }

      if (req.method === "POST" && url.pathname === "/api/cloud/stop") {
        const b = (await req.json()) as { address?: string; unwind?: boolean; forget?: boolean; ts?: number; sig?: `0x${string}` };
        const address = (b.address || "").toLowerCase();
        if (!/^0x[0-9a-f]{40}$/.test(address)) return json({ error: "bad address" }, 400);
        if (typeof b.ts !== "number" || Math.abs(Date.now() - b.ts) > SIG_WINDOW_MS) return json({ error: "stale ts" }, 400);
        if (!b.sig || !(await verifySig("stop", address, b.ts, b.sig))) return json({ error: "bad signature" }, 401);
        const inst = loadInstance(address);
        if (!inst) return json({ error: "no instance" }, 404);

        if (b.unwind) {
          // relaunch once with HEDGER_UNWIND=true — exits 0 after clean unwind
          const keys = decryptJson<UserKeys>(inst.encKeys, SECRET);
          await startInstance(inst.config, keys, true);
          console.log(`[cloud] unwind ${containerName(address)}`);
          return json({ ok: true, unwinding: true });
        }
        await stopInstance(address);
        if (b.forget) rmSync(instPath(address), { force: true });
        console.log(`[cloud] stop ${containerName(address)} forget=${!!b.forget}`);
        return json({ ok: true });
      }

      if (req.method === "GET" && url.pathname === "/api/cloud/health") {
        const files = readdirSync(INSTANCES).filter((f) => f.endsWith(".json"));
        return json({ ok: true, instances: files.length, running: await countRunningUserBots(), max: MAX_INSTANCES });
      }

      return json({ error: "not found" }, 404);
    } catch (e) {
      console.error(`[cloud] error ${url.pathname}: ${(e as Error).message}`); // never log bodies
      return json({ error: "internal" }, 500);
    }
  },
  });
  console.log(`[cloud] zd-cloud listening on :${PORT} — max ${MAX_INSTANCES} instances, notional cap $${MAX_NOTIONAL}`);
}

if (import.meta.main) main();
