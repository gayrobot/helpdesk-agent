// The tier 2 split-screen demo. Everything from the server (ticket text, replies,
// directory fields, tool arguments, audit records) is untrusted, so it is only ever set
// with textContent.
//
// Credentials, all kept in this tab only (sessionStorage):
// - the session id and token, from POST /api/sessions (after the Turnstile check);
// - one simulated sign-in token per side, from POST /api/sign-in. The server reads the
//   side and the persona from that token, never from a request body.
"use strict";

const STORE_KEY = "helpdesk-demo-v2";
const POLL_MS = 900;
// Matches the server's review delay, which refuses an earlier Approve anyway.
const REVIEW_MS = 1200;
const $ = (id) => document.getElementById(id);

const state = {
  session: null, // { session, token }
  sides: { requester: null, helpdesk: null }, // { email, token }
  leftRun: null,
  rightRun: null,
  shownProposal: null,
  pollTimer: null,
};

let siteKey = null;
let widgetId = null;
let turnstileToken = null;

function setText(el, value) { el.textContent = value == null ? "" : String(value); }

function save() {
  try {
    sessionStorage.setItem(STORE_KEY, JSON.stringify({ session: state.session, sides: state.sides }));
  } catch (_) { /* private mode: the demo still works until reload */ }
}

function load() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(STORE_KEY) || "null");
    if (saved && saved.session) {
      state.session = saved.session;
      state.sides = saved.sides || state.sides;
    }
  } catch (_) { /* ignore */ }
}

async function call(method, path, body, side) {
  const headers = {
    "X-Helpdesk-Session": state.session.session,
    "X-Helpdesk-Token": state.session.token,
  };
  if (side && state.sides[side]) headers["X-Helpdesk-Identity"] = state.sides[side].token;
  const opts = { method, headers };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  let data = {};
  try { data = await res.json(); } catch (_) { /* empty body */ }
  return { ok: res.ok, status: res.status, data };
}

// A side's call; signs that side in again once if its token has expired or the server
// restarted (the sign-in key lives in memory only).
async function api(side, method, path, body) {
  let r = await call(method, path, body, side);
  if (r.status === 401 && state.sides[side]) {
    if (await signIn(side, state.sides[side].email)) r = await call(method, path, body, side);
  }
  if (r.status === 403 && r.data.error && /session/i.test(r.data.error)) sessionGone();
  return r;
}

async function signIn(side, email) {
  const r = await call("POST", "/api/sign-in", { side, email });
  if (!r.ok) {
    setText($(side === "requester" ? "left-status" : "right-status"), r.data.error || "Sign-in failed.");
    return false;
  }
  state.sides[side] = { email: r.data.email, token: r.data.token };
  save();
  setText(
    $(side === "requester" ? "left-who" : "right-who"),
    `Signed in as ${r.data.email} (simulated sign-in: a development token issuer, not a real identity provider).`,
  );
  return true;
}

function sessionGone() {
  state.session = null;
  state.sides = { requester: null, helpdesk: null };
  try { sessionStorage.removeItem(STORE_KEY); } catch (_) { /* ignore */ }
  $("demo").hidden = true;
  $("start").hidden = false;
  setText($("start-status"), "This session has ended. Start a new one.");
  if (widgetId !== null && window.turnstile) window.turnstile.reset(widgetId);
  else if (siteKey) loadTurnstile();
}

// ---------------------------------------------------------------- start

function onToken(t) { turnstileToken = t; $("start-btn").disabled = false; }
function onExpired() { turnstileToken = null; $("start-btn").disabled = true; }

function renderWidget() {
  if (!window.turnstile || !siteKey) return;
  widgetId = window.turnstile.render("#turnstile", {
    sitekey: siteKey,
    callback: onToken,
    "expired-callback": onExpired,
    "error-callback": onExpired,
  });
}

function loadTurnstile() {
  const script = document.createElement("script");
  script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
  script.async = true;
  script.onload = renderWidget;
  document.head.appendChild(script);
}

async function startSession() {
  if (!turnstileToken) { setText($("start-status"), "Complete the human check first."); return; }
  $("start-btn").disabled = true;
  setText($("start-status"), "Starting…");
  const sent = turnstileToken;
  turnstileToken = null;
  let res;
  try {
    res = await fetch("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ turnstile: sent }),
    });
  } catch (_) {
    setText($("start-status"), "The site isn't reachable right now.");
    return;
  }
  let data = {};
  try { data = await res.json(); } catch (_) { /* empty */ }
  if (widgetId !== null && window.turnstile) window.turnstile.reset(widgetId);
  if (!res.ok) { setText($("start-status"), data.error || "Couldn't start a session."); return; }
  state.session = { session: data.session, token: data.token };
  state.sides = { requester: null, helpdesk: null };
  save();
  setText($("start-status"), "");
  await openDemo();
}

// ---------------------------------------------------------------- the two sides

