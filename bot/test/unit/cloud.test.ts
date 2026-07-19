import { describe, expect, test } from "bun:test";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { verifyMessage } from "viem";
import { decryptJson, encryptJson, newSecretHex } from "../../src/cloud/crypto";
import { canonicalMessage, validateStart } from "../../src/cloud/server";
import { containerName, dockerRunArgs, statusFileName, type InstanceConfig } from "../../src/cloud/spawn";

const CFG: InstanceConfig = {
  address: "0xAbCd00000000000000000000000000000000ef12".toLowerCase(),
  accountId: "3710",
  notionalUsd: 50,
  strategy: "avellaneda",
  live: true,
  createdAt: "2026-07-19T00:00:00.000Z",
};
const KEYS = { apiKey: "tok_abcdef123456", edPrivHex: `0x${"7".repeat(64)}` };

describe("cloud crypto", () => {
  test("round-trips and rejects tamper", () => {
    const secret = newSecretHex();
    const blob = encryptJson(KEYS, secret);
    expect(decryptJson(blob, secret)).toEqual(KEYS);
    const raw = Buffer.from(blob, "base64");
    raw[raw.length - 1] ^= 0xff;
    expect(() => decryptJson(raw.toString("base64"), secret)).toThrow();
    expect(() => decryptJson(blob, newSecretHex())).toThrow();
  });
});

describe("wallet-signature gate", () => {
  test("personal_sign of the canonical message verifies; wrong wallet fails", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const ts = Date.now();
    const msg = canonicalMessage("start", account.address, ts);
    const sig = await account.signMessage({ message: msg });
    expect(await verifyMessage({ address: account.address, message: msg, signature: sig })).toBe(true);
    const other = privateKeyToAccount(generatePrivateKey());
    expect(await verifyMessage({ address: other.address, message: msg, signature: sig })).toBe(false);
  });

  test("message binds action + address + ts", () => {
    const m = canonicalMessage("stop", "0xABC0000000000000000000000000000000000001", 123);
    expect(m).toBe("zerodrift-cloud:stop:0xabc0000000000000000000000000000000000001:123");
  });
});

describe("start validation", () => {
  const good = {
    address: CFG.address, accountId: "3710", apiKey: KEYS.apiKey, edPrivHex: KEYS.edPrivHex,
    notionalUsd: 50, strategy: "avellaneda" as const, live: false, ts: Date.now(), sig: "0xdead" as `0x${string}`,
  };
  test("accepts a well-formed body", () => expect(validateStart(good)).toBeNull());
  test("caps notional", () => {
    expect(validateStart({ ...good, notionalUsd: 5 })).toContain("notionalUsd");
    expect(validateStart({ ...good, notionalUsd: 100000 })).toContain("notionalUsd");
  });
  test("rejects bad strategy / address / stale ts / bad ed25519 key", () => {
    expect(validateStart({ ...good, strategy: "yolo" as any })).toBe("bad strategy");
    expect(validateStart({ ...good, address: "nope" })).toBe("bad address");
    expect(validateStart({ ...good, ts: Date.now() - 10 * 60_000 })).toBe("stale ts");
    expect(validateStart({ ...good, edPrivHex: "0x1234" })).toBe("bad edPrivHex");
  });
});

describe("docker spawn args", () => {
  test("keys appear only as env pairs; never a wallet key; live gated", () => {
    const args = dockerRunArgs(CFG, KEYS);
    const joined = args.join(" ");
    expect(joined).toContain(`PERPL_API_KEY=${KEYS.apiKey}`);
    expect(joined).toContain(`PERPL_ED25519_PRIVKEY=${KEYS.edPrivHex}`);
    expect(joined).not.toContain("HEDGER_PRIVATE_KEY"); // spot is owner-held, never a wallet key
    expect(joined).toContain("HEDGER_SPOT_MANAGED=false");
    expect(joined).toContain("HEDGER_LIVE=true");
    // container identity is derived from the address, not the keys
    expect(containerName(CFG.address)).toBe("zd-u-abcd0000");
    expect(statusFileName(CFG.address)).toBe("status-u-abcd0000.json");
    // paper instance must NOT set HEDGER_LIVE
    const paper = dockerRunArgs({ ...CFG, live: false }, KEYS).join(" ");
    expect(paper).not.toContain("HEDGER_LIVE");
    // resource limits present
    expect(joined).toContain("--cpus");
    expect(joined).toContain("--memory");
  });
});

describe("resetTerminalState", () => {
  const { mkdtempSync, writeFileSync, existsSync } = require("node:fs");
  const { tmpdir } = require("node:os");
  const { join } = require("node:path");
  const { resetTerminalState } = require("../../src/cloud/server");

  test("wipes a durably-CLOSED state, preserves any live state", () => {
    const dir = mkdtempSync(join(tmpdir(), "zdc-"));
    const f = join(dir, "perpl-hedger-state.json");
    writeFileSync(f, JSON.stringify({ state: "CLOSED" }));
    expect(resetTerminalState(dir)).toBe(true);
    expect(existsSync(f)).toBe(false);
    writeFileSync(f, JSON.stringify({ state: "HEDGED", spotMon: 2321 }));
    expect(resetTerminalState(dir)).toBe(false);
    expect(existsSync(f)).toBe(true);
    expect(resetTerminalState(mkdtempSync(join(tmpdir(), "zdc-empty-")))).toBe(false);
  });
});
