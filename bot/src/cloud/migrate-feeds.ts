// migrate-feeds.ts — one-shot: give every stored instance an unguessable HMAC feed
// name, delete the old address-derived (publicly readable) status files, and report
// which containers must be restarted to start writing to the new path.
//
//   bun run src/cloud/migrate-feeds.ts [--apply]
import { readFileSync, writeFileSync, renameSync, existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { feedId } from "./crypto";
import { legacyStatusFileName, shortId, ZD_ROOT } from "./spawn";

const CLOUD_DIR = process.env.CLOUD_DIR || "/opt/zerodrift/cloud";
const APPLY = process.argv.includes("--apply");
const SECRET = readFileSync(join(CLOUD_DIR, "secret.key"), "utf8").trim();
const INSTANCES = join(CLOUD_DIR, "instances");
const STATUS = join(ZD_ROOT, "status");

for (const file of readdirSync(INSTANCES).filter((f) => f.endsWith(".json"))) {
  const p = join(INSTANCES, file);
  const inst = JSON.parse(readFileSync(p, "utf8")) as { config: Record<string, unknown> };
  const address = String(inst.config.address);
  if (inst.config.feedName) {
    console.log(`${address} already private (${inst.config.feedName})`);
    continue;
  }
  const feedName = `status-u-${feedId(address, SECRET)}.json`;
  const legacy = join(STATUS, legacyStatusFileName(address));
  console.log(`${address}: ${legacyStatusFileName(address)} → ${feedName}${APPLY ? "" : "  (dry run)"}`);
  if (!APPLY) continue;

  inst.config.feedName = feedName;
  writeFileSync(p, JSON.stringify(inst, null, 2), { mode: 0o600 });
  // Carry the live data over so the user's chart doesn't reset, then unpublish the old names.
  if (existsSync(legacy)) renameSync(legacy, join(STATUS, feedName));
  const legacyHist = legacy.replace(/\.json$/, "-history.json");
  if (existsSync(legacyHist)) renameSync(legacyHist, join(STATUS, feedName.replace(/\.json$/, "-history.json")));
  rmSync(legacy, { force: true });
  rmSync(legacyHist, { force: true });
  console.log(`  restart needed: zd-u-${shortId(address)} (writes to the old path until then)`);
}
