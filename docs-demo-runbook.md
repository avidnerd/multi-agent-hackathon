# Concorde demo runbook

## Demo thesis

> The agent doesn't just make the plan. It watches what actually happens, repairs the plan when reality breaks it, and turns the uncertainty into a prediction market.

Target runtime: **2:00**

Canonical disruption: **Jake misses AA100**

---

## Seeded scenario

### Group

- Organizer
- Jake
- Sarah
- Priya

### Plan

1. AA100 outbound flight
2. Hotel arrival
3. Dinner
4. Evening activity

Later events depend on the flight / arrival timing.

### Primary market

**Will Jake make the 8:00 AM flight?**

- YES: 83¢
- NO: 17¢

Presenter position:

- NO

### Secondary market

Use one market whose crowd price can influence the plan.

Example:

**Will we make the 10:30 AM reservation?**

- YES: 28¢
- NO: 72¢

Expected agent behavior:

- convert the market signal into an `inferred_from_market` constraint
- surface the conflict
- propose moving the event later
- never represent the inference as a stated user preference

---

# Two-minute timeline

## 0:00–0:12 — Hook

### Say

> "I just made $1,000 because my friend missed his flight."

> "No, not through travel insurance. I bet against him."

### Show

Discord market:

**Will Jake make the 8:00 AM flight?**

YES — 83¢  
NO — 17¢

### Do

Show the presenter holding a NO position.

---

## 0:12–0:30 — What Concorde planned

### Say

> "Before the trip, Concorde coordinated our group, turned everyone's messy preferences into actual constraints, and converged on a plan."

> "Then it automatically opened prediction markets around the uncertain parts."

### Show

Plan view.

Keep this quick.

Highlight:

- group members
- one or two constraints
- flight
- hotel
- dinner

Do not walk through the full schedule.

---

## 0:30–0:45 — Markets contain information

### Say

> "But these markets aren't just a game."

> "If all of my friends are betting that there's no chance we'll make a 10:30 reservation, they probably know something the planner doesn't."

### Show

10:30 reservation market:

YES — 28¢  
NO — 72¢

Then show:

`inferred_from_market: morning timing high-risk`

### Say

> "Concorde treats that crowd belief as a new signal and proposes changing the plan — without pretending anyone explicitly asked for it."

---

## 0:45–1:05 — Trip goes live

### Say

> "Then the trip starts."

> "At that point Concorde stops being just a planner and starts monitoring what actually happens."

### Show

Live event stream.

Expected:

- Sarah checked in
- organizer checked in
- Jake not checked in
- AA100 boarding

### Do

Trigger the seeded missed-flight event.

Advance the twin clock until AA100 departs.

---

## 1:05–1:30 — Reality breaks the plan

### Show

Expected:

`Jake aboard AA100`

Observed:

`AA100 departed`

`Jake absent`

Then:

`DIVERGENCE DETECTED`

### Say

> "The plan expected Jake on AA100. Reality says the plane left without him."

> "Because the trip is stored as a dependency graph, Concorde knows this doesn't just break the flight. It can affect everything downstream."

### Expected system behavior

- divergence recorded
- affected downstream events identified
- later flight considered
- dinner timing recomputed

---

## 1:30–1:45 — Market resolves

### Show

Discord:

**MARKET RESOLVED**

Will Jake make AA100?

**NO wins**

Leaderboard updates.

### Say

> "The same observed evidence resolves the market automatically."

> "That's how I got paid."

---

## 1:45–1:55 — Repair creates new uncertainty

### Show

Updated plan:

- Jake moved to later flight
- dinner moved later

Then show new market:

**Will Jake make the new dinner time?**

### Say

> "Concorde repairs the plan — and that repair creates new uncertainty, so a new market appears."

---

## 1:55–2:00 — Close

### Say

> "The plan is only what we think will happen. Concorde handles what actually happens."

Stop.

Do not add another explanation.

---

# Systems visible in the demo

## Twilio

Real people layer.

Use for:

- preference elicitation
- follow-ups
- disruption notifications

