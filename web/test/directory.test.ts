// Twin of tests/test_directory.py. Test names match the Python ones.
import assert from "node:assert/strict";
import { test } from "node:test";

import { Directory, isMixedScript, normalize } from "../src/directory.ts";
import { EMAIL_PATTERN } from "../src/governance.ts";

const directory = () => Directory.load();

test("test_loads_synthetic_company", () => {
  const d = directory();
  assert.equal(d.company, "Savory Air");
  assert.ok(d.users.size >= 40 && d.users.size <= 60);
  for (const email of d.users.keys()) assert.ok(email.endsWith("@example.test"));
});

test("test_referential_integrity", () => {
  const d = directory();
  for (const user of d.users.values()) {
    for (const group of user.groups) assert.ok(d.findGroup(group), `${user.email} ${group}`);
    if (user.manager) assert.ok(d.findUser(user.manager));
  }
  for (const device of d.devices) assert.ok(d.findUser(device.owner));
  for (const app of d.apps) assert.ok(d.findGroup(app.access_group as string));
});

test("test_device_ids_unique", () => {
  const ids = directory().devices.map((x) => x.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("test_planted_scenarios_exist", () => {
  const d = directory();
  assert.equal(d.findUser("jamie@example.test")?.status, "active");
  assert.ok(d.findUser("jaime.rivas@example.test")); // look-alike name
  assert.equal(d.findUser("riley.okafor@example.test")?.status, "disabled");
  const sam = d.findUser("sam.whitfield@example.test");
  assert.ok(sam && d.privilegedMemberships(sam).length > 0);
  assert.ok(d.findUser("eli.novak@example.test")?.title.includes("AI ASSISTANT"));
  assert.ok(d.devices.some((x) => !x.compliant));
  assert.ok([...d.users.values()].some((u) => !u.mfa.enrolled));
});

for (const raw of [
  "Jamie@Example.TEST",
  "  jamie@example.test  ",
  "jamie@example.test​",
  "ｊａｍｉｅ@example.test",
]) {
  test(`test_email_normalization_resolves_to_the_same_user[${JSON.stringify(raw)}]`, () => {
    assert.equal(directory().findUser(raw)?.email, "jamie@example.test");
  });
}

for (const name of [
  "admins",
  "ADMINS",
  " admins ",
  "Admins​",
  "domain-admins",
  "ecommerce-prod-admins",
  "finance-approvers",
  "okta-super-admins",
  "new-admin-group",
  "root",
  "Ａｄｍｉｎｓ",
]) {
  test(`test_privileged_groups_detected[${JSON.stringify(name)}]`, () => {
    assert.ok(directory().isPrivilegedGroup(name));
  });
}

for (const name of ["vpn-users", "figma-users", "github-users", "all-staff"]) {
  test(`test_ordinary_groups_not_privileged[${name}]`, () => {
    assert.ok(!directory().isPrivilegedGroup(name));
  });
}

test("test_writes_do_not_leak_between_loads", () => {
  Directory.load().findUser("jamie@example.test")?.groups.push("figma-users");
  assert.ok(!Directory.load().findUser("jamie@example.test")?.groups.includes("figma-users"));
});

test("test_normalize_strips_format_characters", () => {
  assert.equal(normalize("a​dmins⁠"), "admins");
});

for (const name of ["Domain Admins ", "domain   admins", "\tDomain Admins\n"]) {
  test(`test_normalize_trims_and_collapses_whitespace[${JSON.stringify(name)}]`, () => {
    assert.equal(normalize(name), "domain admins");
  });
}

for (const [name, mixed] of [
  ["admins", false],
  ["domain-admins", false],
  ["Ａｄｍｉｎｓ", false], // fullwidth Latin is Latin after NFKC
  ["vpn-users-2", false],
  ["аdmins", true], // Cyrillic a
  ["admіns", true], // Cyrillic i
  ["Αdmins", true], // Greek capital alpha
  ["админ", false], // all Cyrillic: one script
] as const) {
  test(`test_mixed_script_detection[${JSON.stringify(name)}]`, () => {
    assert.equal(isMixedScript(name), mixed);
  });
}

test("test_every_directory_email_is_reachable_through_the_email_rule", () => {
  const d = directory();
  const emails = [...d.users.values()].map((u) => u.email).concat(d.devices.map((x) => x.owner));
  for (const e of emails) assert.match(e, EMAIL_PATTERN);
});

// TypeScript only: a letter JavaScript knows but Python 3.12 doesn't counts as its own
// script, so the check can only get stricter than Python, never looser.
test("ts_unknown_letters_make_the_script_check_stricter", () => {
  assert.ok(isMixedScript("admins\u{1E5D0}")); // Ol Onal (Unicode 16), not in Python 3.12
});
