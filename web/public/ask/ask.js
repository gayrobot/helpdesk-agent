// The anonymous tier. Everything from the server is untrusted and only set as text.
"use strict";

const $ = (id) => document.getElementById(id);
let siteKey = null;
let widgetId = null;
let token = null;

function setText(el, value) { el.textContent = value == null ? "" : String(value); }

function onToken(t) { token = t; $("ask").disabled = false; }
function onExpired() { token = null; $("ask").disabled = true; }

function renderWidget() {
  if (!window.turnstile || !siteKey) return;
  widgetId = window.turnstile.render("#turnstile", {
    sitekey: siteKey,
    callback: onToken,
    "expired-callback": onExpired,
    "error-callback": onExpired,
  });
}

async function init() {
  let config;
  try {
    config = await (await fetch("/api/config")).json();
  } catch (_) {
    setText($("status"), "The site isn't reachable right now.");
    return;
  }
  if (!config.answersOn) {
    setText($("status"), "Answers are switched off right now. Please try again later.");
    return;
  }
  siteKey = config.turnstileSiteKey;
  const script = document.createElement("script");
  script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
  script.async = true;
  script.onload = renderWidget;
  document.head.appendChild(script);
}

async function ask() {
  const question = $("question").value.trim();
  if (!question) { setText($("status"), "Write a question first."); return; }
  if (!token) { setText($("status"), "Complete the human check first."); return; }
  $("ask").disabled = true;
  setText($("status"), "Looking through the runbooks…");
  const sent = token;
  token = null; // single use: a fresh check is needed for the next question
  let res;
  let data = {};
  try {
    res = await fetch("/api/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, turnstile: sent }),
    });
    data = await res.json();
  } catch (_) {
    setText($("status"), "Something went wrong. Try again.");
  }
  if (widgetId !== null && window.turnstile) window.turnstile.reset(widgetId);
  if (!res || !res.ok) {
    setText($("status"), data.error || "Something went wrong. Try again.");
    return;
  }
  setText($("status"), "");
  $("answer-card").hidden = false;
  setText($("answer"), data.answer || "No answer.");
  $("source").hidden = !data.source;
  setText($("source"), data.source ? `Source: ${data.source}` : "");
  setText($("searches"), (data.searches || []).length ? `Searched the runbooks for: ${data.searches.join("; ")}` : "");
}

document.addEventListener("DOMContentLoaded", () => {
  $("ask").addEventListener("click", ask);
  init();
});
