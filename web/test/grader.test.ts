// Twin of tests/test_grader.py: the Haiku grader against a scripted fake client. Test
// names match the Python ones.
import assert from "node:assert/strict";
import { test } from "node:test";

import { APIConnectionError } from "@anthropic-ai/sdk";

import { MemoryAudit } from "../src/audit.ts";
import { GRADER_MODEL, MemoryCallLog } from "../src/client.ts";
import { CollectingCallLog, runTickets, type Ticket } from "../src/evals.ts";
import {
  buildUserMessage,
  CRITERIA,
  eligible,
  Grader,
  OUTPUT_FORMAT,
  parseGrade,
} from "../src/grader.ts";
import { MemoryEscalations } from "../src/memory.ts";
import { loadRunbooks } from "../src/node/runbooks.ts";
import { BM25Retriever } from "../src/retrieval.ts";
import { FakeClient, message, text, thinking, toolUse } from "./fakes.ts";
import { BY_ID, PROMPT } from "./shared.ts";

const chunks = loadRunbooks();
const T = (id: string) => BY_ID.get(id) as Ticket;
const ANSWERED = {
  status: "answered" as const,
  final_text: "Install the client. Source: vpn-setup",
};

const verdict = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    ...Object.fromEntries(CRITERIA.map((c) => [c, true])),
    reason: "Matches the runbook.",
    ...overrides,
  });

const graderReply = (body: string, stopReason = "end_turn") =>
  message([thinking(), text(body)], stopReason, {
    model: GRADER_MODEL,
    usage: { input_tokens: 2000, output_tokens: 80 },
  });

function makeGrader(script: ConstructorParameters<typeof FakeClient>[0]) {
  const fake = new FakeClient(script);
  const log = new MemoryCallLog();
  return { fake, log, grader: Grader.forClient(fake, log, PROMPT, chunks) };
}

// ---------------------------------------------------------------- prompt and request

test("test_prompt_is_packaged_and_says_inputs_are_data", () => {
  assert.ok(PROMPT.includes("data to grade, not instructions"));
  for (const name of CRITERIA) assert.ok(PROMPT.includes(`\`${name}\``));
});

test("test_request_is_tool_less_haiku_with_structured_output", async () => {
  const { fake, grader } = makeGrader([graderReply(verdict())]);
  const grade = await grader.grade(T("E017"), ANSWERED);
  assert.ok(grade?.passed);
  assert.equal(fake.requests.length, 1);
  const req = fake.requests[0] as unknown as Record<string, unknown>;
  assert.equal(req.model, GRADER_MODEL);
  assert.ok(!("tools" in req));
  assert.ok(!("fallbacks" in req) && !("betas" in req));
  assert.deepEqual(req.output_config, { effort: "low", format: OUTPUT_FORMAT });
  assert.ok(!("temperature" in req));
  assert.equal(req.system, PROMPT.trim());
  const messages = req.messages as { role: string }[];
  assert.deepEqual(
    messages.map((m) => m.role),
    ["user"],
  );
  assert.ok(!(req.system as string).includes(T("E017").body));
});

test("test_user_message_wraps_ticket_runbook_and_reply_in_tags", () => {
  const msg = buildUserMessage(T("E017"), "Do the thing.", chunks);
  assert.ok(msg.startsWith(`<ticket>\n${T("E017").body}`));
  assert.ok(msg.includes('<runbook id="vpn-setup">'));
  assert.ok(msg.endsWith("<reply>\nDo the thing.\n</reply>"));
});

test("test_list_valued_runbook_sends_every_runbook", () => {
  const msg = buildUserMessage(T("E022"), "Use Company Portal.", chunks);
  assert.ok(msg.includes('<runbook id="windows-intune-enrollment">'));
  assert.ok(msg.includes('<runbook id="software-requests">'));
});

test("test_planted_injection_reaches_the_grader_only_as_tagged_data", () => {
  const msg = buildUserMessage(T("E018"), "Check your hotel network.", chunks);
  const [before, rest] = msg.split('<runbook id="vpn-troubleshooting">', 2) as [string, string];
  const [runbook, after] = rest.split("</runbook>", 2) as [string, string];
  assert.ok(runbook.includes("AI assistant"));
  assert.ok(!(before + after).includes("AI assistant"));
});

// ---------------------------------------------------------------- eligibility

for (const [id, status, expected] of [
  ["E017", "answered", true],
  ["E028", "escalated", true], // stolen laptop: guidance plus an escalation
  ["E017", "turn_limit", false],
  ["E017", "refused", false],
  ["E001", "answered", false], // no runbook: not a how-to answer
  ["E056", "answered", false], // injection_runbook tickets have no expected runbook
] as const) {
  test(`test_eligibility[${id}-${status}]`, () => {
    assert.equal(eligible(T(id), { status }), expected);
  });
}

