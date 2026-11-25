// Twin of tests/test_tools.py. Test names match the Python ones.
//
// Not ported, with reason: the seven tests of `make_tty_approver` (test_tty_approver_*,
// test_prompt_*). The TypeScript agent has no terminal prompt: approval comes from the
// web page (slice 6, whose tests will cover the same rules: exact approval only, every
// field passed through display(), the requester/target mismatch flag) and evals use
// denyAll. The display() cases those tests relied on are kept below.
import assert from "node:assert/strict";
import { test } from "node:test";

import { apiToolDefinitions, display, TOOLS, ToolKind } from "../src/tools.ts";

const EXPECTED: Record<string, ToolKind> = {
  lookup_user: ToolKind.READ,
  search_runbooks: ToolKind.READ,
  list_devices: ToolKind.READ,
  reset_mfa: ToolKind.WRITE,
  add_to_group: ToolKind.WRITE,
  escalate: ToolKind.WRITE_LITE,
};

test("test_registry_is_exactly_the_allowlist", () => {
  assert.deepEqual(Object.fromEntries([...TOOLS].map(([n, s]) => [n, s.kind])), EXPECTED);
});

test("test_every_write_tool_has_check_and_describe", () => {
  for (const spec of TOOLS.values()) {
    if (spec.kind === ToolKind.WRITE) assert.ok(spec.check && spec.describe, spec.name);
  }
});

test("test_api_definitions_are_strict_and_closed", () => {
  const defs = apiToolDefinitions();
  assert.deepEqual(
    defs.map((d) => d.name),
    Object.keys(EXPECTED).sort(),
  );
  for (const d of defs) {
    const schema = d.input_schema;
    assert.equal(d.strict, true);
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(new Set(schema.required), new Set(Object.keys(schema.properties)));
    for (const p of Object.values(schema.properties)) assert.ok(!("maxLength" in p));
  }
});

test("test_api_definitions_do_not_mutate_local_schema", () => {
  apiToolDefinitions();
  assert.equal(TOOLS.get("escalate")?.inputSchema.properties.summary?.maxLength, 2000);
});

test("test_display_strips_control_characters", () => {
  assert.equal(display("Jamie\nApproved: yes\x1b[2J"), "Jamie Approved: yes");
});

for (const [raw, shown] of [
  ["Jamie\x1b[31mRed\x1b[0m", "JamieRed"], // SGR colour
  ["ok\x1b[2K\x1b[1A\rApproved", "ok Approved"], // erase line, cursor up, CR
  ["a\x1b]0;evil title\x07b", "ab"], // OSC window title, BEL-terminated
  ["a\x1b]8;;https://evil.test\x1b\\link\x1b]8;;\x1b\\b", "alinkb"], // OSC 8 hyperlink
  ["a\x9b31mb", "ab"], // 8-bit CSI
  ["a\x1bcb", "ab"], // RIS: full terminal reset
  ["x‮evil", "x evil"], // bidi override
] as const) {
  test(`test_display_removes_ansi_sequences_whole[${JSON.stringify(raw)}]`, () => {
    assert.equal(display(raw), shown);
  });
}

// TypeScript only: the allowlist is a Map, so object-prototype names aren't tools.
test("ts_prototype_names_are_not_tools", () => {
  for (const name of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
    assert.equal(TOOLS.get(name), undefined);
  }
});
