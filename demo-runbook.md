# Concorde demo runbook

## Status

Nothing in this repo is implemented yet — only `README.md` and the build prompt exist. This runbook is the **target script for the full build**. Every claim below is tagged with the build-prompt stage it depends on. Before presenting, check off only the stages actually finished; degrade gracefully (narrate over static screens/screenshots) for anything past the last completed stage. Do not fake a claim you can't currently produce live.

## Demo thesis

> The agent doesn't just make the plan. It watches what actually happens, repairs the plan when reality breaks it, and turns the uncertainty into a prediction market that feeds back into the plan.

Target runtime: **2:00**
Canonical disruption: **Jake misses AA100**
Final line: **"Every trip creates uncertainty. We turned it into both a game and a sensor. And it just made me $1,000."**

---

## Reconciliation table

| Demo claim | Depends on (stage) | Implemented? | Proof on screen | Backup |
|---|---|---|---|---|
| SMS elicitation converges to a plan with partial responses | Stage 3 | Not yet built | Plan view: "waiting on Priya" | Pre-seed the finished plan; skip live elicitation |
| Confirmation gate blocks an unapproved booking | Stage 4 | Not yet built | Gate error in UI/logs | Narrate only; show the dispatcher check in code if asked |
| Market generated from the plan's dependency graph | Stage 5 | Not yet built | Discord market card | Pre-seed markets exactly as designed |
| Bet placed via Discord `/bet` | Stage 5 | Not yet built | Discord message | Pre-seed presenter's NO position; place live only if bot is confirmed online |
| Live monitor loop / event stream | Stage 6 | Not yet built | Event stream ticking | Pre-scripted event log replay through the same code path |
| Injected missed-flight event via twin | Stage 1 + 6 | Not yet built | `_twin/event` + `_twin/clock` calls, stream updates | Load a canned "departed, Jake absent" snapshot through the same observed-event path |
| Divergence detection | Stage 2 (`detectDivergence`) + 6 | Not yet built | "DIVERGENCE DETECTED" banner | Static screenshot of the banner |
| Market resolves from ground truth | Stage 6 | Not yet built | Market card flips to resolved NO, leaderboard updates | Mark resolved manually, say it happens automatically from the same event |
| Cascade repair through dependency graph | Stage 2 (`repairPlan`) + 6 | Not yet built | Plan diff: dinner shifts, hotel untouched | Before/after static diagram |
| New market from repaired plan | Stage 5 (regen) + 6 | Not yet built | New market posted to Discord | Pre-seeded second market shown as "here's what that looks like" |
| Real SMS send/receive | Stage 3 | Not yet built | Phone buzzes | Cut from the 2-minute demo regardless; screenshot only |
| Real Google Calendar events | Stage 4 | Not yet built | Calendar event | Cut from the 2-minute demo; pre-seed events instead |

---

## Seeded scenario

### Group
- Organizer (you)
- Jake
- Sarah
- Priya

### Constraints
- Sarah: no Friday (hard), budget ceiling $1,000 (soft), nothing before 9am (soft)
- Jake: flexible
- Priya: unresponsive past threshold → one constraint marked `source: default_applied`, shown as such in the UI

### Plan
Miami, Oct 11–13. Dependency chain: **AA100 flight → hotel check-in → dinner → evening activity.**

### Twin state
AA100 booked with Jake as a passenger, not checked in. Seat inventory decremented to reflect the group's bookings. Clock parked ~15 minutes before scheduled departure so one clock advance triggers departure.

### Primary market
**Will Jake make the 8:00 AM flight?** YES 83¢ / NO 17¢. Presenter position: **NO**.

### Secondary market (only if time/stage allows)
**Will we make the 10:30 AM reservation?** YES 28¢ / NO 72¢. Conflict with the plan already surfaced (`inferred_from_market: morning timing high-risk`) — point at it, don't trigger it live.

---

## Two-minute timeline

**0:00–0:10 — Hook**
> "I made $1,000 last month because my friend missed his flight. No — not travel insurance. I bet against him."
Screen: primary market card, presenter's NO position visible.

**0:10–0:22 — What Concorde did before the trip**
> "Before the trip, Concorde texted our group individually, converged on a plan even though two of us barely replied, and automatically opened prediction markets around everything that could go wrong."
Screen: plan view (2 seconds, do not scroll through the schedule).

**0:22–0:35 — The market is information, not a game**
> "I know Jake. So did everyone else — this market closed at 83 cents yes, and I took the other side."
Screen: Discord market card.

**0:35–0:48 — Trip goes live**
> "Then the trip starts, and Concorde stops planning and starts watching — real check-ins, real flight status, against the plan it made."
Screen: live event stream — Sarah checked in, organizer checked in, Jake not checked in.

**0:48–1:05 — Reality breaks the plan**
> "Watch this." *(trigger missed-check-in event, advance twin clock)* "AA100 just departed. Jake never checked in. The agent expected him on this plane and just observed that he isn't."
Screen: EXPECTED vs OBSERVED → DIVERGENCE DETECTED.
Action: `POST /_twin/event` (missed_check_in, Jake) → `POST /_twin/clock` (advance to departure).

