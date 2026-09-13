# Concorde demo runbook (recorded video)

## Status

Nothing in this repo is implemented yet — only `README.md` and the build prompt exist. This is the **shot list and voiceover script for the submission video**, tagged with the build-prompt stage each shot depends on. Record real screen capture for whatever stage is actually done; for anything past the last completed stage, cut in a static graphic instead of faking a live shot. Never caption a static graphic as if it were a live run.

Because this is edited, not live, you get retakes and you can record segments out of order. Use that: get every stage-dependent shot working and captured in isolation, then assemble.

## Demo thesis

> The agent doesn't just make the plan. It watches what actually happens, repairs the plan when reality breaks it, and turns the uncertainty into a prediction market that feeds back into the plan.

Target runtime: **2:00**
Canonical disruption: **Jake misses AA100**
Final line (voiceover, last shot): **"Every trip creates uncertainty. We turned it into both a game and a sensor. And it just made me $1,000."**

---

## Reconciliation table

| Shot | Depends on (stage) | Implemented? | Capture as | If not ready by recording time |
|---|---|---|---|---|
| SMS elicitation converges to a plan with partial responses | Stage 3 | Not yet built | Screen recording, plan view: "waiting on Priya" | Static graphic of the finished plan |
| Confirmation gate blocks an unapproved booking | Stage 4 | Not yet built | Not shown on screen — mentioned in voiceover only | — |
| Market generated from the plan's dependency graph | Stage 5 | Not yet built | Screen recording, Discord market card | Static mock of the card, labeled clearly in your own notes as staged (not in the video itself) |
| Bet placed via Discord `/bet` | Stage 5 | Not yet built | Screen recording of the actual bet | Skip the action shot, cut straight to the resulting card |
| Live monitor loop / event stream | Stage 6 | Not yet built | Screen recording, stream ticking | Recorded replay of a scripted event log through the real code path (not hand-typed) |
| Injected missed-flight event via twin | Stage 1 + 6 | Not yet built | Screen recording: terminal `_twin/event` + `_twin/clock` calls, UI updates | Recorded run of a canned snapshot through the same observed-event path |
| Divergence detection | Stage 2 (`detectDivergence`) + 6 | Not yet built | Screen recording, "DIVERGENCE DETECTED" banner appearing | Static graphic of the banner |
| Market resolves from ground truth | Stage 6 | Not yet built | Screen recording, card flips to resolved NO | Static before/after of the card |
| Cascade repair through dependency graph | Stage 2 (`repairPlan`) + 6 | Not yet built | Screen recording, plan diff | Static before/after diagram |
| New market from repaired plan | Stage 5 (regen) + 6 | Not yet built | Screen recording, new Discord post | Static mock of the second card |
| Real SMS send/receive | Stage 3 | Not yet built | Not in the 2-minute cut regardless | — |
| Real Google Calendar events | Stage 4 | Not yet built | Not in the 2-minute cut regardless | — |

Rule of thumb: if a row says "static graphic" for more than 2–3 rows by the time you record, the video is carrying more narrative than the build supports — cut the corresponding beat from the script rather than dress it up.

---

## Seeded scenario (state to load before every take)

### Group
Organizer (you), Jake, Sarah, Priya.

### Constraints
Sarah: no Friday (hard), budget ceiling $1,000 (soft), nothing before 9am (soft). Jake: flexible. Priya: unresponsive past threshold → one constraint marked `source: default_applied`, visibly labeled as such in the UI.

### Plan
Miami, Oct 11–13. Dependency chain: **AA100 flight → hotel check-in → dinner → evening activity.**

### Twin state
AA100 booked with Jake as a passenger, not checked in. Clock parked ~15 minutes before scheduled departure so one clock advance triggers departure — keeps the take short.

### Primary market
**Will Jake make the 8:00 AM flight?** YES 83¢ / NO 17¢. Recorded position: **NO**.

### Secondary market (only if it fits and Stage 5's steering behavior is done)
**Will we make the 10:30 AM reservation?** YES 28¢ / NO 72¢, with the plan conflict already surfaced (`inferred_from_market: morning timing high-risk`).

---

## Shot list and voiceover script

Record voiceover separately from screen capture — narrate over B-roll of the running app rather than talking live while clicking. It gives you control over pacing in the edit and means a slow click or a stray cursor never forces a retake of the whole take.

**Shot 1 (0:00–0:10) — Hook**
VO: "I made $1,000 last month because my friend missed his flight. No — not travel insurance. I bet against him."
Capture: primary market card, recorded position visible.

**Shot 2 (0:10–0:22) — What Concorde did before the trip**
VO: "Before the trip, Concorde texted our group individually, converged on a plan even though two of us barely replied, and automatically opened prediction markets around everything that could go wrong."
Capture: plan view, 2 seconds on screen, no scrolling through the schedule.

**Shot 3 (0:22–0:35) — The market is information, not a game**
VO: "I know Jake. So did everyone else — this market closed at 83 cents yes, and I took the other side."
Capture: Discord market card.

