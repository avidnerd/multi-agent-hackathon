# Concorde

**An AI group-travel agent that plans the trip in your group chat, books it only with the organizer's yes, and turns the plan's uncertainty into a market your friends bet on.**

Concorde lives in a real iMessage group. It asks each traveler what constrains them, converges on a plan even when some people barely reply, picks activities from what the group actually wants, books flights, a hotel and reservations behind a hard approval gate, puts everything on Google Calendar, and then opens prediction markets on the booked plan. A web board shows the chat, the plan, the gate and every app call as it happens.

---

## 01. Project overview

Planning a group trip is difficult because everyone's constraints are different.

One person has a strict budget. Another cannot travel on the 12th. Someone does not want an early start. Someone else simply never responds.

Most travel tools generate recommendations for one person. Concorde acts as an agent for the entire group.

### How it works

1. **Collect constraints in the group chat**

   Concorde posts one message per person in the iMessage group, addressed by name (`@Julia`, `@Cody`, `@David`), with three questions:

   * which days in the window work
   * the most they want to spend, all in
   * what they want to do there, and anything they'd skip (early starts, food, activities)

   Freeform replies are turned into typed constraints by Claude Sonnet 5. Every constraint must quote the words it came from, is marked hard or soft, and is validated with Zod before the planner sees it. A reply the model could not read is not counted as an answer; it is retried.

2. **Converge on a plan without waiting for everyone**

   Concorde prices every possible start date against the inventory and ranks the options. It names who it is waiting on and picks the single question to the single person that would unblock the best option ("I can lock Oct 8–10 if Cody confirms"). Silent members are chased on an escalating schedule, then given a publicly announced default so silence stops blocking.

3. **Build the plan, including activities**

   The chosen dates become a plan: outbound flight, hotel, activities and return flight, linked by dependencies. Activities are picked from what people said: each venue gains a point per person who wants it and loses one per person who avoids it, the most wanted daytime activity gets the morning, and nothing starts before the latest "nothing before 10am" anyone gave. The board shows why each activity is on the plan ("Julia and David want kayaking; Cody will skip it").

4. **Confirm and book**

   Concorde places tentative holds on Google Calendar, drafts the plan, and waits. Every action is typed **reversible** or **irreversible**, and irreversible ones (bookings, calendar invites, texts) cannot run without an approval token from the organizer. On approval it books in dependency order with idempotency keys, replaces the holds with real events that invite everyone by email, and texts each person their share.

5. **Open prediction markets on the booked plan**

   Once the plan is booked, Concorde generates yes-or-no markets from its uncertain points:

   * Does anyone miss Flight TW101 at 7:05am?
   * Does everyone make Cove kayak tour at 10:30am?
   * Does anyone spend over $700 on the trip?

   Each member gets their own betting link in the group and 1,000 play credits. They can bet on Concorde's suggestions with chips or a custom amount, or put their own question on the board ("Does Cody oversleep the kayak tour?"). Prices come from an LMSR market maker, every market has a price chart, and standings rank people by credits plus what their bets would sell back for. Member-written questions are displayed, never sent to a model.

6. **Monitor the trip, detect and repair disruptions** *(core logic built and tested; not yet wired to the live board)*

   The travel twin can inject a missed flight or a delay on command, and advance its clock so flights depart, check-ins close and reservations seat only the people who arrived. `detectDivergence` compares what happened against the plan, and `repairPlan` recomputes everything downstream through the dependency graph:

   ```text
   Jake misses TW101
          |
          v
   Rebook on a later flight (irreversible, needs approval)
          |
          v
   Beach club moves later (reversible)
          |
          v
   Dinner, which depends on the beach club, moves too
   ```

   Repairs cascade through `dependsOn` instead of patching items one at a time.

7. **Resolve markets and use prices as a signal** *(not built)*

   Settling markets from observed outcomes, escalating ambiguous ones, and turning a low price into a proposed plan change are designed but not implemented. See "What is not built" below.

---

## 02. External apps used