**1:05–1:20 — Resolution and repair**
> "The market resolves itself from that same evidence — no. And because the plan is a dependency graph, Concorde already knows what else this breaks: Jake moves to the next flight, dinner shifts back, and nothing untouched gets touched."
Screen: market flips to resolved NO → plan diff (dinner shifts, hotel unchanged).

**1:20–1:35 — New uncertainty, new market**
> "That repaired plan has its own uncertainty now — a new market just opened: will Jake make the new dinner time. That's the actual loop: plan, uncertainty, market, reality, repair, new uncertainty, new market."
Screen: loop diagram.

**1:35–1:50 — Reliability, one breath**
> "Everyone we message — Twilio, Discord, Calendar — is real. Flights and hotels are a stateful twin we built ourselves, because no airline API lets you make a passenger miss a flight in twenty seconds on command."

**1:50–2:00 — Final line**
> "Every trip creates uncertainty. We turned it into both a game and a sensor. And it just made me $1,000."

---

## Live vs. pre-seeded

- **Live, if the stage is built:** twin event injection, clock advance, divergence banner, market resolution, repair diff, new market post.
- **Always pre-seeded:** the group, the plan, the opening market and price, the presenter's position, Discord channel history before the trigger.
- **Never live in the 2 minutes:** real SMS send/receive, real Calendar writes, the eval suite, chaos/fault injection. Proof-on-request in Q&A, not proof-on-stage.
- **Prerecorded-only fallback:** a <20s screen capture of the full missed-flight → repair → new-market sequence, held in reserve for total live failure, never presented as live.

---

## Reset procedure

Run before every rehearsal and before the real demo:

1. Reset inventory twin.
2. Reset controllable clock.
3. Clear injected faults/events.
4. Restore seeded AA100 flight (Jake booked, not checked in).
5. Restore original plan.
6. Restore market prices and presenter position.
7. Restore Discord market message if needed.
8. Verify the live event stream is empty.
9. Verify the divergence list is empty.

Do not begin the run until state matches the seed exactly.

## Pre-demo verification

- [ ] Web app loads
- [ ] Seeded plan visible
- [ ] Discord bot online
- [ ] Primary market visible with presenter's bet recorded
- [ ] Twin reset works
- [ ] Twin clock advances
- [ ] Missed-flight event works end to end
- [ ] Market resolves automatically
- [ ] Repair appears in plan view
- [ ] New market generates
- [ ] SMS credentials valid (only if SMS is part of the live run)
- [ ] Calendar credentials valid (only if Calendar is part of the live run)

## Failure fallbacks

**Discord fails** — keep the web market board open, demonstrate positions/resolution there. Don't troubleshoot Discord on stage.
**SMS fails** — don't retry. Show the already-recorded constraint in the UI and continue.
**Calendar fails** — continue on the plan view; Calendar is supporting proof, not the main story.
**Market generation fails** — use the pre-seeded market. The important live behavior is resolution from observed state, not generation.
**Repair fails** — show the divergence and dependency graph. If a known-good repaired state can be loaded safely, load it. Never present output the system didn't actually produce.
**Twin event fails** — use the deterministic canned snapshot (AA100 departed, Jake absent) fed through the same observed-event path the agent normally consumes.

## What not to explain in the two minutes

Generic travel-planning features, every constraint/market type, folder structure, Prisma, Next.js, Zod internals, market-maker math, every fault type, every eval metric. All of it is Q&A material.

## Judge Q&A anchors

**"Isn't this just an AI trip planner?"** No — planning is the least interesting part. The product starts when the trip starts: observe reality, detect divergence from the plan, repair downstream through the dependency graph, resolve markets from that same evidence.

**"Why prediction markets?"** Friends know things about each other the planner doesn't. The market turns that into a measurable signal Concorde can act on as an inferred constraint — never silently overriding something a person actually said.

**"Why twins?"** No real airline/hotel API lets you force a missed flight on command. Twins hold state, not canned responses, so we can inject faults, reset to a known seed, and run the eval suite hundreds of times.

**"What is actually autonomous?"** Deciding the single question that most reduces uncertainty under partial response, executing reversible repairs across the dependency graph unprompted, resolving markets from observed evidence. Irreversible actions still cross a hard human approval gate.

**"Where does AI end?"** AI interprets ambiguous language and drafts bounded content (constraints, market questions/prices, repair proposals). Deterministic code owns feasibility, dependency cascade, the approval gate, idempotency, and settlement.

**"What happens when the agent is wrong?"** Irreversible actions are blocked without an approval token at the dispatcher level; ambiguous market outcomes escalate to a human instead of being guessed; inferred constraints never silently override stated ones; every action is traced. We publish a failure taxonomy rather than claim nothing breaks.

## Final line

> **Every trip creates uncertainty. We turned it into both a game and a sensor. And it just made me $1,000.**
