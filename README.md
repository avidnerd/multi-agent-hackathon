# Concorde

**An AI group-travel agent that plans the trip in your group chat, books it only with the organizer's yes, and turns the plan's uncertainty into a market your friends bet on.**

Concorde lives in a real iMessage group. It asks each traveler what constrains them, converges on a plan even when some people barely reply, picks activities the group actually wants, books flights, a hotel and reservations behind a hard approval gate, puts everything on Google Calendar, records everyone's share in Splitwise, and opens prediction markets on the booked plan. A live web dashboard shows the chat, the plan, the approval gate and every app call as it happens.

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

   Freeform replies are turned into typed constraints by Claude. Every constraint quotes the words it came from, is marked hard or soft, and is validated before the planner sees it.

2. **Converge on a plan without waiting for everyone**

   Concorde prices every possible start date and ranks the options. It names who it is waiting on and picks the single question to the single person that would unblock the best option ("I can lock Oct 8–10 if Cody confirms"). Silent members are chased on an escalating schedule, then given a publicly announced default so silence stops blocking.

3. **Build the plan, including activities**

   The chosen dates become a plan: outbound flight, hotel, activities and return flight, linked by dependencies. Activities come from what people said: each venue gains a point per person who wants it and loses one per person who avoids it, the most wanted daytime activity gets the morning, and nothing starts before the latest "nothing before 10am" anyone gave. The dashboard shows why each activity is on the plan ("Julia and David want kayaking; Cody will skip it").

4. **Confirm, book and split the cost**

   Concorde places tentative holds on Google Calendar, drafts the plan, and waits for the organizer. Every action is typed **reversible** or **irreversible**, and irreversible ones (bookings, calendar invites, texts, Splitwise expenses) cannot run without the organizer's approval. On approval it books in dependency order, replaces the holds with real calendar events that invite everyone, creates a Splitwise group with each booked item split among the people on it, and texts each person their share.

5. **Open prediction markets on the booked plan**

   Once the plan is booked, Concorde generates yes-or-no markets from its uncertain points:

   * Does anyone miss Flight TW101 at 7:05am?
   * Does everyone make Cove kayak tour at 10:30am?
   * Does anyone spend over $700 on the trip?

   Each member gets a personal betting link in the group and 1,000 play credits. They bet on Concorde's suggestions with chips or a custom amount, or put their own question on the board ("Does Cody oversleep the kayak tour?"). Prices come from an LMSR market maker, every market has a live price chart, and standings rank people by credits plus what their bets would sell back for.

6. **Simulate the payout**

   On the dashboard, the organizer can flip each market's outcome and instantly see what everyone would be paid, what they would end with, and what the market maker takes in and pays out. A winning share pays one credit.

---

## 02. External apps used

Concorde connects to three real people-facing applications.

| App | What Concorde does with it |
|---|---|
| **iMessage** | Posts each person's questions into the group chat, reads their replies, sends booking confirmations and personal betting links |
| **Google Calendar** | Tentative holds on the front-running dates, then booked events with every member invited by email |
| **Splitwise** | Creates a group for the trip and records each booked item as an expense split among the people on it |

Concorde's reasoning runs on **Claude Sonnet 5**.

### iMessage

Concorde sends through this Mac's Messages app and reads replies from the trip's group chat, limited to trip members. Message text is passed as data, never spliced into a script, so a message cannot become a command.

### Google Calendar

Holds don't mark the organizer as busy. Event ids are derived from idempotency keys, so a retried create returns the existing event instead of making a second one.

### Splitwise

The organizer's account pays up front, and each participant owes an even share of each item, with leftover cents assigned so shares add up exactly. Because Splitwise notifies every member, recording expenses is an irreversible action covered by the organizer's approval.

### Web dashboard and betting page

* `http://127.0.0.1:4300` is the organizer's dashboard: the group chat, the plan as strips by day, the approval gate, who Concorde has heard from, the simulated payout, and a feed of every app call.
* `/markets?player=<token>` is each member's betting page, opened from their phone.

### Travel inventory sandbox

Flights, hotels, reservations, check-ins and spending run on a **stateful sandbox of an airline and hotel API** that we built, labeled as such on the dashboard. It is not a mock: book a seat and inventory decrements, check a passenger in and that state persists, and when its clock reaches departure the flight looks at who actually checked in. Real inventory APIs don't allow test bookings at will or a missed flight on command; the sandbox allows both, can be reset to a known state, and can inject failures.

---

## 03. Setup instructions

### Requirements