async function openDemo() {
  const r = await call("GET", "/api/requesters");
  if (!r.ok) { sessionGone(); return; }
  $("start").hidden = true;
  $("demo").hidden = false;

  const select = $("requester");
  select.replaceChildren();
  for (const p of r.data.requester) {
    const opt = document.createElement("option");
    opt.value = p.email;
    opt.textContent = `${p.name} <${p.email}>`;
    select.appendChild(opt);
  }
  const left = state.sides.requester?.email || "jamie@example.test";
  if (r.data.requester.some((p) => p.email === left)) select.value = left;

  const box = $("helpdesk-personas");
  box.replaceChildren();
  const right = state.sides.helpdesk?.email || r.data.helpdesk.find((p) => p.email.startsWith("theo."))?.email;
  for (const p of r.data.helpdesk) {
    const label = document.createElement("label");
    label.className = "persona";
    const input = document.createElement("input");
    input.type = "radio";
    input.name = "helpdesk";
    input.value = p.email;
    input.checked = p.email === right;
    input.addEventListener("change", () => switchHelpdesk(p.email));
    label.appendChild(input);
    label.appendChild(document.createTextNode(` ${p.name}`));
    box.appendChild(label);
  }

  await signIn("requester", select.value);
  if (right) await signIn("helpdesk", right);
  const current = await api("helpdesk", "GET", "/api/current");
  if (current.ok && current.data.run_id) state.rightRun = current.data.run_id;
  refreshAudit();
  poll();
}

async function switchHelpdesk(email) {
  await signIn("helpdesk", email);
  state.shownProposal = null; // show the card again for the new persona
  setText($("p-approver"), email);
  poll();
}

async function send(side) {
  const box = $(side === "requester" ? "ticket-left" : "ticket-right");
  const status = $(side === "requester" ? "left-status" : "right-status");
  const ticket = box.value;
  if (!ticket.trim()) { setText(status, "Write a ticket first."); return; }
  setText(status, "Starting…");
  const r = await api(side, "POST", "/api/runs", { ticket });
  if (!r.ok) { setText(status, r.data.error || "Couldn't start the ticket."); return; }
  setText(status, "");
  if (side === "requester") state.leftRun = r.data.run_id;
  state.rightRun = r.data.run_id;
  state.shownProposal = null;
  $("calls").replaceChildren();
  poll();
}

async function poll() {
  clearTimeout(state.pollTimer);
  if (!state.session) return;
  let running = false;
  if (state.rightRun) {
    const r = await api("helpdesk", "GET", `/api/runs/${state.rightRun}`);
    if (r.ok) { renderRight(r.data); running ||= r.data.status === "running"; }
  }
  if (state.leftRun) {
    const r = await api("requester", "GET", `/api/runs/${state.leftRun}`);
    if (r.ok) { renderLeft(r.data); running ||= r.data.status === "running"; }
  }
  if (running) state.pollTimer = setTimeout(poll, POLL_MS);
  else refreshAudit();
}

function splitSource(text) {
  const lines = (text || "").split("\n");
  const sourceLine = lines.find((l) => /^\s*Source:/i.test(l));
  return { body: lines.filter((l) => l !== sourceLine).join("\n").trim(), source: sourceLine ? sourceLine.trim() : "" };
}

function renderLeft(run) {
  setText($("left-run-status"), run.status);
  $("left-run-status").dataset.status = run.status;
  setText($("left-meta"), `${run.ticket_id} · from ${run.requester}`);
  const { body, source } = splitSource(run.final_text);
  setText($("left-reply"), run.status === "running" ? "Working on it… (a write may be waiting for the helpdesk)" : body);
  $("left-source").hidden = !source;
  setText($("left-source"), source);
}

function renderRight(run) {
  setText($("right-run-status"), run.status);
  $("right-run-status").dataset.status = run.status;
  setText($("right-meta"), `${run.ticket_id} · from ${run.requester} · ${run.tool_turns} tool turn(s)`);
  setText($("right-reply"), run.final_text);
  renderCalls(run.events || []);
  renderProposal(run.pending);
}

function formatArgs(args) {
  if (args && typeof args === "object") return Object.entries(args).map(([k, v]) => `${k} = ${v}`).join("\n");
  return String(args ?? "");
}

function prettyResult(text) {
  try { return JSON.stringify(JSON.parse(text), null, 2); } catch (_) { return text; }
}

function resultRow(e) {
  const tr = document.createElement("tr");
  tr.className = "result-row";
  tr.appendChild(document.createElement("td"));
  const td = document.createElement("td");
  td.colSpan = 4;
  const details = document.createElement("details");
  const summary = document.createElement("summary");
  const hash = e.result_sha256 || "";
  setText(summary, `Result sent to the model · ${e.result_bytes ?? "?"} bytes · sha256 ${hash.slice(0, 12)}…`);
  details.appendChild(summary);
  const pre = document.createElement("pre");
  pre.className = "result";
  setText(pre, prettyResult(e.result ?? ""));
  details.appendChild(pre);
  const meta = document.createElement("p");
  meta.className = "meta hash";
  setText(meta, `sha256 ${hash} (matches result_sha256 in the audit trail below)`);
  details.appendChild(meta);
  td.appendChild(details);
  tr.appendChild(td);
  return tr;
}

