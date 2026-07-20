// respawn.ts — operator maintenance: re-create running user containers from their
// stored config (e.g. after a feed-name migration, which is baked into container env).
// The hedge is durable state on disk, so the bot resumes its position on boot.
//
//   bun run src/cloud/respawn.ts <0xaddress> [--apply]
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decryptJson } from "./crypto";
import { containerName, startInstance, type InstanceConfig, type UserKeys } from "./spawn";

const CLOUD_DIR = process.env.CLOUD_DIR || "/opt/zerodrift/cloud";
const address = (process.argv[2] || "").toLowerCase();
const APPLY = process.argv.includes("--apply");
if (!/^0x[0-9a-f]{40}$/.test(address)) {
  console.error("usage: bun run src/cloud/respawn.ts <0xaddress> [--apply]");
  process.exit(1);
}

const SECRET = readFileSync(join(CLOUD_DIR, "secret.key"), "utf8").trim();
const inst = JSON.parse(readFileSync(join(CLOUD_DIR, "instances", `${address}.json`), "utf8")) as {
  config: InstanceConfig;
  encKeys: string;
};
// Pre-mm records lack these; never bake HEDGER_MODE=undefined into a container env.
inst.config.mode ??= "hedge";
inst.config.market ??= "MON";

console.log(
  `${containerName(address)} · acct ${inst.config.accountId} · ${inst.config.strategy} · $${inst.config.notionalUsd} · ` +
    `${inst.config.live ? "LIVE" : "paper"} · feed ${inst.config.feedName}${APPLY ? "" : "  (dry run)"}`,
);
if (!APPLY) process.exit(0);

const keys = decryptJson<UserKeys>(inst.encKeys, SECRET);
await startInstance(inst.config, keys);
console.log("respawned — the hedge resumes from durable state");
