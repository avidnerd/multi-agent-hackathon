import { AgentActionSchema, PlanSchema, type Divergence, type Plan, type PlanItem, type RepairOption } from "../domain";
import { cascade, type CascadeContext, type CascadePolicy, type CascadeResult } from "./cascade";
import { formatLocalTime, joinNames } from "./format";

export interface AlternativeFlight {
  readonly flightId: string;
  readonly flightNumber: string;
  readonly departsAt: string;
  readonly arrivesAt: string;
  readonly seatsAvailable: number;
  readonly farePerPersonCents: number;
}

export interface RepairContext extends CascadeContext {
  /** Same-route flights the missing people could take instead. */
  readonly alternativeFlights: readonly AlternativeFlight[];
}

export interface RepairProposal {
  readonly option: RepairOption;
  /** The plan as it would stand after this repair, one version up. */
  readonly plan: Plan;
}

const POLICIES: readonly CascadePolicy[] = ["reschedule", "skip"];

function proposal(plan: Plan, id: string, lead: readonly string[], result: CascadeResult, extraCostCents: number, leadActions: RepairOption["actions"]): RepairProposal {
  const summary = [...lead, ...result.changes].join(". ");
  return {
    option: {
      id,
      summary: summary.length > 0 ? `${summary}.` : "Nothing downstream needs to change.",
      affectedPlanItemIds: result.affectedItemIds,
      costDeltaCents: extraCostCents + result.costDeltaCents,
      actions: [...leadActions, ...result.actions],
    },
    plan: PlanSchema.parse({ ...plan, version: plan.version + 1, items: result.items }),
  };
}

/** Two policies can land on the same outcome when nothing was squeezable. Offer it once. */
function distinct(proposals: RepairProposal[]): RepairProposal[] {
  const seen = new Set<string>();
  return proposals.filter((p) => {
    const key = JSON.stringify(p.plan.items);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function acknowledge(plan: Plan, divergence: Divergence): RepairProposal[] {
  const overspend = divergence.kind === "overspend" ? (divergence.observed.costCents ?? 0) - (divergence.expected.costCents ?? 0) : 0;
  return [
    {
      option: { id: `${divergence.id}:acknowledge`, summary: "No plan change needed. Logged for the ledger.", affectedPlanItemIds: [divergence.planItemId], costDeltaCents: overspend, actions: [] },
      plan,
    },
  ];
}

function repairMissedFlight(plan: Plan, root: PlanItem, divergence: Divergence, context: RepairContext): RepairProposal[] {
  const missing = root.participants.filter((p) => !divergence.observed.participants.includes(p));
  if (missing.length === 0) return acknowledge(plan, divergence);
  const names = joinNames(missing.map((m) => context.memberNames[m] ?? m));
  const stayed = root.participants.filter((p) => !missing.includes(p));
  const proposals: RepairProposal[] = [];

  const [alternative] = context.alternativeFlights
    .filter((f) => Date.parse(f.departsAt) > Date.parse(context.now) && f.seatsAvailable >= missing.length)
    .sort((a, b) => Date.parse(a.departsAt) - Date.parse(b.departsAt));

  if (alternative !== undefined) {
    const lands = formatLocalTime(alternative.arrivesAt, context.utcOffsetMinutes);
    const rebookCost = alternative.farePerPersonCents * missing.length;
    const book = AgentActionSchema.parse({
      id: `${divergence.id}:rebook`,
      idempotencyKey: `${divergence.id}:rebook:${alternative.flightId}`,
      requestedAt: context.now,
      reason: `${names} missed ${root.title}`,
      kind: "book_flight",
      params: { flightId: alternative.flightId, memberIds: missing },
    });
    const replacement: PlanItem = {
      id: `${root.id}-rebook`,
      kind: "flight",
      title: `Flight ${alternative.flightNumber}`,
      startsAt: alternative.departsAt,
      endsAt: alternative.arrivesAt,
      costCents: rebookCost,
      participants: missing,
      bookingRef: null,
      inventoryId: alternative.flightId,
      dependsOn: [...root.dependsOn],
    };

    for (const policy of POLICIES) {
      // Everyone missed: the replacement is the whole outbound leg, so move the root instead of splitting it.
      const allMissed = stayed.length === 0;
      const result = cascade(
        {
          plan,
          rootId: root.id,
          root: allMissed ? { ...root, ...replacement, id: root.id, participants: root.participants } : { ...root, participants: stayed, costCents: Math.round((root.costCents / root.participants.length) * stayed.length) },
          added: allMissed ? [] : [replacement],
          unreachable: new Set(),
          policy,
          actionPrefix: `${divergence.id}:${policy}`,
        },
        context,
      );
      proposals.push(proposal(plan, `${divergence.id}:rebook-${policy}`, [`Rebook ${names} on ${alternative.flightNumber}, landing ${lands}`], result, rebookCost, [book]));
    }
  }

  if (stayed.length > 0) {
    const result = cascade(
      {
        plan,
        rootId: root.id,
        root: { ...root, participants: stayed, costCents: Math.round((root.costCents / root.participants.length) * stayed.length) },
        added: [],
        unreachable: new Set(missing),
        policy: "skip",
        actionPrefix: `${divergence.id}:without`,
      },
      context,
    );
    proposals.push(proposal(plan, `${divergence.id}:without`, [`Go ahead without ${names}`], result, 0, []));
  }
  return distinct(proposals);
}

function repairDelayedFlight(plan: Plan, root: PlanItem, divergence: Divergence, context: RepairContext): RepairProposal[] {
  const startsAt = divergence.observed.startsAt;
  const endsAt = divergence.observed.endsAt;
  if (startsAt === null || endsAt === null) return acknowledge(plan, divergence);
  const lands = formatLocalTime(endsAt, context.utcOffsetMinutes);
  return distinct(
    POLICIES.map((policy) =>
      proposal(
        plan,
        `${divergence.id}:${policy}`,
        [policy === "reschedule" ? `${root.title} now lands ${lands}` : `${root.title} now lands ${lands}. Keep the schedule`],
        cascade({ plan, rootId: root.id, root: { ...root, startsAt, endsAt }, added: [], unreachable: new Set(), policy, actionPrefix: `${divergence.id}:${policy}` }, context),
        0,
        [],
      ),
    ),
  );
}

/**
 * Repair options for one divergence. Every option recomputes the plan downstream of the broken
 * item through the dependency graph (see cascade), never by patching items one at a time.
 * Irreversible actions such as rebooking are included as proposals; executing them still needs approval.
 */
export function repairPlan(plan: Plan, divergence: Divergence, context: RepairContext): RepairProposal[] {
  const root = plan.items.find((i) => i.id === divergence.planItemId);
  if (root === undefined) return [];
  if (divergence.kind === "participant_missing" && root.kind === "flight") return repairMissedFlight(plan, root, divergence, context);
  if (divergence.kind === "time_shift" && root.kind === "flight") return repairDelayedFlight(plan, root, divergence, context);
  return acknowledge(plan, divergence);
}