| App | Mode | What Concorde does with it |
|---|---|---|
| **iMessage** (this Mac's Messages app) | Real | Posts each person's questions into the group, reads replies from the group, sends booking confirmations and personal betting links |
| **Google Calendar** | Real | Tentative holds on the front-running dates, booked events with every member invited by email, availability from calendars shared with the organizer |
| **Claude Sonnet 5** (via OpenRouter) | Real | Turns each freeform reply into validated, quote-backed constraints |
| **Travel inventory** (flights, hotel, reservations, check-in, charges) | Twin | Searches and books. A stateful twin we built, labeled "twin" on every screen |

### iMessage

Concorde sends through AppleScript and reads the local Messages database, filtered to the trip's group chat and its members. Message text is passed as arguments, never spliced into the script, so a message cannot become AppleScript. Twilio was the original plan; its client and a Twilio twin still exist and back the test suite, but the live demo uses iMessage because an unregistered Twilio number is filtered by US carriers.

### Web board and betting page

Discord was cut. Instead:

* `http://127.0.0.1:4300` is the organizer's board: group chat mirror, the plan as strips by day, the approval gate, who Concorde has heard from, and a rail of every app call marked **live** or **twin**. Only this Mac can text the group, draft or approve.
* `/markets?player=<token>` is each member's betting page, reachable from phones on the same network.

### Google Calendar

Holds are transparent (they don't mark the organizer busy). Event ids are derived from idempotency keys, so a retried create returns the existing event instead of making a second one.

### Travel inventory twin

Flights, hotels, reservations, check-ins and spending are a **stateful twin**, not a mock and not presented as a real airline or hotel API. Book a seat and inventory decrements. Check a passenger in and that state persists. When the controllable clock reaches departure, the flight looks at who actually checked in. We built it because no real inventory API lets you make a passenger miss a flight on command, and because a twin can be reset to a known seed and run hundreds of times.

---

## 03. Setup instructions

### Requirements

* macOS with Messages signed in to iMessage (for the real group chat)
* Node.js 22+
* pnpm 9
* An OpenRouter API key
* Optional for real calendar invites: a Google Cloud OAuth client and refresh token with the `https://www.googleapis.com/auth/calendar` scope

The terminal that runs Concorde needs **Full Disk Access** (to read replies) and **Automation → Messages** permission (to send), both under System Settings → Privacy & Security.

### Install

```bash
git clone https://github.com/avidnerd/multi-agent-hackathon.git
cd multi-agent-hackathon
pnpm install
cp .env.example .env
```

### Configure `.env`

```text
OPENROUTER_API_KEY=...            # required
LLM_MODEL=anthropic/claude-sonnet-5

IMESSAGE_GROUP="San Diego trip!!!"  # exact name of the Messages group; empty = Messages twin
TRIP_MEMBERS="Julia Choi:+12813894001:julia@gmail.com,Cody Zhou:+18322980208:cody@gmail.com"
                                  # Name:+1phone:google-email, organizer first; empty = 4 simulated members

CALENDAR_MODE=google              # or twin
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REFRESH_TOKEN=...
GOOGLE_CALENDAR_ID=primary
```

With only the OpenRouter key set, everything except the model runs on twins, and the board offers "Simulate the group's replies".

### Run

```bash
pnpm web                          # board on http://127.0.0.1:4300
WEB_HOST=0.0.0.0 pnpm web         # also reachable from phones on the same Wi-Fi, for betting links
```

Then: **Text the group** → everyone replies in the group → **Draft the plan** → **Try booking without approval** (refused) → **Approve as <organizer> and book**. Betting links arrive in the group.

### Other scripts

```bash
pnpm test                         # full test suite
pnpm typecheck                    # strict TypeScript across every package
pnpm book:demo                    # terminal walkthrough: replies, holds, plan, refused booking, approved booking
pnpm imessage:live                # one real phone over iMessage, rest of the group on the twin
pnpm twins                        # run the twin servers standalone
```

### Layout

```text
packages/core      pure domain: schemas, planning, dependency graph, divergence, repair, LMSR (no network)
packages/twins     stateful twins: inventory, Twilio, Google Calendar, with reset/fault/event/clock/log
packages/clients   one interface per app, real and twin behind the same client code
packages/agent     elicitation loop, approval-gated dispatcher, booking, activities, markets
apps/web           the board and betting page
```

---

## 04. Reliability testing

Reliability is a core part of Concorde's architecture because the agent takes actions across real external systems.

### Results

Run on September 13, 2026 with `pnpm test`:

| | |
|---|---|
| Tests | **146 passed, 0 failed** |
| Test files | 23 |
| Wall time | about 4 seconds, twins included |
| Typecheck | clean, strict mode, no `any` |

| Area | Tests | What they prove |
|---|---|---|
| Stateful twins (inventory, Google Calendar, Twilio) | 29 | State persists across calls, every fault type behaves as specified, the clock drives check-in, departure and seating |
| Approval gate and idempotency | 13 | Irreversible actions are refused without a valid organizer token; retries never double-send or double-book |
| Elicitation and untrusted input | 15 | Replies become quote-backed constraints; injected instructions can't create constraints for anyone else; bad model output is retried then fails typed |
| Planning, divergence and repair | 38 | Convergence under partial replies, the unblocking question, chase and defaults, plan dependency graph, cascade repair |
| Markets and activities | 11 | LMSR prices and costs, bets and member questions, activity choice from preferences |
| Messaging and config clients | 10 | iMessage group reading and injection-safe sending, config validation |
| Core domain, errors, tracing | 30 | Schemas reject invalid states, typed error union, trace spans |

### Stateful twins and fault injection

Each twin supports `reset`, `clock`, `event`, `fault` and `log` control endpoints. The inventory twin supports all seven fault types, each with a passing test:

| Fault | Tested behavior |
|---|---|
| `rate_limit` | 429 with Retry-After, then recovers |
| `empty_200` | The write applies but the body is empty; a keyed retry recovers the same booking |
| `write_then_timeout` | The write commits and the connection never answers; retrying on the same key books exactly once |
| `stale_read` | Serves state from before the last write |
| `partial_batch` | Fails the chosen items without writing them |
| `duplicate_webhook` | Delivers every event in the next feed page twice |
| `slow` | Delays the response by the configured time |

The Google Calendar twin survives `write_then_timeout` without a duplicate event. The Twilio twin refuses faults Twilio could not produce.

Clock tests: check-in opens 24h out and closes 45 minutes out; an injected missed flight turns a passenger into a no-show at departure; a delay moves departure and downstream reservations seat only the people who arrived; the clock refuses to move backwards.

### Human approval gate

The gate is code, not a prompt: `checkApproval` in `packages/agent/src/dispatcher.ts` is the only path to an external write. Tested cases:

* an irreversible booking with no token is refused and never reaches the provider
* unknown, expired, non-organizer and already-used tokens are refused
* a standing messaging approval covers texts but not bookings
* approval for one version of the plan cannot book the next version
* an opted-out member is never contacted, approval or not

### Idempotency under retry

* a completed action replays instead of running again
* a text whose outcome is unknown after a timeout is never resent blind
* **a retry after losing every local record books nothing twice**: same booking references, same charges

### Untrusted input

Member text enters the model as delimited data. Tests show it stays inside the delimiter even when it tries to close it, that an injected instruction can't create constraints for anyone but the sender, and that a constraint quoting words the member never wrote is dropped. Member-written market questions are never sent to a model.

### Safety invariants

| Invariant | Status |
|---|---|
| Never execute an irreversible action without approval | Enforced in the dispatcher; covered by 8 tests |
| Never treat a market-inferred constraint as something a user stated | Enforced by schema (`source` on every constraint); price-to-constraint inference is not built yet |
| Never automatically resolve an ambiguous market | Not applicable yet: market resolution is not built |
| Never contact an opted-out traveler | Enforced in the dispatcher and on STOP; covered by 2 tests |
| Never double-book or double-charge during retries | Covered by twin, dispatcher and booking tests, including a retry after losing all local state |

### Observability

Every agent action is traced with inputs, outputs, latency, retries and model cost. The board's app-call rail is built from those traces.

### Failures we found by running it for real

* **Fixed:** when OpenRouter ran out of credit mid-run, unreadable replies were counted as answers and the planner announced "4 of 4 replied, ready to lock it" knowing nothing. Unread replies now leave the member untouched and are retried.
* **Fixed:** Twilio stamps messages to the whole second, so a reply in the session's first second was dropped.
* **Fixed:** Messages accounts that throw on `service type` broke the iMessage account lookup.
* **Fixed:** the organizer's own messages from this Mac were indistinguishable from Concorde's; they are now read as that member's replies unless they match something Concorde sent.
* **Fixed:** a four-person minimum rejected the three-person demo group, and the board swallowed the error.
* **Fixed:** market standings valued holdings at the post-trade price, so every bet looked like an instant profit.
* **Open:** extraction over-reads availability. "8th to 10th is good, I can't do the 12th" became a hard exclusion of the 11th to 13th.
* **Open:** plans take the cheapest flights, so the demo plan flies home at 9:10am on the last day.
* **Open:** a retry after losing local records re-sends confirmation texts; iMessage has no provider-side idempotency.
* **Open:** betting links are posted in the group, so a member could open someone else's link.

### What is not built

* An evaluation suite (convergence vs response rate, extraction precision and recall, market calibration). The planning logic it would measure is unit-tested, but no benchmark numbers exist yet and none are claimed.
* Live trip monitoring on the board. `detectDivergence`, `repairPlan` and twin event injection are built and tested, but not wired into the running agent.
* Market resolution, escalation of ambiguous outcomes, and market prices proposing plan changes.
* Model-set opening prices. Opening prices use a simple rule: early starts and early flights are riskier.
* Discord and a database. The trip lives in the running server's memory.

---

## 05. Demo video

**Demo:** [Watch the Concorde demo](DEMO_VIDEO_URL)

The demo shows the loop that is actually built:

```text
questions in the iMessage group
      ↓
replies become constraints
      ↓
plan with activities the group wants
      ↓
booking refused without approval
      ↓
organizer approves: bookings, calendar invites, confirmations
      ↓
markets open on the booked plan, friends bet from their phones
```

The recording plan is in [`demo-runbook.md`](demo-runbook.md).
