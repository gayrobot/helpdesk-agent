// Checks that the toolchain and the supply-chain settings are what CLAUDE.md requires.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { loadDirectoryData } from "../src/data.ts";

const root = new URL("../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");

test("shared synthetic directory loads, and only example.test addresses", () => {
  const data = loadDirectoryData();
  assert.ok(data.users.length > 0);
  for (const user of data.users) assert.match(user.email, /@example\.test$/);
});

test("loadDirectoryData returns an independent copy", () => {
  const a = loadDirectoryData();
  const first = a.users[0];
  assert.ok(first);
  first.groups.push("changed");
  const b = loadDirectoryData();
  assert.ok(!b.users[0]?.groups.includes("changed"));
});

test(".npmrc keeps the 7-day cooldown, exact pins and no install scripts", () => {
  const settings = new Map(
    read(".npmrc")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => line.split("=").map((s) => s.trim()) as [string, string]),
  );
  assert.equal(settings.get("min-release-age"), "7");
  assert.equal(settings.get("save-exact"), "true");
  assert.equal(settings.get("ignore-scripts"), "true");
});

test("every dependency is pinned to an exact version and locked", () => {
  const pkg = JSON.parse(read("package.json")) as Record<string, Record<string, string>>;
  const lock = JSON.parse(read("package-lock.json")) as {
    packages: Record<string, { version?: string; integrity?: string }>;
  };
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  assert.ok(Object.keys(deps).length > 0);
  for (const [name, version] of Object.entries(deps)) {
    assert.match(version, /^\d+\.\d+\.\d+$/, `${name} must be an exact version, got ${version}`);
    assert.equal(lock.packages[`node_modules/${name}`]?.version, version, `${name} not locked`);
  }
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (path === "") continue;
    assert.ok(entry.integrity, `${path} has no integrity hash in the lockfile`);
  }
});