**Shot 4 (0:35–0:48) — Trip goes live**
VO: "Then the trip starts, and Concorde stops planning and starts watching — real check-ins, real flight status, against the plan it made."
Capture: live event stream — Sarah checked in, organizer checked in, Jake not checked in.

**Shot 5 (0:48–1:05) — Reality breaks the plan**
VO: "AA100 just departed. Jake never checked in. The agent expected him on this plane and just observed that he isn't."
Capture: terminal triggering `_twin/event` (missed_check_in, Jake) then `_twin/clock` advance, cut to EXPECTED vs OBSERVED → DIVERGENCE DETECTED in the UI.

**Shot 6 (1:05–1:20) — Resolution and repair**
VO: "The market resolves itself from that same evidence — no. And because the plan is a dependency graph, Concorde already knows what else this breaks: Jake moves to the next flight, dinner shifts back, and nothing untouched gets touched."
Capture: market card flips to resolved NO → plan diff (dinner shifts, hotel unchanged).

**Shot 7 (1:20–1:35) — New uncertainty, new market**
VO: "That repaired plan has its own uncertainty now — a new market just opened: will Jake make the new dinner time. That's the actual loop: plan, uncertainty, market, reality, repair, new uncertainty, new market."
Capture: new Discord post, then cut to the loop diagram (this one can be a designed graphic, not screen capture).

**Shot 8 (1:35–1:50) — Reliability, one breath**
VO: "Everyone we message — Twilio, Discord, Calendar — is real. Flights and hotels are a stateful twin we built ourselves, because no airline API lets you make a passenger miss a flight in twenty seconds on command."
Capture: quick cut across the three real integrations (an actual Discord channel, an actual Calendar event, an actual SMS thread) — three still frames, half a second each, not full screen recordings.

**Shot 9 (1:50–2:00) — Final line**
VO: "Every trip creates uncertainty. We turned it into both a game and a sensor. And it just made me $1,000."
Capture: hold on the loop diagram or fade to a title card.

---

## Reset procedure (between takes)

Run before every take of a shot that touches live state, so takes are comparable and re-cuttable:

1. Reset inventory twin.
2. Reset controllable clock.
3. Clear injected faults/events.
4. Restore seeded AA100 flight (Jake booked, not checked in).
5. Restore original plan.
6. Restore market prices and recorded position.
7. Restore Discord market message if needed.
8. Verify the live event stream is empty.
9. Verify the divergence list is empty.

Don't start a take until state matches the seed exactly — mismatched state across takes is the easiest way to end up with an edit that visibly doesn't add up.

## Pre-recording checklist

- [ ] Web app loads
- [ ] Seeded plan visible
- [ ] Discord bot online
- [ ] Primary market visible with recorded bet
- [ ] Twin reset works
- [ ] Twin clock advances
- [ ] Missed-flight event works end to end
- [ ] Market resolves automatically
- [ ] Repair appears in plan view
- [ ] New market generates
- [ ] Screen resolution/aspect ratio matches your intended export (1920x1080 unless the submission platform says otherwise)
- [ ] Cursor size/highlighting is legible at the video's final playback size
- [ ] Voiceover recorded in a quiet room, levels checked, no room echo

## If a shot won't record cleanly

Don't burn a retake budget chasing a flaky feature the night before submission. For any shot in the reconciliation table marked "not ready," swap in the static-graphic version and move on — a static graphic clearly used once or twice reads as normal editorial pacing; a demo that visibly stalls or shows an error reads as broken software. Cut, don't debug, on a deadline.

## What not to put in the video

Generic travel-planning explanation, every constraint/market type, folder structure, Prisma, Next.js, Zod internals, market-maker math, every fault type, every eval metric. Save all of it for the written submission or live Q&A.

## Anticipated questions (for the written submission / any live Q&A after screening)

**"Isn't this just an AI trip planner?"** No — planning is the least interesting part. The product starts when the trip starts: observe reality, detect divergence from the plan, repair downstream through the dependency graph, resolve markets from that same evidence.

**"Why prediction markets?"** Friends know things about each other the planner doesn't. The market turns that into a measurable signal Concorde can act on as an inferred constraint — never silently overriding something a person actually said.

**"Why twins?"** No real airline/hotel API lets you force a missed flight on command. Twins hold state, not canned responses, so we can inject faults, reset to a known seed, and run the eval suite hundreds of times.

**"What is actually autonomous?"** Deciding the single question that most reduces uncertainty under partial response, executing reversible repairs across the dependency graph unprompted, resolving markets from observed evidence. Irreversible actions still cross a hard human approval gate.

**"Where does AI end?"** AI interprets ambiguous language and drafts bounded content (constraints, market questions/prices, repair proposals). Deterministic code owns feasibility, dependency cascade, the approval gate, idempotency, and settlement.

**"What happens when the agent is wrong?"** Irreversible actions are blocked without an approval token at the dispatcher level; ambiguous market outcomes escalate to a human instead of being guessed; inferred constraints never silently override stated ones; every action is traced. We publish a failure taxonomy rather than claim nothing breaks.

## Final line

> **Every trip creates uncertainty. We turned it into both a game and a sensor. And it just made me $1,000.**
