// Draws the betting board from /api/markets. Prices, credits and validation all live on the server.
const POLL_INTERVAL_MS = 1500;
const CHIPS = [5, 10, 25];
const token = new URLSearchParams(location.search).get("player");

const $ = (id) => document.getElementById(id);
const esc = (text) => String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

let busy = false;
let lastRendered = "";
const shown = new Map();
/** Latest history per market, for the chart's hover readout. */
const histories = new Map();

const TICKS = [100, 50, 0];
const TIP_EDGE_PERCENT = 18;
const clockTime = (iso) => new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
/** Chart geometry lives in a 0–100 box stretched to the card, so labels stay HTML at a fixed readable size. */
const xPercent = (index, count) => (count <= 1 ? 100 : (index / (count - 1)) * 100);
const yPercent = (cents) => 100 - cents;

/** Flip tiles for a value; only characters that changed since the last draw flip. */
function flaps(key, text, size) {
  const before = shown.get(key);
  shown.set(key, text);
  const tiles = [...text].map((ch, i) => `<span class="flap${before !== undefined && before[i] !== ch ? " flip" : ""}" aria-hidden="true">${esc(ch)}</span>`).join("");
  return `<span class="flaps ${size}" role="img" aria-label="${esc(text.trim())}">${tiles}</span>`;
}

function notice(text, isError) {
  const el = $("notice");
  el.hidden = false;
  el.textContent = text;
  el.classList.toggle("is-error", isError);
}

/** Step line of the first outcome's price: each bet holds the price flat until the next one moves it. */
function priceChart(market) {
  const points = market.history;
  const outcome = market.outcomes[0]?.name ?? "Yes";
  histories.set(market.id, { points, outcome });
  const count = points.length;
  const first = points[0]?.cents[0] ?? 50;
  const last = points[count - 1]?.cents[0] ?? first;

  let line = `M0,${yPercent(first)}`;
  for (let i = 1; i < count; i += 1) line += ` H${xPercent(i, count)} V${yPercent(points[i].cents[0])}`;
  if (count <= 1) line += " H100";
  const grid = TICKS.map((c) => `<line class="grid" x1="0" x2="100" y1="${yPercent(c)}" y2="${yPercent(c)}"/>`).join("");
  const ticks = TICKS.map((c) => `<span style="top:${yPercent(c)}%">${c}¢</span>`).join("");
  const bets = count - 1;
  const label = `${outcome} price opened at ${first}¢ and is ${last}¢ after ${bets} ${bets === 1 ? "bet" : "bets"}. Use the arrow keys to step through bets.`;
  const rows = points.map((p) => `<tr><td>${clockTime(p.at)}</td><td>${p.by === null ? "Opening price" : `${esc(p.by)}'s bet`}</td><td>${p.cents[0]}¢</td></tr>`).join("");

  return `<figure class="chart">
    <figcaption>${esc(outcome)} price, one step per bet</figcaption>
    <div class="chart-body">
      <div class="chart-ticks" aria-hidden="true">${ticks}</div>
      <div class="chart-frame" data-market="${esc(market.id)}" tabindex="0" role="img" aria-label="${esc(label)}">
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          ${grid}
          <path class="wash" d="${line} V100 H0 Z"/>
          <path class="line" d="${line}"/>
          <line class="crosshair" x1="0" x2="0" y1="0" y2="100" visibility="hidden"/>
        </svg>
        <span class="chart-end" style="left:${xPercent(count - 1, count)}%;top:${yPercent(last)}%"></span>
        <div class="chart-tip" hidden><strong></strong><span></span></div>
      </div>
    </div>
    <div class="chart-axis" aria-hidden="true"><span>Opened</span><span>Now</span></div>
    <details><summary>Price history</summary><table><thead><tr><th scope="col">Time</th><th scope="col">What moved it</th><th scope="col">${esc(outcome)}</th></tr></thead><tbody>${rows}</tbody></table></details>
  </figure>`;
}

/** Snap the crosshair to a bet and fill the tooltip. Names go in with textContent. */
function showPoint(frame, index) {
  const entry = histories.get(frame.dataset.market);
  if (entry === undefined || entry.points.length === 0) return;
  const count = entry.points.length;
  const i = Math.max(0, Math.min(count - 1, index));
  const point = entry.points[i];
  const x = xPercent(i, count);
  const crosshair = frame.querySelector(".crosshair");
  crosshair.setAttribute("x1", String(x));
  crosshair.setAttribute("x2", String(x));
  crosshair.setAttribute("visibility", "visible");
  const tip = frame.querySelector(".chart-tip");
  tip.querySelector("strong").textContent = `${point.cents[0]}¢ ${entry.outcome}`;
  tip.querySelector("span").textContent = `${point.by === null ? "opening price" : `after ${point.by}'s bet`}, ${clockTime(point.at)}`;
  tip.style.left = `${Math.max(TIP_EDGE_PERCENT, Math.min(100 - TIP_EDGE_PERCENT, x))}%`;
  tip.hidden = false;
  frame.dataset.index = String(i);
}

function hidePoint(frame) {
  frame.querySelector(".crosshair")?.setAttribute("visibility", "hidden");
  const tip = frame.querySelector(".chart-tip");
  if (tip) tip.hidden = true;
}

function marketCard(market, player) {
  const outcomes = market.outcomes
    .map((o) => {
      const chips = player
        ? `<div class="chips" role="group" aria-label="Bet on ${esc(o.name)}">${CHIPS.map(
            (c) =>
              `<button type="button" class="chip chip-${c}" data-market="${esc(market.id)}" data-outcome="${esc(o.name)}" data-spend="${c}" aria-label="Bet ${c} credits on ${esc(o.name)}"${player.credits < c || busy ? " disabled" : ""}>${c}</button>`,
          ).join("")}</div>`
        : "";
      const held = o.held > 0 ? `<p class="held">You hold ${o.held.toFixed(1)} ${esc(o.name)}</p>` : "";
      return `<div class="outcome"><div class="outcome-head"><span class="outcome-name">${esc(o.name)}</span>${flaps(`${market.id}:${o.name}`, `${o.cents}¢`, "big")}</div>${chips}${held}</div>`;
    })
    .join("");
  const by = market.createdBy === null ? "Suggested by Concorde" : `Asked by ${esc(market.createdBy)}`;
  return `<article class="market"><header><h3>${esc(market.question)}</h3><p class="byline"><span>${by}</span><span>${market.volume} credits bet</span></p></header><div class="outcomes">${outcomes}</div>${priceChart(market)}</article>`;
}

function render(state) {
  const serialized = JSON.stringify(state) + busy;
  if (serialized === lastRendered) return;
  lastRendered = serialized;

  if (!state.open) {
    $("who").textContent = "Bets open once the plan is booked.";
    $("credits").innerHTML = "";
    $("suggested").innerHTML = `<p class="empty">Concorde opens markets on the plan as soon as the organizer approves the booking.</p>`;
    $("group").innerHTML = "";
    $("standings").innerHTML = "";
    return;
  }

  const player = state.player;
  $("who").textContent = player ? `Betting as ${player.name}` : "Watching. Open the link Concorde texted you to bet.";
  $("credits").innerHTML = player ? flaps("credits", String(player.credits), "big") : "";
  $("ask").hidden = !player;

  const suggested = state.markets.filter((m) => m.createdBy === null);
  const fromGroup = state.markets.filter((m) => m.createdBy !== null);
  $("suggested").innerHTML = suggested.map((m) => marketCard(m, player)).join("");
  $("group").innerHTML = fromGroup.length
    ? fromGroup.map((m) => marketCard(m, player)).join("")
    : `<p class="empty">${player ? "Nobody has asked the group anything yet. Put a question on the board below." : "Nobody has asked the group anything yet."}</p>`;
  $("standings").innerHTML = state.standings
    .map((s, i) => `<li class="${player && s.name === player.name ? "me" : ""}"><span class="rank">${i + 1}</span><span>${esc(s.name)}</span>${flaps(`worth:${s.name}`, String(s.worth), "small")}</li>`)
    .join("");
}

async function poll() {
  try {
    const res = await fetch(`/api/markets${token ? `?player=${encodeURIComponent(token)}` : ""}`);
    render(await res.json());
  } catch {
    notice("Can't reach Concorde. Check you're on the same Wi-Fi as the organizer's Mac.", true);
  }
}

async function send(path, body, success) {
  busy = true;
  lastRendered = "";
  try {
    const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error);
    notice(success, false);
    return true;
  } catch (cause) {
    notice(cause instanceof Error && cause.message ? cause.message : "That didn't reach Concorde. Try again.", true);
    return false;
  } finally {
    busy = false;
    lastRendered = "";
    await poll();
  }
}

