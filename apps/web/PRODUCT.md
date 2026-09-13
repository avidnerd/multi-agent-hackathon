# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- **Trip members** (4 to 6 friends). They plan inside a real iMessage group chat with Concorde. They open the website on their phones, from a personal link Concorde texts them, to check the plan and place bets.
- **The organizer**, one of the members. They approve anything irreversible (bookings, calendar invites) before Concorde acts.
- **Hackathon judges**, watching a laptop or projector during a live demo. The site has to make visible what Concorde is doing and why it can be trusted.

## Product Purpose

Concorde is an agent that plans a group trip in the group chat. It asks each person what constrains them and converges on a plan even when some people barely reply. It books everything behind a confirmation gate, then watches the trip and replans when reality breaks it. Along the way it turns the plan's uncertain points into prediction markets the friends trade on, and those prices can change the plan.

Success in the room: a phone buzzes, the group converges in chat, the site shows Concorde calling real and twinned apps, a market price moves a plan item, a missed flight is detected and repaired, and markets settle from what actually happened.

## Positioning

- **Two layers, stated openly.** The people layer is real: iMessage from this Mac, and calendars. The inventory layer (flights, hotels, reservations, check-in) is stateful twins built for this project, so disruptions can be injected on command. The site never implies a twinned booking was real.
- **The market is a mechanism, not decoration.** Closing prices become inferred constraints that can propose a plan change. An inferred constraint is never promoted to a stated one.
- **The gate is code.** Irreversible actions need an organizer approval token, enforced in the dispatcher.

## Operating Context

- The group chat is a real iMessage group with at least two real iPhones besides the Mac running Concorde. The website mirrors that chat live.
- Each member gets a personal betting link texted by Concorde. No login, no betting as someone else.
- Demo setting: a laptop or projector shows the chat mirror, app activity, plan and markets together, while members hold their phones.
- One group, one pre-chosen destination, two to three days. Variables are dates within a window, budget, and timing of scheduled items.

## Capabilities and Constraints

- Stack: Next.js App Router, TypeScript strict, Zod at every boundary. No UI kits or state libraries without asking.
- Built: SMS and iMessage elicitation with model extraction, chase schedule, convergence under partial replies, plan dependency graph, confirmation gate, booking with idempotency keys against the inventory twin, calendar holds and events (twin only; no Google credentials yet).
- Not yet built: markets and market maker, live monitoring and disruption repair, resolution, eval suite, group-chat mode (currently per-person threads).
- Discord is cut. Markets live on the website.
- The word "itinerary" is banned in copy and identifiers; it is "the plan".

## Brand Commitments

- The agent's name is **Concorde**.
- Voice: a competent friend. Sentence case, active voice, no exclamation marks, no marketing voice. "Two of four replied. I can lock the 12th if Dev confirms Thursday works."
- No "Powered by AI", no sparkle emoji, no emoji as interface iconography.

## Evidence on Hand

- Real run output: an iMessage round trip with a real phone, parsed constraints, gate refusal, bookings, confirmation text, and full traces with latency and model cost.
- No real bookings, customers, or benchmarks exist. Eval numbers do not exist yet and must not be fabricated.

## Product Principles

1. Show the work. Every agent action is traceable to inputs, outputs, latency and cost.
2. Honest about what is simulated. Twinned inventory is labeled as such.
3. Silence does not block. Concorde names who it is waiting on and what one answer would unblock.
4. Nothing irreversible without the organizer's yes.
5. An honest failure beats a clean sheet nobody can defend.

## Accessibility & Inclusion

WCAG AA contrast, visible keyboard focus, `prefers-reduced-motion` respected, usable at 375px because the betting board is used on phones.
