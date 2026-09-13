import { describe, expect, it } from "vitest";
import type { Plan } from "@trip/core";
import { createMarketBook, generateMarkets, LIQUIDITY, STARTING_CREDITS } from "./book";

const plan: Plan = {
  id: "trip-plan",
  tripId: "trip",
  version: 1,
  items: [
    { id: "outbound", kind: "flight", title: "Flight TW101", startsAt: "2026-10-08T14:05:00.000Z", endsAt: "2026-10-08T15:40:00.000Z", costCents: 44_700, participants: ["a", "b", "c"], bookingRef: "FB1", inventoryId: "TW101", dependsOn: [] },
    { id: "venue-2-cove-kayak", kind: "reservation", title: "Cove kayak tour", startsAt: "2026-10-09T17:30:00.000Z", endsAt: "2026-10-09T20:00:00.000Z", costCents: 19_500, participants: ["a", "b", "c"], bookingRef: "RS1", inventoryId: "cove-kayak", dependsOn: ["outbound"] },
  ],
};
const members = [
  { id: "a", name: "Julia" },
  { id: "b", name: "Cody" },
];

let counter = 0;
const book = () => createMarketBook(generateMarkets(plan, -420), members, () => `tok-${(counter += 1)}`);

describe("markets from the plan", () => {
  it("suggests a missed-flight, a make-it and a spend market, early starts priced riskier", () => {
    const drafts = generateMarkets(plan, -420);
    expect(drafts.map((d) => d.question)).toEqual(["Does anyone miss Flight TW101 at 7:05am?", "Does everyone make Cove kayak tour at 10:30am?", "Does anyone spend over $350 on the trip?"]);
    expect(drafts[0]?.openingPrices).toEqual([0.3, 0.7]);
  });

  it("moves the price toward what people bet and spends their credits", () => {
    const b = book();
    const [julia] = b.links("http://x").map((l) => l.url.split("player=")[1] ?? "");
    const before = b.view(null).markets[1]?.outcomes[1]?.cents ?? 0;
    expect(b.bet({ token: julia ?? "", marketId: "make-venue-2-cove-kayak", outcome: "No", spend: 250 }).ok).toBe(true);
    const after = b.view(julia ?? null);
    expect(after.markets[1]?.outcomes[1]?.cents).toBeGreaterThan(before);
    expect(after.player).toMatchObject({ name: "Julia", credits: STARTING_CREDITS - 250 });
    // Selling straight back returns exactly what was paid, so a bet is never an instant profit.
    expect(after.player?.worth).toBe(STARTING_CREDITS);
    // The price chart gets the opening price and one point per bet, naming who moved it.
    const history = after.markets[1]?.history ?? [];
    expect(history.map((p) => p.by)).toEqual([null, "Julia"]);
    expect(history[0]?.cents).toEqual([75, 25]);
    expect(history[1]?.cents[1]).toBe(after.markets[1]?.outcomes[1]?.cents);
  });

  it("rejects bets it can't honour", () => {
    const b = book();
    const token = b.links("http://x")[0]?.url.split("player=")[1] ?? "";
    expect(b.bet({ token: "stolen", marketId: "spend-over", outcome: "Yes", spend: 5 })).toMatchObject({ ok: false });
    expect(b.bet({ token, marketId: "spend-over", outcome: "Maybe", spend: 5 })).toMatchObject({ ok: false });
    expect(b.bet({ token, marketId: "spend-over", outcome: "Yes", spend: STARTING_CREDITS + 1 })).toMatchObject({ ok: false });
  });

  it("shows prices that always add up to 100 cents", () => {
    const b = book();
    const [julia, cody] = b.links("http://x").map((l) => l.url.split("player=")[1] ?? "");
    for (const [token, outcome, spend] of [[julia, "Yes", 70], [cody, "No", 130], [julia, "Yes", 45], [cody, "Yes", 5]] as const) {
      b.bet({ token: token ?? "", marketId: "miss-outbound", outcome, spend });
      for (const m of b.view(null).markets) {
        expect(m.outcomes.reduce((sum, o) => sum + o.cents, 0)).toBe(100);
        expect(m.history.at(-1)?.cents.reduce((sum, c) => sum + c, 0)).toBe(100);
      }
    }
  });

  it("lets a member put their own question on the board for everyone", () => {
    const b = book();
    const [julia, cody] = b.links("http://x").map((l) => l.url.split("player=")[1] ?? "");
    const created = b.propose({ token: julia ?? "", question: "  Does Cody   oversleep the kayak tour " });
    expect(created).toEqual({ ok: true, value: { marketId: "member-4" } });
    expect(b.view(null).markets.at(-1)).toMatchObject({ question: "Does Cody oversleep the kayak tour?", createdBy: "Julia", outcomes: [{ cents: 50 }, { cents: 50 }] });
    expect(b.bet({ token: cody ?? "", marketId: "member-4", outcome: "No", spend: 10 }).ok).toBe(true);
    expect(b.propose({ token: cody ?? "", question: "does cody oversleep the kayak tour?" })).toMatchObject({ ok: false });
    expect(b.propose({ token: cody ?? "", question: "hi?" })).toMatchObject({ ok: false });
  });
});