Do not spend demo time scrolling through a long SMS conversation.

One real message is enough to establish that it is live.

## Google Calendar

Real people layer.

Use for:

- candidate holds
- confirmed plan
- repaired plan updates

If showing Calendar costs more than five seconds, leave it visible in supporting material rather than opening it during the main run.

## Discord

Real people layer.

Use for:

- markets
- bets
- resolution
- leaderboard

This should be clearly visible during the demo.

## Travel inventory twins

Stateful simulated inventory.

Use for:

- bookings
- check-ins
- departures
- injected missed flight
- spending

Never imply the flight is a real airline booking.

If asked:

> A mock returns a canned answer. Our twins preserve state, so every later action sees the consequences of earlier actions.

---

# Reset procedure

Before every demonstration:

1. Reset inventory twin.
2. Reset controllable clock.
3. Clear injected faults/events.
4. Restore seeded AA100 flight.
5. Restore Jake as booked but not yet checked in.
6. Restore original plan.
7. Restore market prices and presenter position.
8. Restore Discord market message if necessary.
9. Verify live event stream is empty.
10. Verify divergence list is empty.

Do not begin until the initial state matches the seed.

---

# Pre-demo verification

Confirm:

- [ ] Web app loads
- [ ] Seeded plan visible
- [ ] Discord bot online
- [ ] Market visible
- [ ] Presenter bet recorded
- [ ] Twin reset works
- [ ] Twin clock advances
- [ ] Missed-flight event works
- [ ] Market resolves
- [ ] Repair appears
- [ ] New market generates
- [ ] SMS credentials work if SMS is part of the live run
- [ ] Calendar credentials work if Calendar is part of the live run

---

# Failure fallbacks

## Discord fails

Keep the web market board open and demonstrate positions / resolution there.

Explain that Discord is the live interaction surface, but do not troubleshoot Discord during the two-minute demo.

## SMS fails

Do not retry repeatedly.

Show the already-recorded constraint in the UI and continue.

## Calendar fails

Continue using the plan view.

Calendar is supporting proof, not the main demo story.

## Market generation fails

Use the pre-seeded market.

The important live behavior is resolution from observed state.

## Repair fails

Show the divergence and dependency graph first.

If a known-good repaired state can be loaded safely, use it.

Do not manually pretend the system produced an output that it did not produce.

## Twin event fails

Use the deterministic seeded fallback state representing:

- AA100 departed
- Jake absent

The state should still enter through the same observed-event path used by the agent.

---

# What not to explain during the two minutes

Do not spend time on:

- generic travel-planning features
- every constraint type
- every market type
- folder structure
- Prisma
- Next.js
- Zod implementation details
- market-maker equations
- every fault type
- every evaluation metric

Those are judge-Q&A material.

---

# Judge Q&A anchors

## "Isn't this just an AI trip planner?"

No.

Planning establishes the expected state.

The interesting part begins when the trip starts: Concorde observes reality, detects when reality diverges from the plan, repairs dependent events, resolves markets from evidence, and generates new markets around the repaired plan.

## "Why prediction markets?"

Friends possess information the planner may not.

A market aggregates that information into a measurable signal.

Concorde can use that signal as an inferred constraint while preserving the distinction between inferred and explicitly stated preferences.

## "Why twins?"

Travel APIs do not let us reproducibly make Jake miss a flight on command.

Stateful twins give us a resettable world where actions have persistent consequences and failures can be injected intentionally.

That lets us test the agent rather than simply hope the live demo works.

## "What is actually autonomous?"

The agent coordinates elicitation, convergence, plan creation, external actions, monitoring, divergence detection, repair, market resolution, and regeneration.

Irreversible actions still cross a hard human approval gate.

## "Where does AI end?"

AI interprets ambiguous human language and handles bounded generative decisions.

Deterministic code owns planning invariants, dependency propagation, safety gates, settlement logic, and other behavior that needs predictable correctness.

---

# Final line

> **The plan is only what we think will happen. Concorde handles what actually happens.**