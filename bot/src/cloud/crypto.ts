// crypto.ts — AES-256-GCM at-rest encryption for user trading keys.
// Blob layout: base64( iv[12] | authTag[16] | ciphertext ). The server secret is a
// 64-hex key generated once on the box (0600); losing it only means users re-enroll.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export function encryptJson(obj: unknown, keyHex: string): string {
  const key = Buffer.from(keyHex, "hex");
  if (key.length !== 32) throw new Error("secret must be 32 bytes hex");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(obj), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64");
}

export function decryptJson<T>(blob: string, keyHex: string): T {
  const key = Buffer.from(keyHex, "hex");
  const raw = Buffer.from(blob, "base64");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ct = raw.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return JSON.parse(pt.toString("utf8")) as T;
}

export function newSecretHex(): string {
  return randomBytes(32).toString("hex");
}
