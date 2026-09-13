// Renders Concorde's state from /api/state. All domain logic lives on the server; this file only draws.
const POLL_INTERVAL_MS = 1000;
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const STATE_LABELS = { unreached: "not texted", asked: "no reply yet", partial: "partly answered", complete: "answered", ghosted: "silent, default applied", "opted out": "opted out" };

const $ = (id) => document.getElementById(id);
const esc = (text) => String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const clock = (iso) => new Date(iso).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
const dollars = (cents) => `$${Math.round(cents / 100)}`;
const dayLabel = (isoDate) => {
  const d = new Date(`${isoDate}T12:00:00Z`);
  return `${DAY_NAMES[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
};

let busy = false;
let lastRendered = "";

function renderApps(state) {
  $("apps").innerHTML = ["messaging", "calendar", "splitwise", "inventory", "model"]
    .map((key) => {
      const mode = state.modes[key];
      return `<li><span class="app-name">${esc(mode.label)}</span><span class="app-mode${mode.real ? " live" : ""}">${mode.real ? "live" : "twin"}</span></li>`;
    })
    .join("");
}

function renderChat(state) {
  if (state.messages.length === 0) {
    $("chat").innerHTML = `<li class="empty">Nothing yet. Start planning and Concorde asks each person in the group what works for them.</li>`;
    return;
  }
  const chat = $("chat");
  const grew = chat.children.length !== state.messages.length;
  chat.innerHTML = state.messages
    .map((m) => {
      const to = m.to === null ? "" : `<span class="to">to ${esc(m.to)}</span>`;
      return `<li class="message${m.from === "Concorde" ? " concorde" : ""}"><span class="from">${esc(m.from)}${to}</span><span class="body">${esc(m.body)}</span></li>`;
    })
    .join("");
  // Keep the newest message in view, like the group chat itself.
  const bay = chat.closest(".bay");
  if (grew && bay !== null) bay.scrollTop = bay.scrollHeight;
}

function renderPlan(state) {
  const plan = $("plan");
  if (state.plan === null) {
    plan.className = "plan is-empty";
    plan.innerHTML = `<p class="empty">No plan yet. Once dates work for everyone who replied, draft the plan from the organizer bay.</p>`;
    return;
  }
  plan.className = "plan";
  const days = [...new Set(state.plan.map((i) => i.day))].sort();
  plan.innerHTML = days
    .map((day) => {
      const strips = state.plan
        .filter((i) => i.day === day)
        .map(
          (i) => `<article class="strip${i.bookingRef ? " booked" : ""}">
            <span class="when">${esc(i.time)}</span>
            <div class="what">
              <div class="title">${esc(i.title)}</div>
              <div class="meta"><span>${esc(i.people.join(", "))}</span><span class="code">${i.bookingRef ? esc(i.bookingRef) : "not booked"}</span></div>
              <div class="meta"><span>${dollars(i.costCents)}</span><span>${i.dependsOn.length ? `after ${esc(i.dependsOn.join(", "))}` : "first leg"}</span></div>
            </div>
          </article>`,
        )
        .join("");
      return `<section class="day" aria-label="${dayLabel(day)}"><h3>${dayLabel(day)}</h3><div class="strips">${strips}</div></section>`;
    })
    .join("");
}

function button(action, label, secondary = false) {
  return `<button type="button" data-action="${action}"${secondary ? ' class="secondary"' : ""}${busy ? " disabled" : ""}>${esc(label)}</button>`;
}

function renderGate(state) {
  const parts = [];
  const actions = [];
  if (state.phase === "idle") {
    parts.push(`<p>Concorde will text the group and ask each person which dates work, their budget, and what they'd skip.</p>`);
    actions.push(button("start", "Text the group"));
  }
  if (state.phase === "eliciting") {
    if (state.canSimulate) actions.push(button("simulate", "Simulate the group's replies", true));
    actions.push(state.canPropose ? button("propose", "Draft the plan") : `<p class="warning">Concorde can draft the plan once some dates work for everyone who replied.</p>`);
  }
  if (state.proposal !== null) {
    const reasons = state.proposal.reasons.length ? `<ul class="reasons">${state.proposal.reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>` : "";
    parts.push(`<div class="proposal"><p>${esc(state.proposal.summary)}</p>${reasons}${state.proposal.warnings.map((w) => `<p class="warning">${esc(w)}</p>`).join("")}</div>`);
  }
  if (state.refusal !== null && state.phase !== "booked") parts.push(`<p class="refusal">Booking refused: ${esc(state.refusal)}</p>`);
  if (state.phase === "proposed" || state.phase === "refused") {
    const check = "";
    parts.push(`<div class="approval"><svg class="box" viewBox="0 0 48 48" aria-hidden="true">${check}</svg><p>${esc(state.organizer)}'s approval</p></div>`);
    if (state.phase === "proposed") actions.push(button("book-unapproved", "Try booking without approval", true));
    actions.push(button("approve", `Approve as ${state.organizer} and book`));
  }
  if (state.phase === "booked") {
    parts.push(`<div class="approval"><svg class="box" viewBox="0 0 48 48" aria-hidden="true"><path d="M9 25 L20 36 L40 11" /></svg><p>Approved by ${esc(state.organizer)}. Booked and on everyone's calendar.</p></div>`);
    if (state.splitwiseUrl) parts.push(`<p>Everyone's share is in Splitwise. <a href="${esc(state.splitwiseUrl)}" target="_blank" rel="noopener">Open the Splitwise group</a></p>`);
    if (state.marketsOpen) parts.push(`<p>Bets are open and everyone's link is in the group. <a class="markets-link" href="/markets" target="_blank" rel="noopener">Open the betting board</a></p>`);
  }
  $("gate").innerHTML = `${parts.join("")}<div class="actions">${actions.join("")}</div>`;
}

