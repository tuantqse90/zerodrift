// Unit tests for the trading-client helpers + the Ed25519 sign-in frame. The
// signing test is the important one: it proves buildSignInFrame produces a
// signature that verifies against the canonical string Perpl expects.

import { ed25519 } from "@noble/curves/ed25519";
import { describe, expect, test } from "bun:test";
import { b64url, buildSignInFrame, hexToBytes, parseAmount } from "../../src/lib/perpl-trade";

describe("parseAmount", () => {
  test("numbers pass through", () => {
    expect(parseAmount(5)).toBe(5);
    expect(parseAmount(0)).toBe(0);
  });
  test("decimal strings parse (Perpl 'Amount' type)", () => {
    expect(parseAmount("3.14")).toBeCloseTo(3.14, 6);
    expect(parseAmount("1000000")).toBe(1_000_000);
  });
  test("empty / garbage / null → 0 (never NaN)", () => {
    expect(parseAmount("")).toBe(0);
    expect(parseAmount("abc")).toBe(0);
    expect(parseAmount(null)).toBe(0);
    expect(parseAmount(undefined)).toBe(0);
  });
});

describe("b64url", () => {
  test("is URL-safe and unpadded", () => {
    const s = b64url(new Uint8Array([255, 254, 253, 0, 1]));
    expect(s).not.toContain("+");
    expect(s).not.toContain("/");
    expect(s).not.toContain("=");
  });
  test("round-trips through base64url decoding", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252]);
    const decoded = new Uint8Array(Buffer.from(b64url(bytes), "base64url"));
    expect([...decoded]).toEqual([...bytes]);
  });
});

describe("hexToBytes", () => {
  test("handles 0x-prefixed and bare hex", () => {
    expect([...hexToBytes("0x0102ff")]).toEqual([1, 2, 255]);
    expect([...hexToBytes("0102ff")]).toEqual([1, 2, 255]);
  });
});

describe("buildSignInFrame (Ed25519)", () => {
  test("signature verifies against Perpl's canonical string", () => {
    const edPriv = ed25519.utils.randomPrivateKey();
    const edPub = ed25519.getPublicKey(edPriv);
    const chainId = 143;

    const frame = buildSignInFrame({ apiKey: "tok-123", edPriv, chainId }) as {
      mt: number;
      chain_id: number;
      api_key: string;
      timestamp: string;
      nonce: string;
      signature: string;
    };

    expect(frame.mt).toBe(29);
    expect(frame.chain_id).toBe(143);
    expect(frame.api_key).toBe("tok-123");

    // Reconstruct exactly what the server hashes and verify the signature.
    const canonical = [chainId, "trading-ws-signin", frame.timestamp, frame.nonce].join("\n");
    const sig = new Uint8Array(Buffer.from(frame.signature, "base64url"));
    const ok = ed25519.verify(sig, new TextEncoder().encode(canonical), edPub);
    expect(ok).toBe(true);
  });

  test("each frame uses a fresh nonce", () => {
    const edPriv = ed25519.utils.randomPrivateKey();
    const a = buildSignInFrame({ apiKey: "t", edPriv, chainId: 143 }) as { nonce: string };
    const b = buildSignInFrame({ apiKey: "t", edPriv, chainId: 143 }) as { nonce: string };
    expect(a.nonce).not.toBe(b.nonce);
  });
});
