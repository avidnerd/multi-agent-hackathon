# Concorde

Concorde is a multi-app AI agent for group travel planning that coordinates people, creates a shared trip plan, monitors the trip once it starts, adapts when reality changes, and turns uncertain moments into social prediction markets.

Instead of stopping after generating a schedule, Concorde stays active throughout the trip. It gathers constraints from the group, converges on a feasible plan even when some members do not respond, creates prediction markets from uncertain parts of the plan, observes real-world events, resolves markets from ground truth, and replans when disruptions occur.

## Core capabilities

- Collects travel preferences and constraints from group members through private messaging
- Handles partial responses and follows up with non-responders
- Produces a feasible group travel plan from dates, budgets, timing, and user restrictions
- Requires explicit approval before irreversible actions
- Generates prediction markets from uncertain points in the plan
- Lets friends place bets through Discord
- Uses market prices as additional signals without overriding stated preferences
- Monitors trip state once travel begins
- Detects when reality diverges from the plan
- Recomputes downstream plans after disruptions
- Resolves markets from observed ground truth
- Creates new markets when replanning introduces new uncertainty
- Maintains a leaderboard across the trip

## Example markets

Markets are generated automatically from the current plan rather than created manually.

Examples include:

- Will everyone make the flight?
- Will the group spend more than $1,000 on food?
- Will the group make the 10:30 AM reservation?
- Which activity will receive the highest group rating?
- Will a specific friend be late?
- Will the group exceed a planned category budget?

The prediction market is designed as a social layer on top of the planning agent. Friends often possess information about each other's behavior that a planning model does not.

## How it works

```text
Group preferences and constraints
            |
            v
     Constraint elicitation
            |
            v
   Feasible option generation
            |
            v
        Group plan
            |
            v
      Confirmation gate
            |
            v
        Booking layer
            |
            v
     Market generation
            |
            v
     Friends place bets
            |
            v
      Live monitoring
            |
            v
    Ground-truth events
            |
     +------+------+
     |             |
     v             v
Market resolution  Divergence detection
                         |
                         v
                    Plan repair
                         |
                         v
                  New uncertainty
                         |
                         v
                   New markets
```

## Architecture

Concorde separates the system into two layers.

### People layer

The people-facing layer uses real integrations where the product interacts directly with users.

| Integration | Purpose |
|---|---|
| Twilio SMS | Preference collection, follow-ups, and disruption notifications |
| Discord | Prediction markets, bets, resolutions, and leaderboard |
| Google Calendar | Candidate holds, confirmed plan events, and plan updates |

### Inventory layer

Travel inventory is represented using stateful API twins for flights, hotels, reservations, check-in state, and spending.

These are not static mocks. Each twin maintains state, so later actions observe the consequences of earlier actions. For example, a booking changes available inventory, a check-in changes passenger state, and a departure consults that state.

The inventory layer is twinned because production airline and hotel inventory APIs are difficult to provision for a short hackathon build, while the demo and evaluation suite require reproducible disruptions such as missed flights, stale reads, timeouts, and duplicate events.

## Agent lifecycle

The agent is implemented as a sequence of typed, independently testable steps rather than one large prompt.

### Before the trip

1. **Intake** - create the trip skeleton from organizer input
2. **Elicit** - ask members for constraints through private SMS
3. **Chase** - follow up with non-responders
4. **Converge** - compute feasible options under partial information
5. **Plan** - convert the selected option into a dependency-aware plan
6. **Confirm** - require organizer approval before irreversible actions
7. **Book** - execute inventory writes with idempotency protection
8. **Generate markets** - identify uncertain parts of the plan
9. **Read prices** - convert closing market prices into inferred constraints when useful

### During the trip

10. **Monitor** - observe state changes from external systems
11. **Detect** - compare observed state against expected state
12. **Repair** - recompute all affected downstream plan items
13. **Notify** - update affected members
14. **Resolve** - settle markets from observed ground truth
15. **Regenerate** - create new markets from new uncertainty

## Constraint handling

User preferences are represented as typed constraints rather than raw text.

Examples include:

- Date exclusions
- Budget ceilings
- Earliest acceptable times
- Dietary restrictions
- Activity preferences
- Hard requirements

Constraints also retain their source:

- `stated`
- `inferred_from_market`
- `default_applied`

A market-derived signal may influence the agent's recommendation, but it is never treated as if a user explicitly stated it.

## Planning under partial information

Concorde does not require every group member to respond before making progress.

The planner can:

- Generate feasible options from the information currently available
- Identify which person or missing constraint is blocking a decision
- Ask the single question that most reduces uncertainty
- Apply clearly announced defaults after a response threshold is exceeded

This prevents one silent group member from blocking the entire trip.

## Prediction markets

Markets are generated from uncertain nodes in the plan.

Supported market categories include:

- Travel timing
- Spending thresholds
- Activity preference
- Behavioral outcomes
- Budget allocation

Opening prices are generated separately from market creation.

Closing prices may become additional planning signals. For example, if the group collectively prices the probability of making a 10:30 AM beach reservation below 50%, the agent can surface that signal and propose moving the reservation later.

