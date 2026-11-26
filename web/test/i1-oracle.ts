// An independent prediction of where identity phase I1 makes the TypeScript differ from
// the (frozen) Python agent. Built from the raw directory data, deliberately NOT from
// src/authz.ts, so the parity tests check authz against a second implementation.
import { loadDirectoryData, type RawUser } from "../src/data.ts";
import { pyJsonDumps } from "../src/pycompat.ts";

const RAW = loadDirectoryData();
const BY_EMAIL = new Map(RAW.users.map((u) => [u.email.toLowerCase(), u]));
const PRIVILEGED = new Set(RAW.groups.filter((g) => g.privileged).map((g) => g.name));
const MARKERS = ["admin", "root", "privileged", "super", "approver", "owner"];
const WRITES = new Set(["reset_mfa", "add_to_group"]);
const READS = new Set(["lookup_user", "list_devices"]);
// The note text is data the test needs to rebuild the bytes; it isn't a decision.
const NOTE =
  "Restricted view: groups, MFA state and devices are shown only to the user, their manager and IT support.";

const user = (email: unknown) =>
  typeof email === "string" ? BY_EMAIL.get(email.toLowerCase()) : undefined;
const helpdesk = (u: RawUser | undefined) =>
  !!u && u.status === "active" && u.groups.includes("it-support");
const privileged = (u: RawUser) =>
  u.groups.some((g) => PRIVILEGED.has(g) || MARKERS.some((m) => g.toLowerCase().includes(m)));

export type Prediction =
  | { kind: "same" }
  | { kind: "card"; content: string }
  | { kind: "refused"; contentPrefix: string };

/** What the TypeScript gate should do differently from Python for one step. */
export function predict(
  requester: string,
  tool: string,
  args: unknown,
  pythonDecision: string,
): Prediction {
  if (pythonDecision === "unknown_tool" || pythonDecision === "invalid_input")
    return { kind: "same" };
  const email = (args as Record<string, unknown> | null)?.email;
  const target = user(email);
  if (!target) return { kind: "same" }; // unknown user: the tool's own error, as before
  const self = target.email === requester;
  const manager = target.manager === requester;
  if (READS.has(tool) && pythonDecision === "allowed") {
    if (self || manager || helpdesk(user(requester))) return { kind: "same" };
    const card = {
      email: target.email,
      name: target.name,
      department: target.department,
      title: target.title,
      manager: target.manager,
      status: target.status,
      view: NOTE,
    };
    return { kind: "card", content: pyJsonDumps(card) };
  }
  if (WRITES.has(tool)) {
    if (self || manager) return { kind: "same" };
    const helpdeskReset =
      tool === "reset_mfa" &&
      helpdesk(user(requester)) &&
      target.status === "active" &&
      !privileged(target) &&
      !target.groups.some((g) => g === "it-support" || g === "directory-admins");
    if (helpdeskReset) return { kind: "same" };
    return {
      kind: "refused",
      contentPrefix: `Refused by policy: ${target.email} is not the requester or someone who reports to them`,
    };
  }
  return { kind: "same" };
}

/** Whether Python asked the approver at this step. */
export const reachedApprover = (pythonDecision: string) =>
  pythonDecision === "approved" || pythonDecision === "denied_by_human";
