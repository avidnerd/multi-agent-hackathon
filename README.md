# Concorde

Concorde plans a group trip inside a real iMessage group chat. It asks each person what constrains them, converges on dates even when some people barely reply, drafts a plan, and books it only after the organizer approves. A web board shows the chat, the plan, the approval gate and every app call as it happens.

## The apps it connects to

| App | Mode | What Concorde does with it |
|---|---|---|
| iMessage (this Mac's Messages app) | Real | Asks each member their dates, budget and limits in the group, reads their replies, sends booking confirmations |
| Google Calendar | Real when credentials are set | Holds front-running dates, writes booked events with members invited by email |
| Travel inventory (flights, hotel, reservations) | Twin | Searches and books. Airline and hotel APIs are not openly available, so this is a stateful twin we built: seats decrement, bookings dedupe on idempotency keys, faults and a clock can be injected |
| Claude Sonnet 5 via OpenRouter | Real | Turns each freeform reply into typed constraints, validated with Zod and retried on bad output |

The board labels every call live or twin. Nothing twinned is presented as real.

## Run it

```bash
pnpm install
cp .env.example .env   # set OPENROUTER_API_KEY at minimum
pnpm web               # http://127.0.0.1:4300
```

With only the model key set, the group, calendar and inventory all run on twins and "Simulate the group's replies" drives the demo. For the real thing, set in `.env`:

- `IMESSAGE_GROUP`: the name of a Messages group on this Mac. Needs Full Disk Access and Automation permission for the terminal.
- `TRIP_MEMBERS`: `Name:+1phone:google-email`, comma separated, organizer first.
- `CALENDAR_MODE=google` with `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`.

## What makes it trustworthy

- **The gate is code.** Every action is typed reversible or irreversible. An irreversible action (a booking, a calendar invite, a text) runs only with an approval token granted by the organizer, checked in `packages/agent/src/dispatcher.ts` (`checkApproval`). Approvals are single use and bound to one plan version.
- **Silence does not block.** `identifyUnblockingQuestion` picks the one question to the one person that most reduces uncertainty; people who stay silent are chased on an escalating schedule and then get a publicly announced default.
- **Replies are data, not instructions.** Member text enters the model as delimited data, and every extracted constraint must quote the words it came from.
- **Retries never double-book.** Bookings carry idempotency keys; a retry after losing every local record returns the same booking references and charges.
- **Repair cascades.** `repairPlan` recomputes everything downstream of a broken item through the plan's dependency graph.

`pnpm test` runs 134 tests, including the gate refusing unapproved, non-organizer and stale-version approvals against the twins.

## Failures we found and what is still broken

- Fixed: when the model provider ran out of credit, unreadable replies were counted as answers and the planner announced "4 of 4 replied, ready to lock it" knowing nothing. Unread replies now leave the member untouched and are retried.
- Fixed: Twilio stamps messages to the second, so a reply in the session's first second was dropped.
- Open: extraction over-reads availability. "8th to 10th is good, I can't do the 12th" became a hard exclusion of the 11th to 13th.
- Open: plans pick the cheapest flights, so the demo plan flies home at 9:10am on the last day.
- Open: a retry after losing local records re-sends confirmation texts; messaging has no provider-side idempotency.
- Not built in this hackathon: prediction markets, live trip monitoring on the board, the eval suite.
