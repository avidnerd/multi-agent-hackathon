// Draws the betting board from /api/markets. Prices, credits and validation all live on the server.
const POLL_INTERVAL_MS = 1500;
const CHIPS = [5, 10, 25];
const token = new URLSearchParams(location.search).get("player");

const $ = (id) => document.getElementById(id);
const esc = (text) => String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

let busy = false;
let lastRendered = "";
const shown = new Map();

/** Flip tiles for a value; only characters that changed since the last draw flip. */
function flaps(key, text, size) {
  const before = shown.get(key);
  shown.set(key, text);
  const tiles = [...text].map((ch, i) => `<span class="flap${before !== undefined && before[i] !== ch ? " flip" : ""}" aria-hidden="true">${esc(ch)}</span>`).join("");
  return `<span class="flaps ${size}" role="img" aria-label="${esc(text)}">${tiles}</span>`;
}

function notice(text, isError) {
  const el = $("notice");
  el.hidden = false;
  el.textContent = text;
  el.classList.toggle("is-error", isError);
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
  return `<article class="market"><header><h3>${esc(market.question)}</h3><p class="byline"><span>${by}</span><span>${market.volume} credits bet</span></p></header><div class="outcomes">${outcomes}</div></article>`;
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
  $("credits").innerHTML = player ? flaps("credits", String(player.credits).padStart(3, " "), "big") : "";
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

document.addEventListener("click", (event) => {
  const chip = event.target instanceof Element ? event.target.closest("button.chip") : null;
  if (chip === null || busy || !token) return;
  const { market, outcome, spend } = chip.dataset;
  send("/api/bet", { player: token, marketId: market, outcome, spend: Number(spend) }, `Bet placed: ${spend} on ${outcome}`);
});

$("ask").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = $("question");
  if (busy || !token) return;
  if (await send("/api/question", { player: token, question: input.value }, "Your question is on the board")) input.value = "";
});

poll();
setInterval(poll, POLL_INTERVAL_MS);
