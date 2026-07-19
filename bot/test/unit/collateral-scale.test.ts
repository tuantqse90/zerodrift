import { describe, expect, test } from "bun:test";
import { parseAmount, parseCollateral } from "../../src/lib/perpl-trade";

describe("collateral scaling (AUSD 6-dec)", () => {
  test("live fee '6751' means $0.006751 — the 2026-07-19 ledger poisoning", () => {
    expect(parseCollateral("6751")).toBeCloseTo(0.006751, 9);
    expect(parseCollateral(6751)).toBeCloseTo(0.006751, 9);
  });

  test("balance/locked raw units scale to dollars", () => {
    expect(parseCollateral("55170000")).toBeCloseTo(55.17, 6);
    expect(parseCollateral("0")).toBe(0);
    expect(parseCollateral("")).toBe(0);
    expect(parseCollateral(undefined)).toBe(0);
  });

  test("parseAmount stays a raw passthrough (sizes/prices use their own scalers)", () => {
    expect(parseAmount("6751")).toBe(6751);
    expect(parseAmount("not-a-number")).toBe(0);
  });
});