function renderMembers(state) {
  $("members").innerHTML = state.members
    .map(
      (m) => `<li class="member"><span class="name">${esc(m.name)}</span><span class="state">${esc(STATE_LABELS[m.state] ?? m.state)}</span>${
        m.constraints.length ? `<span class="said">${esc(m.constraints.join("; "))}</span>` : ""
      }</li>`,
    )
    .join("");
}

function renderCalls(state) {
  if (state.calls.length === 0) {
    $("calls").innerHTML = `<tr><td colspan="6" class="empty">No app calls yet. Every text, calendar write, booking and model call lands here.</td></tr>`;
    return;
  }
  $("calls").innerHTML = state.calls
    .map(
      (c) => `<tr class="${c.ok ? "" : "failed"}">
        <td class="time">${clock(c.at)}</td>
        <td>${esc(c.app)}<span class="mode${c.real ? " live" : ""}">${c.real ? "live" : "twin"}</span></td>
        <td>${esc(c.action)}</td>
        <td>${c.ok ? "ok" : "refused or failed"}</td>
        <td class="num">${c.latencyMs}ms${c.costUsd > 0 ? ` $${c.costUsd.toFixed(4)}` : ""}</td>
        <td>${esc(c.detail)}</td>
      </tr>`,
    )
    .join("");
}

/** Pretend outcomes the organizer picked, by market id. Unpicked markets settle on their favorite. */
const payoutChoices = new Map();
let payoutRendered = "";
let lastState = null;