The agent never silently changes a stated user constraint because of a market price.

## Disruption handling

The plan is modeled as a dependency graph.

If a flight is delayed or missed, Concorde does not patch a single event in isolation. It recomputes every downstream item that depends on the disrupted event.

A disruption can trigger:

- Divergence detection
- Repair option generation
- Calendar updates
- User notifications
- Market resolution
- New prediction markets

Irreversible repairs still require explicit approval.

## System and reliability brief

Reliability is treated as a core system property rather than a demo-layer concern.

### Stateful twins

The system uses stateful twins for travel inventory so tests can exercise realistic sequences of actions instead of receiving canned responses.

The twins support:

- Stateful writes and reads
- A controllable clock
- Deterministic reset
- Event injection
- Fault injection
- Request and response logs
- Realistic status codes and error shapes

Supported failure modes include:

- Empty `200` responses
- Write-then-timeout failures
- Rate limiting
- Duplicate webhooks
- Stale reads
- Partial batch success
- Slow responses

### Irreversible-action gate

Every action is classified as either:

- `REVERSIBLE`
- `IRREVERSIBLE`

Irreversible actions require a recorded approval token before execution. This rule is enforced in the action dispatcher rather than delegated to an LLM prompt.

### Idempotency

Every external write carries an idempotency key.

This protects against duplicate bookings, double charges, and retry-related duplication when a request succeeds remotely but the response is lost.

### Typed boundaries

All external inputs and outputs are validated.

Zod schemas are used for:

- User input
- API responses
- Twin responses
- Webhooks
- LLM outputs

LLM responses that fail validation are rejected and retried with the validation error provided back to the model.

### Untrusted user text

SMS and Discord content is treated as untrusted data.

User-generated text is explicitly delimited when passed to a model and is never allowed to become system instruction. Prompt-injection scenarios are included in the evaluation plan.

### Ambiguous outcomes

Markets are not resolved when the observed evidence is insufficient.

Ambiguous outcomes escalate to a human instead of being guessed.

### Observability

Every agent action is traced with:

- Inputs
- Outputs
- Latency
- Retries
- Model usage
- Cost

Twin request logs provide additional evidence for external interactions.

## Evaluation

The evaluation suite runs against resettable twins so scenarios can be repeated consistently without sending real messages or creating real external side effects.

Planned evaluation areas include:

### Convergence under partial responses

Measure how often the system reaches a feasible and optimal plan at different group response rates.

Metrics include:

- Feasible-option rate
- Optimal-option rate
- Message count

### Constraint extraction

Measure precision and recall against labeled freeform messages, including difficult cases such as:

- Soft preferences phrased as hard requirements
- Constraints buried in unrelated text
- Contradictory user messages

### Repair correctness

Inject disruptions and verify that:

- Every downstream dependency is recomputed
- No orphaned bookings remain
- Repairs do not modify unrelated plan items

### Market calibration

Compare agent opening prices and crowd closing prices against actual outcomes using Brier score.

### Invariant checks

The system should never:

- Execute an irreversible action without approval
- Promote an inferred constraint to a stated constraint
- Resolve an ambiguous market automatically
- Contact an opted-out member
- Double-book or double-charge under retry

Evaluation results should be added only after they are produced by the final evaluation suite.

## Chaos testing

The system is designed to be tested under injected faults across the full agent loop.

Failures are categorized by:

- Frequency
- Observable symptom
- Root cause
- Current mitigation
- Remaining limitation

The goal is not to claim that every failure is eliminated. Known and reproducible limitations are documented rather than hidden.

## Tech stack

- TypeScript
- Next.js App Router
- SQLite
- Prisma
- Zod
- Vitest
- pnpm
- Twilio
- Discord
- Google Calendar

Core planning logic is isolated from framework and network code so it can be tested deterministically.

## Project structure

```text
apps/
  web/          Web interface

packages/
  core/         Domain model and pure planning logic
  agent/        Agent orchestration and model calls
  twins/        Stateful external-system twins
  eval/         Evaluation and chaos-testing harness
```

## Scope

The hackathon implementation focuses on:

- One group of 4-6 people
- One destination
- A 2-3 day trip
- Dates within a defined window
- Budget allocation
- Timing of scheduled items

The project intentionally does not attempt to solve:

- Multi-city routing
- Production flight or hotel search
- Visa logic
- Packing lists
- Restaurant discovery
- Seat selection
- Loyalty programs

## Design principles

1. The planner is the primary product; prediction markets extend it rather than replace it.
2. Real user interactions should remain real wherever practical.
3. Inventory simulations must be stateful and transparent.
4. Irreversible actions require explicit approval.
5. User text is data, never instruction.
6. Repairs propagate through dependencies rather than patching isolated events.
7. Inferred information is never presented as explicitly stated information.
8. Reliability claims should be backed by traces, tests, and reproducible scenarios.

## Status

Hackathon prototype in development.

Evaluation metrics and the final failure taxonomy will be added after the complete evaluation and chaos suites are run.
