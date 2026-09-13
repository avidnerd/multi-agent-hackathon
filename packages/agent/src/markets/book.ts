import { err, formatDollars, formatLocalTime, lmsrCost, lmsrPrices, localClock, ok, openingQuantities, sharesForSpend, type MarketKind, type Member, type Plan, type Result } from "@trip/core";

/** Play credits each member starts with. Nothing here is money. */
export const STARTING_CREDITS = 1_000;
/** Market maker liquidity: higher means prices move less per bet. Scaled with credits so a chip moves the price the same share. */
export const LIQUIDITY = 400;
const EARLY_START = "10:00";
const EARLY_FLIGHT = "08:00";
const SPEND_MARGIN_CENTS = 10_000;
const SPEND_ROUNDING_CENTS = 5_000;

export interface MarketDraft {
  readonly id: string;
  readonly kind: MarketKind;
  readonly question: string;
  readonly outcomes: readonly string[];
  readonly openingPrices: readonly number[];
  readonly planItemId: string | null;
}

/**
 * The uncertain points of a booked plan. Opening prices are a rule of thumb (early starts and early
 * flights are riskier), not a model call.
 */
export function generateMarkets(plan: Plan, utcOffsetMinutes: number): MarketDraft[] {
  const drafts: MarketDraft[] = [];
  const outbound = plan.items.find((i) => i.kind === "flight");
  if (outbound !== undefined) {
    const early = localClock(outbound.startsAt, utcOffsetMinutes) < EARLY_FLIGHT;
    drafts.push({ id: `miss-${outbound.id}`, kind: "travel_timing", question: `Does anyone miss ${outbound.title} at ${formatLocalTime(outbound.startsAt, utcOffsetMinutes)}?`, outcomes: ["Yes", "No"], openingPrices: early ? [0.3, 0.7] : [0.15, 0.85], planItemId: outbound.id });
  }
  for (const item of plan.items.filter((i) => i.kind === "reservation")) {
    const early = localClock(item.startsAt, utcOffsetMinutes) < EARLY_START;
    drafts.push({ id: `make-${item.id}`, kind: "behavioral", question: `Does everyone make ${item.title} at ${formatLocalTime(item.startsAt, utcOffsetMinutes)}?`, outcomes: ["Yes", "No"], openingPrices: early ? [0.55, 0.45] : [0.75, 0.25], planItemId: item.id });
  }
  const travellers = new Set(plan.items.flatMap((i) => i.participants)).size;
  if (travellers > 0) {
    const perPerson = plan.items.reduce((sum, i) => sum + i.costCents, 0) / travellers;
    const threshold = Math.ceil((perPerson + SPEND_MARGIN_CENTS) / SPEND_ROUNDING_CENTS) * SPEND_ROUNDING_CENTS;
    drafts.push({ id: "spend-over", kind: "spend_threshold", question: `Does anyone spend over ${formatDollars(threshold)} on the trip?`, outcomes: ["Yes", "No"], openingPrices: [0.35, 0.65], planItemId: null });
  }
  return drafts;
}

interface OpenMarket extends MarketDraft {
  readonly quantities: number[];
  volume: number;
  /** Null for Concorde's suggestions; the member's name for a question they put on the board. */
  readonly createdBy: string | null;
  /** Price after opening and after every bet, for the price chart. */
  readonly history: PricePoint[];
}

export interface PricePoint {
  readonly at: string;
  /** Whole cents per outcome, in outcome order. */
  readonly cents: readonly number[];
  /** Who moved the price, or null for the opening price. */
  readonly by: string | null;
}

/** Enough points to read a trend on a phone without the chart turning into noise. */
const HISTORY_LIMIT = 80;

export interface ProposeInput {
  readonly token: string;
  /** Untrusted member text. Stored and displayed, never sent to a model. */
  readonly question: string;
}

const QUESTION_MIN_CHARS = 8;
const QUESTION_MAX_CHARS = 140;
const MAX_MEMBER_MARKETS = 12;
const EVEN_ODDS = [0.5, 0.5] as const;

interface Player {
  readonly id: string;
  readonly name: string;
  readonly token: string;
  credits: number;
  /** marketId to shares held per outcome. */
  readonly holdings: Map<string, number[]>;
}

export interface BetInput {
  readonly token: string;
  readonly marketId: string;
  readonly outcome: string;
  readonly spend: number;
}

const rejected = (issue: string): Result<never> => err({ kind: "validation_failed", boundary: "user_input", issues: [issue] });

const centsOf = (quantities: readonly number[]): number[] => lmsrPrices(quantities, LIQUIDITY).map((p) => Math.round(p * 100));