async function renderPayout(state) {
  const section = $("payout-section");
  if (!state.marketsOpen) {
    section.hidden = true;
    return;
  }
  const query = [...payoutChoices].map(([id, outcome]) => `${id}:${outcome}`).join(",");
  let data;
  try {
    const res = await fetch(`/api/payout?outcomes=${encodeURIComponent(query)}`);
    data = await res.json();
  } catch {
    return;
  }
  // Show the panel only once there is something to show, e.g. not against a server that predates payouts.
  if (!data.open) return;
  section.hidden = false;
  const serialized = JSON.stringify(data);
  if (serialized === payoutRendered) return;
  payoutRendered = serialized;

  const markets = data.markets
    .map(
      (m) => `<li class="payout-market">
        <span class="payout-question">${esc(m.question)}</span>
        <span class="payout-toggle" role="group" aria-label="Pretend outcome for ${esc(m.question)}">${m.outcomes
          .map((o) => `<button type="button" class="${o === m.outcome ? "is-on" : ""}" aria-pressed="${o === m.outcome}" data-payout-market="${esc(m.id)}" data-payout-outcome="${esc(o)}">${esc(o)}</button>`)
          .join("")}</span>
        <span class="payout-source">${m.chosen ? "picked" : "favorite"}</span>
      </li>`,
    )
    .join("");
  const signed = (n) => (n > 0 ? `+${n}` : n < 0 ? `−${Math.abs(n)}` : "0");
  const rows = data.players
    .map((p) => `<tr><th scope="row">${esc(p.name)}</th><td class="num">${p.spent}</td><td class="num">${p.credits}</td><td class="num">${p.payout}</td><td class="num strong">${p.final}</td><td class="num">${signed(p.net)}</td></tr>`)
    .join("");
  const maker = data.maker;
  $("payout").innerHTML = `<ol class="payout-markets">${markets}</ol>
    <div class="payout-results">
      <table class="payout-table">
        <thead><tr><th scope="col">Who</th><th scope="col">Bet</th><th scope="col">Credits left</th><th scope="col">Payout</th><th scope="col">Ends with</th><th scope="col">Net</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <p class="payout-maker">Market maker took in ${maker.collected} credits and would pay out ${maker.paid}, ${maker.net >= 0 ? `keeping ${maker.net}` : `losing ${Math.abs(maker.net)}`}.</p>
    </div>`;
}

document.addEventListener("click", (event) => {
  const choice = event.target instanceof Element ? event.target.closest("button[data-payout-market]") : null;
  if (choice === null || lastState === null) return;
  payoutChoices.set(choice.dataset.payoutMarket, choice.dataset.payoutOutcome);
  payoutRendered = "";
  renderPayout(lastState);
});

function render(state) {
  lastState = state;
  renderPayout(state);
  const serialized = JSON.stringify(state) + busy;
  if (serialized === lastRendered) return;
  lastRendered = serialized;
  $("summary").textContent = state.summary;
  $("trip-facts").textContent = `${state.destination}, ${state.window}`;
  const error = $("error");
  error.hidden = state.lastError === null;
  error.textContent = state.lastError === null ? "" : `Concorde hit a problem: ${state.lastError}`;
  renderApps(state);
  renderChat(state);
  renderPlan(state);
  renderGate(state);
  renderMembers(state);
  renderCalls(state);
}

async function poll() {
  try {
    const res = await fetch("/api/state");
    render(await res.json());
  } catch {
    const error = $("error");
    error.hidden = false;
    error.textContent = "Can't reach Concorde's server. Check that pnpm web is still running.";
  }
}

document.addEventListener("click", async (event) => {
  const target = event.target instanceof Element ? event.target.closest("button[data-action]") : null;
  if (target === null || busy) return;
  busy = true;
  lastRendered = "";
  await poll();
  try {
    const res = await fetch(`/api/${target.dataset.action}`, { method: "POST" });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error);
    busy = false;
    lastRendered = "";
    render(body);
  } catch (cause) {
    // A request that never reached the server must not leave every button disabled.
    busy = false;
    lastRendered = "";
    const error = $("error");
    error.hidden = false;
    error.textContent = cause instanceof Error && cause.message ? cause.message : "That didn't reach Concorde's server. Try again.";
    await poll();
  }
});

poll();
setInterval(poll, POLL_INTERVAL_MS);