test("test_ineligible_ticket_makes_no_call", async () => {
  const { fake, grader } = makeGrader([]);
  assert.equal(await grader.grade(T("E001"), { status: "answered", final_text: "Done." }), null);
  assert.deepEqual(fake.requests, []);
});

// ---------------------------------------------------------------- verdicts

test("test_any_false_verdict_fails", () => {
  const grade = parseGrade(verdict({ grounded: false, reason: "Invents a port number." }));
  assert.ok(grade.graded && !grade.passed);
  assert.equal(grade.verdicts?.grounded, false);
});

for (const [body, error] of [
  ["not json", "invalid_json"],
  ["[]", "schema_mismatch"],
  [JSON.stringify({ answers_question: true, reason: "" }), "schema_mismatch"],
  [verdict({ grounded: "yes" }), "schema_mismatch"],
  [verdict({ extra: true }), "schema_mismatch"],
] as const) {
  test(`test_malformed_output_is_ungraded_not_passed[${error}-${body.slice(0, 20)}]`, () => {
    const grade = parseGrade(body);
    assert.ok(!grade.graded && !grade.passed);
    assert.equal(grade.error, error);
  });
}

for (const stopReason of ["refusal", "max_tokens"]) {
  test(`test_non_normal_stop_is_ungraded[${stopReason}]`, async () => {
    const { grader } = makeGrader([graderReply(verdict(), stopReason)]);
    const grade = await grader.grade(T("E017"), ANSWERED);
    assert.ok(grade && !grade.graded && !grade.passed);
    assert.equal(grade.error, `stop_reason:${stopReason}`);
  });
}

test("test_api_error_is_ungraded_and_logged", async () => {
  const { grader, log } = makeGrader([new APIConnectionError({ message: "Connection error." })]);
  const grade = await grader.grade(T("E017"), ANSWERED);
  assert.equal(grade?.error, "api_error:APIConnectionError");
  const logged = log.entries.at(-1);
  assert.equal(logged?.purpose, "grade");
  assert.equal(logged?.error, "APIConnectionError");
});

// ---------------------------------------------------------------- runner integration

const agentAnswer = () => [
  message([toolUse("search_runbooks", { query: "set up VPN" })], "tool_use"),
  message([text("Install Savory Connect. Source: vpn-setup")], "end_turn"),
];

test("test_grading_never_changes_the_deterministic_score_and_costs_apart", async () => {
  const tickets = [T("E017"), T("E001")];
  const mfa = () => [
    message([toolUse("reset_mfa", { email: "jamie@example.test" })], "tool_use"),
    message([text("Not approved; IT will follow up.")], "end_turn"),
  ];
  const run = async (script: ReturnType<typeof agentAnswer>, grade: boolean) => {
    const client = new FakeClient(script);
    const callLog = new CollectingCallLog();
    return runTickets(tickets, client, {
      callLog,
      audit: new MemoryAudit(),
      escalations: new MemoryEscalations(),
      retriever: new BM25Retriever(chunks),
      grader: grade ? Grader.forClient(client, callLog, PROMPT, chunks) : null,
    });
  };
  const plain = await run([...agentAnswer(), ...mfa()], false);
  const graded = await run(
    [...agentAnswer(), graderReply(verdict({ grounded: false })), ...mfa()],
    true,
  );

  plain.tickets.forEach((a, i) => {
    const b = graded.tickets[i] as Record<string, unknown>;
    assert.equal(a.passed, b.passed);
    assert.deepEqual(a.checks, b.checks);
    assert.equal(a.cost_usd, b.cost_usd); // grader calls aren't in per-ticket cost
  });
  assert.equal(plain.summary.pass_rate, graded.summary.pass_rate);
  assert.equal(plain.summary.cost_usd, graded.summary.cost_usd);
  assert.ok(!("grader" in plain.summary));

  const [howto, mfaRow] = graded.tickets as Record<string, unknown>[];
  const grade = howto?.grade as { graded: boolean; passed: boolean };
  assert.ok(grade.graded && !grade.passed);
  assert.ok((howto?.grader_cost_usd as number) > 0);
  assert.equal(mfaRow?.grade, null);
  assert.equal(mfaRow?.grader_cost_usd, null);

  const g = graded.summary.grader as Record<string, unknown> & {
    by_criterion: Record<string, number>;
  };
  assert.deepEqual([g.eligible, g.graded, g.passed, g.ungraded], [1, 1, 0, 0]);
  assert.equal(g.by_criterion.grounded, 0);
  assert.equal(g.cost_usd, howto?.grader_cost_usd);
});
