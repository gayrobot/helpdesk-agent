// Local helpdesk page. Everything from the server (ticket text, replies, directory
// fields, tool arguments) is untrusted, so it is only ever set with textContent.
"use strict";

const TOKEN = document.querySelector('meta[name="helpdesk-token"]').content;
const POLL_MS = 700;
const $ = (id) => document.getElementById(id);

let runId = null;
let shownProposal = null;
let pollTimer = null;

async function api(method, path, body) {
  const opts = { method, headers: { "X-Helpdesk-Token": TOKEN } };
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

async function loadRequesters() {
  const { ok, data } = await api("GET", "/api/requesters");
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

function renderCalls(events) {
  const body = $("calls");
  $("no-calls").hidden = events.length > 0;
  // Rows only ever get appended, so add the new ones.
  for (let i = body.children.length; i < events.length; i++) {
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
    body.appendChild(tr);
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
  $("approve").disabled = false;
  $("deny").disabled = false;
  box.hidden = false;
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
  loadRequesters();
});