function renderCalls(events) {
  const body = $("calls");
  $("no-calls").hidden = events.length > 0;
  for (let i = body.querySelectorAll("tr.call").length; i < events.length; i++) {
    const e = events[i];
    const tr = document.createElement("tr");
    const decision = e.approval === "approved" || e.approval === "denied" ? `${e.decision} (${e.approval})` : e.decision;
    [i + 1, e.tool, formatArgs(e.args), decision, e.reason].forEach((value, idx) => {
      const td = document.createElement("td");
      if (idx === 2) { const pre = document.createElement("pre"); setText(pre, value); td.appendChild(pre); }
      else setText(td, value);
      tr.appendChild(td);
    });
    tr.dataset.decision = e.decision;
    tr.className = "call";
    body.appendChild(tr);
    body.appendChild(resultRow(e));
  }
}

function renderRefusals(list) {
  const ul = $("p-refusals");
  ul.replaceChildren();
  for (const r of list || []) {
    const li = document.createElement("li");
    setText(li, `Approve by ${r.approver} refused by rule: ${r.rule}`);
    ul.appendChild(li);
  }
}

function renderProposal(p) {
  const box = $("approval");
  if (!p) { box.hidden = true; state.shownProposal = null; return; }
  renderRefusals(p.refusals);
  if (state.shownProposal === p.id) return;
  state.shownProposal = p.id;
  setText($("p-tool"), p.tool);
  setText($("p-args"), formatArgs(p.args));
  setText($("p-effect"), p.effect);
  setText($("p-requester"), p.requester);
  setText($("p-target"), p.target);
  setText($("p-approver"), state.sides.helpdesk?.email || "");
  const match = $("p-match");
  match.className = p.requester_is_target ? "match" : "mismatch";
  setText(match, p.requester_is_target ? "The requester is the target." : "REQUESTER IS NOT THE TARGET: check they may ask for this.");
  $("approve").disabled = true;
  $("deny").disabled = false;
  box.hidden = false;
  showSide("right");
  const id = p.id;
  setTimeout(() => { if (state.shownProposal === id) $("approve").disabled = false; }, REVIEW_MS);
}

async function decide(decision) {
  const id = state.shownProposal;
  if (!state.rightRun || !id) return;
  $("approve").disabled = true;
  $("deny").disabled = true;
  const r = await api("helpdesk", "POST", `/api/runs/${state.rightRun}/decision`, { proposal_id: id, decision });
  if (!r.ok) {
    setText($("right-status"), r.data.rule ? `Refused by rule: ${r.data.rule}` : r.data.error || "Decision not recorded.");
    // Still pending: let the other persona (or this one, to deny) answer it.
    $("approve").disabled = false;
    $("deny").disabled = false;
  } else {
    setText($("right-status"), "");
  }
  poll();
}

async function refreshAudit() {
  if (!state.session || !state.sides.helpdesk) return;
  const r = await api("helpdesk", "GET", "/api/log");
  if (!r.ok) return;
  const ol = $("audit");
  ol.replaceChildren();
  for (const rec of (r.data.audit || []).slice(-40)) {
    const li = document.createElement("li");
    const parts = [rec.ts, rec.event, rec.tool, rec.decision, rec.approver ? `approver ${rec.approver}` : "", rec.reason]
      .filter((x) => x !== undefined && x !== null && x !== "");
    setText(li, parts.join(" · "));
    const hash = document.createElement("span");
    hash.className = "hash";
    setText(hash, ` hash ${String(rec.hash || "").slice(0, 12)}…`);
    li.appendChild(hash);
    ol.appendChild(li);
  }
}

// ---------------------------------------------------------------- phone toggle

function showSide(which) {
  const left = which === "left";
  $("left").dataset.active = String(left);
  $("right").dataset.active = String(!left);
  $("show-left").setAttribute("aria-selected", String(left));
  $("show-right").setAttribute("aria-selected", String(!left));
}

document.addEventListener("DOMContentLoaded", async () => {
  $("start-btn").addEventListener("click", startSession);
  $("send-left").addEventListener("click", () => send("requester"));
  $("send-right").addEventListener("click", () => send("helpdesk"));
  $("approve").addEventListener("click", () => decide("approve"));
  $("deny").addEventListener("click", () => decide("deny"));
  $("refresh-audit").addEventListener("click", refreshAudit);
  $("requester").addEventListener("change", (e) => signIn("requester", e.target.value));
  $("show-left").addEventListener("click", () => showSide("left"));
  $("show-right").addEventListener("click", () => showSide("right"));

  let config;
  try { config = await (await fetch("/api/config")).json(); } catch (_) {
    setText($("start-status"), "The site isn't reachable right now.");
    return;
  }
  if (!config.tiers || !config.tiers.demo) { setText($("start-status"), "The helpdesk demo isn't open yet."); return; }
  if (!config.answersOn) { setText($("start-status"), "The demo is switched off right now. Please try again later."); return; }
  siteKey = config.turnstileSiteKey;
  load();
  if (state.session) {
    const probe = await call("GET", "/api/requesters");
    if (probe.ok) { await openDemo(); return; }
    sessionGone(); // loads the human check
    return;
  }
  loadTurnstile();
});