const frameOf = (target) => (target instanceof Element ? target.closest(".chart-frame") : null);

document.addEventListener("click", (event) => {
  const chip = event.target instanceof Element ? event.target.closest("button.chip") : null;
  if (chip === null || busy || !token) return;
  const { market, outcome, spend } = chip.dataset;
  send("/api/bet", { player: token, marketId: market, outcome, spend: Number(spend) }, `Bet placed: ${spend} on ${outcome}`);
});

document.addEventListener("pointermove", (event) => {
  const frame = frameOf(event.target);
  if (frame === null) return;
  const entry = histories.get(frame.dataset.market);
  if (entry === undefined) return;
  const box = frame.getBoundingClientRect();
  const fraction = Math.max(0, Math.min(1, (event.clientX - box.left) / box.width));
  showPoint(frame, Math.round(fraction * (entry.points.length - 1)));
});

document.addEventListener("pointerout", (event) => {
  const frame = frameOf(event.target);
  if (frame !== null && !(event.relatedTarget instanceof Node && frame.contains(event.relatedTarget))) hidePoint(frame);
});

// Keyboard readers get the same readout: focus shows the latest price, arrows step through bets.
document.addEventListener("focusin", (event) => {
  const frame = frameOf(event.target);
  if (frame !== null) showPoint(frame, (histories.get(frame.dataset.market)?.points.length ?? 1) - 1);
});
document.addEventListener("focusout", (event) => {
  const frame = frameOf(event.target);
  if (frame !== null) hidePoint(frame);
});
document.addEventListener("keydown", (event) => {
  const frame = frameOf(event.target);
  if (frame === null || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
  event.preventDefault();
  showPoint(frame, Number(frame.dataset.index ?? 0) + (event.key === "ArrowRight" ? 1 : -1));
});

$("ask").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = $("question");
  if (busy || !token) return;
  if (await send("/api/question", { player: token, question: input.value }, "Your question is on the board")) input.value = "";
});

poll();
setInterval(poll, POLL_INTERVAL_MS);
