/**
 * Logarithmic market scoring rule. Quantities q are shares outstanding per outcome; b is liquidity, the
 * most the market maker can lose on a two-outcome market is b ln 2. Computed with the max factored out so
 * large quantities do not overflow.
 */

const maxOf = (q: readonly number[]): number => q.reduce((m, x) => (x > m ? x : m), Number.NEGATIVE_INFINITY);

export function lmsrPrices(q: readonly number[], b: number): number[] {
  const top = maxOf(q);
  const weights = q.map((x) => Math.exp((x - top) / b));
  const total = weights.reduce((sum, w) => sum + w, 0);
  return weights.map((w) => w / total);
}

export function lmsrCost(q: readonly number[], b: number): number {
  const top = maxOf(q);
  return top + b * Math.log(q.reduce((sum, x) => sum + Math.exp((x - top) / b), 0));
}

/** Quantities that open the market at the given prices. */
export const openingQuantities = (prices: readonly number[], b: number): number[] => prices.map((p) => b * Math.log(p));

/** Shares of one outcome that cost exactly `spend`: solves C(q + x·e_i) − C(q) = spend in closed form. */
export function sharesForSpend(q: readonly number[], outcome: number, spend: number, b: number): number {
  const price = lmsrPrices(q, b)[outcome];
  if (price === undefined || spend <= 0) return 0;
  return b * Math.log(1 + Math.expm1(spend / b) / price);
}
