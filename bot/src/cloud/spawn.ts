// spawn.ts — per-user bot containers, spawned as siblings via the host docker socket.
// Keys are passed ONLY as env vars into the user's own container (visible to root on
// the box via `docker inspect` — same honest trust model as golive-live.sh).

export interface UserKeys {
  apiKey: string;
  edPrivHex: string;
}

export interface InstanceConfig {
  address: string; // 0x… lowercase — the user's wallet, id of the instance
  accountId: string; // Perpl exchange account id (digits)
  notionalUsd: number;
  strategy: "churn" | "avellaneda";
  /** hedge = spot+short FSM (run.ts); mm = standalone two-sided MM (run-mm.ts). */
  mode: "hedge" | "mm";
  /** Perpl market symbol — whitelisted in validateStart. */
  market: string;
  live: boolean; // false = paper (simulated fills, keys unused)
  createdAt: string;
  /** HMAC-derived status feed file name — the capability to read this user's feed. */
  feedName: string;
}

export const ZD_ROOT = process.env.ZD_ROOT || "/opt/zerodrift";
const IMAGE = process.env.CLOUD_BOT_IMAGE || "oven/bun:1-alpine";

export function shortId(address: string): string {
  return address.toLowerCase().replace(/^0x/, "").slice(0, 8);
}

export function containerName(address: string): string {
  return `zd-u-${shortId(address)}`;
}

/** Legacy address-derived feed name — kept only so old public files can be cleaned up. */
export function legacyStatusFileName(address: string): string {
  return `status-u-${shortId(address)}.json`;
}

/** Full `docker run` argv. Secrets appear ONLY as -e values. */
export function dockerRunArgs(cfg: InstanceConfig, keys: UserKeys, unwind = false): string[] {
  const name = containerName(cfg.address);
  const args = [
    "run", "-d", "--name", name,
    "--network", "host",
    "--restart", "on-failure",
    "--cpus", "0.5", "--memory", "256m",
    "--label", "zerodrift.cloud=user",
    "--label", `zerodrift.address=${cfg.address}`,
    "-v", `${ZD_ROOT}:${ZD_ROOT}`,
    "-w", `${ZD_ROOT}/bot`,
    "-e", `HEDGER_STRATEGY=${cfg.strategy}`,
    "-e", `HEDGER_MODE=${cfg.mode}`,
    "-e", `HEDGER_MARKET=${cfg.market}`,
    "-e", "HEDGER_SPOT_MANAGED=false",
    "-e", `HEDGER_UNWIND=${unwind}`,
    "-e", `HEDGER_NOTIONAL_USD=${cfg.notionalUsd}`,
    "-e", `PERPL_ACCOUNT_ID=${cfg.accountId}`,
    "-e", `PERPL_API_KEY=${keys.apiKey}`,
    "-e", `PERPL_ED25519_PRIVKEY=${keys.edPrivHex}`,
    "-e", `HEDGER_STATUS_FILE=${ZD_ROOT}/status/${cfg.feedName}`,
    "-e", `HEDGER_DATA_DIR=${ZD_ROOT}/cloud/data/${shortId(cfg.address)}`,
    "-e", "NT_API_BASE=http://localhost:8421",
    "-e", "MONAD_RPC_URL=https://rpc.monad.xyz",
  ];
  if (cfg.live) args.push("-e", "HEDGER_LIVE=true");
  args.push(IMAGE, "bun", "run", cfg.mode === "mm" ? "mm" : "hedger");
  return args;
}

async function docker(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { code, out: out.trim(), err: err.trim() };
}

export async function startInstance(cfg: InstanceConfig, keys: UserKeys, unwind = false): Promise<void> {
  await docker(["rm", "-f", containerName(cfg.address)]); // idempotent
  const res = await docker(dockerRunArgs(cfg, keys, unwind));
  if (res.code !== 0) throw new Error(`docker run failed: ${res.err.slice(0, 300)}`);
}

export async function stopInstance(address: string): Promise<void> {
  await docker(["rm", "-f", containerName(address)]);
}

export interface InstanceState {
  running: boolean;
  startedAt?: string;
  exitCode?: number;
}

export async function inspectInstance(address: string): Promise<InstanceState> {
  const res = await docker([
    "inspect", "-f", "{{.State.Running}}|{{.State.StartedAt}}|{{.State.ExitCode}}",
    containerName(address),
  ]);
  if (res.code !== 0) return { running: false };
  const [running, startedAt, exitCode] = res.out.split("|");
  return { running: running === "true", startedAt, exitCode: Number(exitCode) };
}

export async function countRunningUserBots(): Promise<number> {
  const res = await docker(["ps", "-q", "--filter", "label=zerodrift.cloud=user"]);
  if (res.code !== 0) return 0;
  return res.out ? res.out.split("\n").length : 0;
}
