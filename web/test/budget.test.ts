// The public site's own spending limit (src/budget.ts).
import assert from "node:assert/strict";
import { test } from "node:test";

import { BudgetLedger, type BudgetLimits, type DayLedger, visitorKey } from "../src/budget.ts";

const LIMITS: BudgetLimits = {
  dailyUsd: 0.1,
  askPerVisitor: 3,
  askGlobal: 5,
  sessionsPerVisitor: 2,
};

function ledger(start = "2026-11-26T10:00:00Z", limits = LIMITS) {
  let day: DayLedger | undefined;
  let now = new Date(start);
  const l = new BudgetLedger(
    {
      load: async () => (day ? structuredClone(day) : undefined),
      save: async (d) => {
        day = structuredClone(d);
      },
    },
    limits,
    () => now,
  );
  return { l, setNow: (s: string) => (now = new Date(s)), day: () => day };
}

test("reserves only while spent + reserved + the worst case stays under the daily cap", async () => {
  const { l } = ledger();
  const a = await l.reserveAsk("v1", 0.04);
  const b = await l.reserveAsk("v2", 0.04);
  const c = await l.reserveAsk("v3", 0.04); // 0.12 > 0.10
  assert.ok(a.ok && b.ok);
  assert.equal(c.ok, false);
  if (a.ok) await l.settle(a.id, 0.01); // frees 0.03
  assert.equal((await l.reserveAsk("v3", 0.04)).ok, true);
});

test("per-visitor and global question limits", async () => {
  const { l } = ledger(undefined, { ...LIMITS, dailyUsd: 100 });
  for (let i = 0; i < 3; i++) assert.ok((await l.reserveAsk("v1", 0.01)).ok);
  assert.equal((await l.reserveAsk("v1", 0.01)).ok, false); // per visitor
  assert.ok((await l.reserveAsk("v2", 0.01)).ok);
  assert.ok((await l.reserveAsk("v3", 0.01)).ok);
  assert.equal((await l.reserveAsk("v4", 0.01)).ok, false); // global: 5
});

test("a new UTC day starts a fresh ledger", async () => {
  const { l, setNow } = ledger();
  for (let i = 0; i < 3; i++) await l.reserveAsk("v1", 0.01);
  assert.equal((await l.reserveAsk("v1", 0.01)).ok, false);
  setNow("2026-11-27T00:00:01Z");
  assert.ok((await l.reserveAsk("v1", 0.01)).ok);
});

test("settling: unknown cost keeps the whole reservation; unknown ids are ignored", async () => {
  const { l, day } = ledger();
  const r = await l.reserveAsk("v1", 0.05);
  assert.ok(r.ok);
  if (r.ok) await l.settle(r.id, Number.NaN);
  assert.equal(day()?.spentUsd, 0.05);
  assert.equal(day()?.reservedUsd, 0);
  await l.settle("not-a-reservation", 1);
  assert.equal(day()?.spentUsd, 0.05);
  if (r.ok) await l.settle(r.id, 0); // settling twice does nothing
  assert.equal(day()?.spentUsd, 0.05);
});

test("an unsettled reservation stays reserved (a crash spends less, never more)", async () => {
  const { l } = ledger();
  await l.reserveAsk("v1", 0.06);
  assert.equal((await l.reserveAsk("v2", 0.06)).ok, false);
});

test("invalid reservations are refused", async () => {
  const { l } = ledger();
  for (const worst of [0, -1, Number.NaN])
    assert.equal((await l.reserveAsk("v1", worst)).ok, false);
});

test("sessions per visitor", async () => {
  const { l } = ledger();
  assert.ok(await l.allowSession("v1"));
  assert.ok(await l.allowSession("v1"));
  assert.equal(await l.allowSession("v1"), false);
  assert.ok(await l.allowSession("v2"));
});

test("visitor keys are salted hashes: stable for a day, never the IP", async () => {
  const day = new Date("2026-11-26T12:00:00Z");
  const a = await visitorKey("203.0.113.7", "salt", day);
  assert.equal(a, await visitorKey("203.0.113.7", "salt", day));
  assert.notEqual(a, await visitorKey("203.0.113.7", "other", day));
  assert.notEqual(a, await visitorKey("203.0.113.7", "salt", new Date("2026-11-27T12:00:00Z")));
  assert.ok(!a.includes("203"));
});
