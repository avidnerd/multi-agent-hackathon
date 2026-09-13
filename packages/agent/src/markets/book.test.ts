import { describe, expect, it } from "vitest";
import type { Plan } from "@trip/core";
import { createMarketBook, generateMarkets, STARTING_CREDITS } from "./book";

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
    expect(b.bet({ token: julia ?? "", marketId: "make-venue-2-cove-kayak", outcome: "No", spend: 25 }).ok).toBe(true);
    const after = b.view(julia ?? null);
    expect(after.markets[1]?.outcomes[1]?.cents).toBeGreaterThan(before);
    expect(after.player).toMatchObject({ name: "Julia", credits: STARTING_CREDITS - 25 });
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
