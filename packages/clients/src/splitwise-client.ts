import { z } from "zod";
import { err, ok, type Result } from "@trip/core";
import { httpRequest, type FetchLike } from "./http";

export const SPLITWISE_API_BASE_URL = "https://secure.splitwise.com/api/v3.0";
const CENTS_PER_DOLLAR = 100;
const MAX_DETAIL_CHARS = 300;

export interface SplitwiseMember {
  readonly email: string;
  readonly firstName: string;
  readonly lastName: string;
}

export interface SplitwiseExpense {
  readonly description: string;
  readonly costCents: number;
  readonly participantEmails: readonly string[];
}

export interface SplitwiseTrip {
  readonly groupName: string;
  readonly members: readonly SplitwiseMember[];
  readonly expenses: readonly SplitwiseExpense[];
}

export interface RecordedTrip {
  readonly groupId: number;
  readonly groupUrl: string;
  readonly expenses: number;
}

export interface SplitwiseClient {
  /** Creates a trip group with every member and one expense per booked item. Not idempotent at Splitwise. */
  recordTrip(trip: SplitwiseTrip): Promise<Result<RecordedTrip>>;
}

// Splitwise answers validation problems with 200 and an `errors` object, so success needs both a body and no errors.
const ErrorsSchema = z.union([z.record(z.string(), z.unknown()), z.array(z.unknown())]).nullish();
const CurrentUserSchema = z.object({ user: z.object({ id: z.number(), email: z.string() }) });
const GroupSchema = z.object({ group: z.object({ id: z.number() }).nullish(), errors: ErrorsSchema });
const ExpenseSchema = z.object({ expenses: z.array(z.object({ id: z.number() })).nullish(), errors: ErrorsSchema });

const problemIn = (errors: unknown): string | null => {
  if (errors === undefined || errors === null) return null;
  const text = JSON.stringify(errors);
  return text === "{}" || text === "[]" ? null : text.slice(0, MAX_DETAIL_CHARS);
};
const dollars = (cents: number): string => (cents / CENTS_PER_DOLLAR).toFixed(2);

/** Even split in cents; leftover cents go to the first people so shares add up to the cost exactly. */
export function splitCents(totalCents: number, people: number): number[] {
  const base = Math.floor(totalCents / people);
  const leftover = totalCents - base * people;
  return Array.from({ length: people }, (_, i) => base + (i < leftover ? 1 : 0));
}

export function createSplitwiseClient(config: { readonly apiKey: string; readonly baseUrl?: string; readonly timeoutMs?: number }, fetchImpl: FetchLike = fetch): SplitwiseClient {
  const base = config.baseUrl ?? SPLITWISE_API_BASE_URL;
  const headers = { authorization: `Bearer ${config.apiKey}` };
  const post = <T>(path: string, form: Record<string, string>, schema: z.ZodType<T>, resource: string) =>
    httpRequest(fetchImpl, { service: "splitwise", method: "POST", url: `${base}${path}`, headers, body: { kind: "form", value: form }, schema, resource, timeoutMs: config.timeoutMs });
  const rejected = (detail: string): Result<never> => err({ kind: "upstream_failed", service: "splitwise", status: null, detail });

  return {
    recordTrip: async (trip) => {
      const me = await httpRequest(fetchImpl, { service: "splitwise", method: "GET", url: `${base}/get_current_user`, headers, schema: CurrentUserSchema, resource: "the Splitwise account", timeoutMs: config.timeoutMs });
      if (!me.ok) return me;
      const payerId = String(me.value.user.id);
      const payerEmail = me.value.user.email.toLowerCase();

      const groupForm: Record<string, string> = { name: trip.groupName, group_type: "trip", simplify_by_default: "true" };
      trip.members
        .filter((m) => m.email.toLowerCase() !== payerEmail)
        .forEach((m, i) => {
          groupForm[`users__${i}__email`] = m.email;
          groupForm[`users__${i}__first_name`] = m.firstName;
          groupForm[`users__${i}__last_name`] = m.lastName;
        });
      const group = await post("/create_group", groupForm, GroupSchema, `Splitwise group ${trip.groupName}`);
      if (!group.ok) return group;
      const groupId = group.value.group?.id;
      const groupProblem = problemIn(group.value.errors);
      if (groupProblem !== null || groupId === undefined) return rejected(groupProblem ?? "Splitwise did not create the group");

      let recorded = 0;
      for (const expense of trip.expenses) {
        const emails = [...new Set(expense.participantEmails.map((e) => e.toLowerCase()))];
        if (emails.length === 0 || expense.costCents <= 0) continue;
        const shares = splitCents(expense.costCents, emails.length);
        const form: Record<string, string> = { cost: dollars(expense.costCents), description: expense.description, group_id: String(groupId), currency_code: "USD" };
        // The account behind the API key paid for everything up front; each participant owes their share.
        let slot = 0;
        if (!emails.includes(payerEmail)) {
          form[`users__${slot}__user_id`] = payerId;
          form[`users__${slot}__paid_share`] = dollars(expense.costCents);
          form[`users__${slot}__owed_share`] = "0.00";
          slot += 1;
        }
        emails.forEach((email, i) => {
          const isPayer = email === payerEmail;
          const key = `users__${slot + i}__`;
          if (isPayer) form[`${key}user_id`] = payerId;
          else form[`${key}email`] = email;
          form[`${key}paid_share`] = isPayer ? dollars(expense.costCents) : "0.00";
          form[`${key}owed_share`] = dollars(shares[i] ?? 0);
        });
        const created = await post("/create_expense", form, ExpenseSchema, `Splitwise expense ${expense.description}`);
        if (!created.ok) return created;
        const problem = problemIn(created.value.errors);
        if (problem !== null) return rejected(`${expense.description}: ${problem}`);
        recorded += 1;
      }
      return ok({ groupId, groupUrl: `https://secure.splitwise.com/#/groups/${groupId}`, expenses: recorded });
    },
  };
}
