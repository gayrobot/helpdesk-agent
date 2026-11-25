// Byte-for-byte parity with the Python agent, against golden outputs written by
// scripts/parity_fixtures.py from the real Python code.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { Directory, isMixedScript, letterScripts, normalize } from "../src/directory.ts";
import {
  EMAIL_PATTERN,
  type Proposal,
  resultFingerprint,
  validateArgs,
} from "../src/governance.ts";
import { PYTHON_UNICODE_VERSION, reprStr } from "../src/pycompat.ts";
import { apiToolDefinitions, display, TOOLS, type ToolSpec } from "../src/tools.ts";
import fixtures from "./fixtures/governance.json" with { type: "json" };
import { FIXED_NOW, makeGate, withoutTs } from "./helpers.ts";

interface GateCase {
  name: string;
  requester: string;
  approver: "approve" | "deny";
  steps: { tool: string; args: unknown }[];
  outcomes: {
    decision: string;
    is_error: boolean;
    content: string;
    result_sha256: string;
    result_bytes: number;
  }[];
  proposals: Record<string, unknown>[];
  audit: Record<string, unknown>[];
  escalations: Record<string, unknown>[];
}

const F = fixtures as unknown as {
  fixed_now: string;
  normalize: { input: string; normalize: string; scripts: string[]; mixed: boolean }[];
  display: { input: string; output: string }[];
  repr: { input: string; output: string }[];
  email_pattern: { input: string; match: boolean }[];
  directory: {
    find_user: Record<string, string | null>;
    find_group: Record<string, string | null>;
    is_privileged_group: Record<string, boolean>;
    privileged_memberships: Record<string, string[]>;
    devices_for: Record<string, string[]>;
  };
  validate_args: { tool: string; args: unknown; error: string | null }[];
  api_tool_definitions: unknown;
  gate: GateCase[];
};

test("fixtures were written with the same fixed clock", () => {
  assert.equal(new Date(F.fixed_now).getTime(), FIXED_NOW.getTime());
  assert.equal(PYTHON_UNICODE_VERSION, "15.0.0");
});

describe("directory text handling", () => {
  test(`normalize, letter scripts and mixed-script checks (${F.normalize.length} strings)`, () => {
    for (const c of F.normalize) {
      assert.equal(normalize(c.input), c.normalize, `normalize(${reprStr(c.input)})`);
      assert.deepEqual(
        [...letterScripts(c.input)].sort(),
        c.scripts,
        `scripts ${reprStr(c.input)}`,
      );
      assert.equal(isMixedScript(c.input), c.mixed, `mixed ${reprStr(c.input)}`);
    }
  });

  test("display", () => {
    for (const c of F.display) assert.equal(display(c.input), c.output, reprStr(c.input));
  });

  test("repr", () => {
    for (const c of F.repr) assert.equal(reprStr(c.input), c.output);
  });

  test("email pattern", () => {
    for (const c of F.email_pattern) assert.equal(EMAIL_PATTERN.test(c.input), c.match, c.input);
  });

  test("directory lookups", () => {
    const d = Directory.load();
    for (const [raw, email] of Object.entries(F.directory.find_user)) {
      assert.equal(d.findUser(raw)?.email ?? null, email, `findUser(${reprStr(raw)})`);
    }
    for (const [raw, name] of Object.entries(F.directory.find_group)) {
      assert.equal(d.findGroup(raw)?.name ?? null, name, `findGroup(${reprStr(raw)})`);
    }
    for (const [raw, privileged] of Object.entries(F.directory.is_privileged_group)) {
      assert.equal(d.isPrivilegedGroup(raw), privileged, `isPrivilegedGroup(${reprStr(raw)})`);
    }
    for (const [email, groups] of Object.entries(F.directory.privileged_memberships)) {
      const user = d.findUser(email);
      assert.ok(user);
      assert.deepEqual(d.privilegedMemberships(user), groups);
    }
    for (const [email, ids] of Object.entries(F.directory.devices_for)) {
      assert.deepEqual(
        d.devicesFor(email).map((x) => x.id),
        ids,
      );
    }
  });
});

test("validateArgs gives the same message for every case", () => {
  for (const c of F.validate_args) {
    const spec = TOOLS.get(c.tool) as ToolSpec;
    assert.equal(validateArgs(spec, c.args), c.error, `${c.tool} ${JSON.stringify(c.args)}`);
  }
});

test("API tool definitions are identical", () => {
  assert.deepEqual(apiToolDefinitions(), F.api_tool_definitions);
  assert.equal(JSON.stringify(apiToolDefinitions()), JSON.stringify(F.api_tool_definitions));
});

describe(`gate: ${F.gate.length} cases, outcome bytes, fingerprints, proposals and audit`, () => {
  for (const c of F.gate) {
    test(c.name, async () => {
      const proposals: Proposal[] = [];
      const { gate, audit, escalations } = makeGate({
        requester: c.requester,
        ticketId: "T-PARITY",
        approver: async (p) => {
          proposals.push(p);
          return c.approver === "approve";
        },
      });
      for (const [i, step] of c.steps.entries()) {
        const outcome = await gate.execute(step.tool, step.args);
        const expected = c.outcomes[i];
        assert.ok(expected);
        assert.equal(outcome.decision, expected.decision);
        assert.equal(outcome.isError, expected.is_error);
        assert.equal(outcome.content, expected.content);
        assert.deepEqual(await resultFingerprint(outcome.content), [
          expected.result_sha256,
          expected.result_bytes,
        ]);
      }
      assert.deepEqual(
        proposals.map((p) => ({
          tool: p.tool,
          args: p.args,
          description: p.description,
          requester: p.requester,
          target: p.target,
          requester_is_target: p.requesterIsTarget,
        })),
        c.proposals,
      );
      assert.deepEqual(withoutTs(audit.records), c.audit);
      assert.deepEqual(escalations.saved, c.escalations);
    });
  }
});