* macOS with Messages signed in to iMessage
* Node.js 22+
* pnpm 9
* An OpenRouter API key
* A Google Cloud OAuth client and refresh token with the `https://www.googleapis.com/auth/calendar` scope
* A Splitwise API key (register an app at https://secure.splitwise.com/apps and generate a key)

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
OPENROUTER_API_KEY=...
LLM_MODEL=anthropic/claude-sonnet-5

IMESSAGE_GROUP="San Diego trip!!!"        # exact name of the Messages group
TRIP_MEMBERS="Julia Choi:+12813894001:julia@gmail.com,Cody Zhou:+18322980208:cody@gmail.com"
                                        # Name:+1phone:google-email, organizer first

CALENDAR_MODE=google
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REFRESH_TOKEN=...
GOOGLE_CALENDAR_ID=primary

SPLITWISE_API_KEY=...
```

### Run

```bash
WEB_HOST=0.0.0.0 pnpm web       # dashboard on http://127.0.0.1:4300, betting links reachable from phones on the same Wi-Fi
```

Then: **Text the group** → everyone replies in the group → **Draft the plan** → **Try booking without approval** (refused) → **Approve and book**. Betting links arrive in the group, and the simulated payout appears on the dashboard.

### Other scripts

```bash
pnpm test                       # full test suite
pnpm typecheck                  # strict TypeScript across every package
pnpm book:demo                  # terminal walkthrough: replies, holds, plan, refused booking, approved booking
```

### Layout

```text
packages/core      pure domain logic: schemas, planning, dependency graph, disruption detection and repair, market maker
packages/twins     stateful sandboxes: travel inventory, messaging, calendar, with reset, fault, event, clock and log controls
packages/clients   one client per app, the same code against the real service or the sandbox
packages/agent     elicitation loop, approval-gated dispatcher, booking, activities, markets
apps/web           the dashboard and betting page
```

---

## 04. Reliability testing

Reliability is a core part of Concorde's architecture because the agent takes actions across real external systems.

### Results

Run on September 13, 2026 with `pnpm test`:

| | |
|---|---|
| Tests | **149 passed, 0 failed** |
| Test files | 23 |
| Wall time | about 4 seconds |
| Typecheck | clean, strict mode |

| Area | Tests | What they prove |
|---|---|---|
| Stateful sandboxes | 29 | State persists across calls, every fault type behaves as specified, the clock drives check-in, departure and seating |
| Approval gate and idempotency | 13 | Irreversible actions are refused without a valid organizer approval; retries never double-send or double-book |
| Elicitation and untrusted input | 15 | Replies become quote-backed constraints; injected instructions can't create constraints for anyone else; bad model output is retried, then fails with a typed error |
| Planning, disruption detection and repair | 38 | Convergence under partial replies, the unblocking question, chase and defaults, the dependency graph, cascade repair after a missed or delayed flight |
| Markets, payouts and activities | 14 | LMSR pricing, bets and member questions, prices that always sum to 100¢, payouts, the market maker's loss bound, activity choice from preferences |
| Messaging and config clients | 10 | iMessage group reading and injection-safe sending, config validation |
| Core domain, errors, tracing | 30 | Schemas reject invalid states, typed error union, trace spans |

### Fault injection

Every sandbox supports `reset`, `clock`, `event`, `fault` and `log` controls. All seven fault types are tested against the travel inventory:

| Fault | Tested behavior |
|---|---|
| `rate_limit` | 429 with Retry-After, then recovers |
| `empty_200` | The write applies but the body is empty; a keyed retry recovers the same booking |
| `write_then_timeout` | The write commits and the connection never answers; retrying on the same key books exactly once |
| `stale_read` | Serves state from before the last write |
| `partial_batch` | Fails the chosen items without writing them |
| `duplicate_webhook` | Delivers every event in the next feed page twice |
| `slow` | Delays the response by the configured time |

The calendar sandbox survives `write_then_timeout` without a duplicate event. Clock tests cover check-in opening 24h out and closing 45 minutes out, an injected missed flight turning a passenger into a no-show at departure, and a delay moving departure so downstream reservations seat only the people who arrived.

### Human approval gate

The gate is code, not a prompt: `checkApproval` in `packages/agent/src/dispatcher.ts` is the only path to an external write. Tested cases:

* an irreversible booking with no approval is refused and never reaches the provider
* unknown, expired, non-organizer and already-used approvals are refused
* a standing messaging approval covers texts but not bookings
* approval for one version of the plan cannot book the next version
* an opted-out member is never contacted, approval or not

### Idempotency under retry

* a completed action replays instead of running again
* a text whose outcome is unknown after a timeout is never resent blind
* a retry after losing every local record books nothing twice: same booking references, same charges

### Untrusted input

Member text enters the model as delimited data. Tests show it stays inside the delimiter even when it tries to close it, that an injected instruction can't create constraints for anyone but the sender, and that a constraint quoting words the member never wrote is dropped. Member-written market questions are displayed, never sent to a model.

### Market accuracy

* each bet sells exactly the number of shares its credits pay for under LMSR's cost function
* displayed prices always sum to 100¢
* a winning share pays one credit and a losing share pays nothing
* standings value holdings at what they would sell back for, so a bet is never shown as an instant profit
* across a long mixed sequence of bets, the market maker's loss stays within LMSR's bound of b·ln(1/opening price)

### Safety invariants

| Invariant | How it is enforced |
|---|---|
| Never execute an irreversible action without approval | Dispatcher gate, 8 tests |
| Never treat an inferred constraint as something a user stated | Every constraint carries its source; only the member's own quoted words produce a stated constraint |
| Never contact an opted-out traveler | Dispatcher check and STOP handling, 2 tests |
| Never double-book or double-charge during retries | Sandbox, dispatcher and booking tests, including a retry after losing all local state |

### Observability

Every agent action is traced with inputs, outputs, latency, retries and model cost. The dashboard's app-call feed is built from those traces.

### Bugs found running it live, and fixed

* When the model provider ran out of credit mid-run, unreadable replies were counted as answers. Unread replies now leave the member untouched and are retried.
* Messages stamped to the whole second made a reply in the session's first second disappear.
* The organizer's own messages from the host Mac were indistinguishable from Concorde's; they are now read as that member's replies.
* Standings valued bets at the post-trade price, making every bet look like a profit.
* Rounded prices could add up to 99¢ or 101¢.

---

## 05. Demo video

**Demo:** [Watch the Concorde demo](https://youtu.be/_MtOsmPcSsA)

```text
questions in the iMessage group
      ↓
replies become constraints
      ↓
plan with activities the group wants
      ↓
booking refused without approval
      ↓
organizer approves: bookings, calendar invites, Splitwise, confirmations
      ↓
markets open on the booked plan, friends bet from their phones
      ↓
simulated payout on the dashboard
```
