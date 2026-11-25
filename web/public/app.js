// Local helpdesk page. Everything from the server (ticket text, replies, directory
// fields, tool arguments) is untrusted, so it is only ever set with textContent.
"use strict";

// The session id and token come from POST /api/sessions. They stay in this tab only
// (sessionStorage), so a reload can pick up a run that is waiting for a decision.
const STORE_KEY = "helpdesk-session";
let SESSION = null;

function remembered() {
  try { return JSON.parse(sessionStorage.getItem(STORE_KEY) || "null"); } catch (_) { return null; }
}

function remember(session) {
  try { sessionStorage.setItem(STORE_KEY, JSON.stringify(session)); } catch (_) { /* private mode */ }
}

async function newSession() {
  const res = await fetch("/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  if (!res.ok) throw new Error("no session");
  const data = await res.json();
  return { session: data.session, token: data.token };
}

async function ensureSession() {
  SESSION = remembered();
  if (SESSION) {
    const probe = await api("GET", "/api/requesters");
    if (probe.ok) return probe;
  }
  SESSION = await newSession();
  remember(SESSION);
  return api("GET", "/api/requesters");
}
const POLL_MS = 700;
// Matches MIN_REVIEW_SECONDS on the server, which refuses an earlier Approve anyway.
const REVIEW_MS = 1200;
const $ = (id) => document.getElementById(id);

let runId = null;
let shownProposal = null;
let pollTimer = null;

async function api(method, path, body) {
  const opts = {
    method,
    headers: { "X-Helpdesk-Session": SESSION.session, "X-Helpdesk-Token": SESSION.token },
  };
  if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  let data = {};
  try { data = await res.json(); } catch (_) { /* empty body */ }
  return { ok: res.ok, status: res.status, data };
}

function setText(el, value) { el.textContent = value == null ? "" : String(value); }

function formatArgs(args) {
  if (args && typeof args === "object") {
    return Object.entries(args).map(([k, v]) => `${k} = ${v}`).join("\n");
  }
  return String(args ?? "");
}

async function loadRequesters(first) {
  const { ok, data } = first ?? (await api("GET", "/api/requesters"));
  const select = $("requester");
  if (!ok) { setText($("form-status"), "Couldn't load the directory."); return; }
  for (const r of data.requesters) {
    const opt = document.createElement("option");
    opt.value = r.email;
    opt.textContent = `${r.name} <${r.email}>`;
    select.appendChild(opt);
  }
  const jamie = data.requesters.find((r) => r.email === "jamie@example.test");
  if (jamie) select.value = jamie.email;
}

async function send() {
  const ticket = $("ticket").value;
  if (!ticket.trim()) { setText($("form-status"), "Write a ticket first."); return; }
  $("send").disabled = true;
  setText($("form-status"), "Starting…");
  const { ok, data } = await api("POST", "/api/runs", { requester: $("requester").value, ticket });
  if (!ok) {
    setText($("form-status"), data.error || "Couldn't start the run.");
    $("send").disabled = false;
    return;
  }
  runId = data.run_id;
  shownProposal = null;
  $("calls").replaceChildren();
  setText($("reply"), "");
  $("source").hidden = true;
  setText($("form-status"), "");
  poll();
}

async function poll() {
  clearTimeout(pollTimer);
  if (!runId) return;
  const { ok, data } = await api("GET", `/api/runs/${runId}`);
  if (ok) render(data);
  if (!ok || data.status === "running") pollTimer = setTimeout(poll, POLL_MS);
  else $("send").disabled = false;
}

function render(run) {
  setText($("run-status"), run.status);
  $("run-status").dataset.status = run.status;
  setText($("run-meta"), `${run.ticket_id} · ${run.requester} · ${run.tool_turns} tool turn(s)`);
  renderReply(run.final_text);
  renderCalls(run.events);
  renderProposal(run.pending);
}

function renderReply(text) {
  const lines = (text || "").split("\n");
  const sourceLine = lines.find((l) => /^\s*Source:/i.test(l));
  setText($("reply"), lines.filter((l) => l !== sourceLine).join("\n").trim());
  $("source").hidden = !sourceLine;
  setText($("source"), sourceLine ? sourceLine.trim() : "");
}

function prettyResult(text) {
  try { return JSON.stringify(JSON.parse(text), null, 2); } catch (_) { return text; }
}

// The exact text the model got back for one call, with the fingerprint that the audit
// log records for it (logs/audit.jsonl: result_sha256, result_bytes).
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
  setText(meta, `sha256 ${hash} (matches result_sha256 in logs/audit.jsonl)`);
  details.appendChild(meta);
  if (e.result_altered) {
    const warn = document.createElement("p");
    warn.className = "meta altered";
    setText(warn, "Shown with control characters replaced or cut for length; the hash is of the original.");
    details.appendChild(warn);
  }
  td.appendChild(details);
  tr.appendChild(td);
  return tr;
}

function renderCalls(events) {
  const body = $("calls");
  $("no-calls").hidden = events.length > 0;
  // Calls only ever get appended, so add the new ones (two rows each).
  for (let i = body.querySelectorAll("tr.call").length; i < events.length; i++) {
    const e = events[i];
    const tr = document.createElement("tr");
    const decision = e.approval === "approved" || e.approval === "denied"
      ? `${e.decision} (${e.approval})` : e.decision;
    const cells = [i + 1, e.tool, formatArgs(e.args), decision, e.reason];
    cells.forEach((value, idx) => {
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

function renderProposal(p) {
  const box = $("approval");
  if (!p) { box.hidden = true; shownProposal = null; return; }
  if (shownProposal === p.id) return;
  shownProposal = p.id;
  setText($("p-tool"), p.tool);
  setText($("p-args"), formatArgs(p.args));
  setText($("p-effect"), p.effect);
  setText($("p-requester"), p.requester);
  setText($("p-target"), p.target);
  const match = $("p-match");
  match.className = p.requester_is_target ? "match" : "mismatch";
  setText(match, p.requester_is_target
    ? "The requester is the target."
    : "REQUESTER IS NOT THE TARGET: check they may ask for this.");
  // Approve stays locked for a moment so a double-click can't approve a write that just
  // appeared under the cursor. Deny is safe to allow at once.
  $("approve").disabled = true;
  $("deny").disabled = false;
  box.hidden = false;
  const id = p.id;
  setTimeout(() => { if (shownProposal === id) $("approve").disabled = false; }, REVIEW_MS);
}

async function decide(decision) {
  const id = shownProposal;
  if (!runId || !id) return;
  // One click decides one proposal; both buttons lock until the next one arrives.
  $("approve").disabled = true;
  $("deny").disabled = true;
  const { ok, data } = await api("POST", `/api/runs/${runId}/decision`, { proposal_id: id, decision });
  if (!ok) setText($("form-status"), data.error || "Decision not recorded.");
  poll();
}

document.addEventListener("DOMContentLoaded", () => {
  $("send").addEventListener("click", send);
  $("approve").addEventListener("click", () => decide("approve"));
  $("deny").addEventListener("click", () => decide("deny"));
  ensureSession()
    .then((first) => loadRequesters(first))
    .then(resumeCurrentRun)
    .catch(() => setText($("form-status"), "Couldn't start a session."));
});

// After a reload, pick up a run that is still going (it may be waiting for a decision).
async function resumeCurrentRun() {
  const { ok, data } = await api("GET", "/api/current");
  if (!ok || !data.run_id) return;
  runId = data.run_id;
  $("send").disabled = true;
  poll();
}
