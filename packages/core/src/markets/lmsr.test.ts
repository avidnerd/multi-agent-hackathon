import { describe, expect, it } from "vitest";
import { lmsrCost, lmsrPrices, openingQuantities, sharesForSpend } from "./lmsr";

const B = 40;

describe("LMSR market maker", () => {
  it("opens at the prices it is given and keeps prices summing to one", () => {
    const q = openingQuantities([0.7, 0.3], B);
    const prices = lmsrPrices(q, B);
    expect(prices[0]).toBeCloseTo(0.7, 10);
    expect(prices[1]).toBeCloseTo(0.3, 10);
    expect(prices.reduce((a, p) => a + p, 0)).toBeCloseTo(1, 12);
  });

  it("sells exactly as many shares as the spend pays for, and buying raises that outcome's price", () => {
    const q = openingQuantities([0.5, 0.5], B);
    const shares = sharesForSpend(q, 1, 10, B);
    const after = [q[0] ?? 0, (q[1] ?? 0) + shares];
    expect(lmsrCost(after, B) - lmsrCost(q, B)).toBeCloseTo(10, 9);
    expect(shares).toBeGreaterThan(10);
    expect(lmsrPrices(after, B)[1]).toBeGreaterThan(0.5);
  });

  it("stays finite when one side has been bought heavily", () => {
    let q = openingQuantities([0.5, 0.5], B);
    for (let i = 0; i < 200; i += 1) q = [q[0] ?? 0, (q[1] ?? 0) + sharesForSpend(q, 1, 25, B)];
    const prices = lmsrPrices(q, B);
    expect(prices.every(Number.isFinite)).toBe(true);
    expect(prices[1]).toBeLessThanOrEqual(1);
    expect(sharesForSpend(q, 0, 0, B)).toBe(0);
  });
});