describe("simulated payout", () => {
  const tokensOf = (b: ReturnType<typeof book>) => b.links("http://x").map((l) => l.url.split("player=")[1] ?? "");
  const heldBy = (b: ReturnType<typeof book>, token: string, marketId: string, outcome: number) =>
    b.view(token).markets.find((m) => m.id === marketId)?.outcomes[outcome]?.held ?? 0;

  it("pays one credit per winning share, nothing for losing shares, and changes nothing", () => {
    const b = book();
    const [julia = "", cody = ""] = tokensOf(b);
    b.bet({ token: julia, marketId: "spend-over", outcome: "Yes", spend: 100 });
    b.bet({ token: cody, marketId: "spend-over", outcome: "No", spend: 150 });
    const juliaYes = heldBy(b, julia, "spend-over", 0);
    const codyNo = heldBy(b, cody, "spend-over", 1);

    const yes = b.simulatePayout({ "spend-over": "Yes" });
    expect(yes.players.find((p) => p.name === "Julia")).toMatchObject({ spent: 100, credits: 900, payout: Math.round(juliaYes), final: Math.round(900 + juliaYes) });
    expect(yes.players.find((p) => p.name === "Cody")).toMatchObject({ spent: 150, payout: 0, final: 850, net: -150 });
    expect(yes.maker).toEqual({ collected: 250, paid: Math.round(juliaYes), net: Math.round(250 - juliaYes) });
    expect(yes.markets.find((m) => m.id === "spend-over")).toMatchObject({ outcome: "Yes", chosen: true });

    const no = b.simulatePayout({ "spend-over": "No" });
    expect(no.players.find((p) => p.name === "Cody")?.payout).toBe(Math.round(codyNo));
    expect(no.players.find((p) => p.name === "Julia")?.payout).toBe(0);

    // Simulating settles nothing: credits and prices are exactly as before.
    expect(b.view(julia).player?.credits).toBe(900);
    expect(b.simulatePayout({}).markets.find((m) => m.id === "spend-over")?.chosen).toBe(false);
  });

  it("never costs the market maker more than LMSR's bound, b·ln(1/opening price) of the winner", () => {
    const b = book();
    const [julia = "", cody = ""] = tokensOf(b);
    // A deterministic mix of bets that pushes the price back and forth.
    let seed = 7;
    const next = () => (seed = (seed * 48_271) % 2_147_483_647);
    for (let i = 0; i < 40; i += 1) {
      const token = i % 2 === 0 ? julia : cody;
      const outcome = next() % 3 === 0 ? "No" : "Yes";
      b.bet({ token, marketId: "spend-over", outcome, spend: 10 + (next() % 40) });
    }
    const openingPrices = generateMarkets(plan, -420).find((d) => d.id === "spend-over")?.openingPrices ?? [];
    ["Yes", "No"].forEach((outcome, i) => {
      const loss = -b.simulatePayout({ "spend-over": outcome }).maker.net;
      expect(loss).toBeLessThanOrEqual(LIQUIDITY * Math.log(1 / (openingPrices[i] ?? 1)) + 1);
    });
  });
});