export function createMarketBook(drafts: readonly MarketDraft[], members: readonly Pick<Member, "id" | "name">[], newToken: () => string, now: () => Date = () => new Date()) {
  const opened = (quantities: number[]): PricePoint[] => [{ at: now().toISOString(), cents: centsOf(quantities), by: null }];
  const markets: OpenMarket[] = drafts.map((d) => {
    const quantities = openingQuantities(d.openingPrices, LIQUIDITY);
    return { ...d, quantities, volume: 0, createdBy: null, history: opened(quantities) };
  });
  const players: Player[] = members.map((m) => ({ id: m.id, name: m.name, token: newToken(), credits: STARTING_CREDITS, holdings: new Map() }));

  // Holdings are worth what selling them back to the market maker would pay. Valuing at the post-trade
  // price instead would show every bet as an instant profit, since buying pushes the price up.
  const valueOf = (player: Player): number =>
    markets.reduce((sum, m) => {
      const held = player.holdings.get(m.id);
      if (held === undefined) return sum;
      return sum + lmsrCost(m.quantities, LIQUIDITY) - lmsrCost(m.quantities.map((q, i) => q - (held[i] ?? 0)), LIQUIDITY);
    }, 0);

  function bet(input: BetInput): Result<{ shares: number }> {
    const player = players.find((p) => p.token === input.token);
    if (player === undefined) return rejected("That betting link isn't one Concorde sent");
    const market = markets.find((m) => m.id === input.marketId);
    if (market === undefined) return rejected("That market doesn't exist");
    const outcome = market.outcomes.indexOf(input.outcome);
    if (outcome === -1) return rejected(`${input.outcome} isn't an outcome of that market`);
    if (!Number.isInteger(input.spend) || input.spend <= 0) return rejected("Bets are a whole number of credits");
    if (input.spend > player.credits) return rejected(`${player.name} has ${player.credits} credits left`);

    const shares = sharesForSpend(market.quantities, outcome, input.spend, LIQUIDITY);
    market.quantities[outcome] = (market.quantities[outcome] ?? 0) + shares;
    market.volume += input.spend;
    market.history.push({ at: now().toISOString(), cents: centsOf(market.quantities), by: player.name });
    if (market.history.length > HISTORY_LIMIT) market.history.splice(1, market.history.length - HISTORY_LIMIT);
    player.credits -= input.spend;
    const held = player.holdings.get(market.id) ?? market.outcomes.map(() => 0);
    held[outcome] = (held[outcome] ?? 0) + shares;
    player.holdings.set(market.id, held);
    return ok({ shares });
  }

  /** A member's own yes-or-no question, opened at even odds for the whole group to bet on. */
  function propose(input: ProposeInput): Result<{ marketId: string }> {
    const player = players.find((p) => p.token === input.token);
    if (player === undefined) return rejected("That betting link isn't one Concorde sent");
    const text = input.question.replace(/\s+/g, " ").trim();
    if (text.length < QUESTION_MIN_CHARS || text.length > QUESTION_MAX_CHARS) return rejected(`A question needs ${QUESTION_MIN_CHARS} to ${QUESTION_MAX_CHARS} characters`);
    const question = text.endsWith("?") ? text : `${text}?`;
    if (markets.filter((m) => m.createdBy !== null).length >= MAX_MEMBER_MARKETS) return rejected("The board is full. Bet on a question that's already up.");
    if (markets.some((m) => m.question.toLowerCase() === question.toLowerCase())) return rejected("That question is already on the board");
    const id = `member-${markets.length + 1}`;
    const quantities = openingQuantities(EVEN_ODDS, LIQUIDITY);
    markets.push({ id, kind: "behavioral", question, outcomes: ["Yes", "No"], openingPrices: EVEN_ODDS, planItemId: null, quantities, volume: 0, createdBy: player.name, history: opened(quantities) });
    return ok({ marketId: id });
  }

  function view(token: string | null) {
    const player = token === null ? undefined : players.find((p) => p.token === token);
    return {
      startingCredits: STARTING_CREDITS,
      markets: markets.map((m) => {
        const prices = lmsrPrices(m.quantities, LIQUIDITY);
        const held = player?.holdings.get(m.id);
        return { id: m.id, kind: m.kind, question: m.question, createdBy: m.createdBy, volume: m.volume, history: m.history, outcomes: m.outcomes.map((name, i) => ({ name, cents: Math.round((prices[i] ?? 0) * 100), held: held?.[i] ?? 0 })) };
      }),
      player: player === undefined ? null : { name: player.name, credits: player.credits, worth: Math.round(player.credits + valueOf(player)) },
      standings: players.map((p) => ({ name: p.name, worth: Math.round(p.credits + valueOf(p)) })).sort((a, b) => b.worth - a.worth),
    };
  }

  const links = (baseUrl: string) => players.map((p) => ({ memberId: p.id, name: p.name, url: `${baseUrl}/markets?player=${p.token}` }));

  return { bet, propose, view, links };
}

export type MarketBook = ReturnType<typeof createMarketBook>;
