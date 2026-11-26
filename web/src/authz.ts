/**
 * Who may see and ask for what (identity phase I1, docs/identity-plan.md). Code, not
 * prompt: the gate applies these to the verified requester.
 *
 * Reads: the target, the target's direct manager and `it-support` see the full record;
 * anyone else gets the directory card (no groups, MFA state or devices). The policy checks
 * inside tools still read the full record; only what goes back to the model is filtered.
 *
 * Writes: the target is the requester or a direct report, or the requester is in
 * `it-support` and asks for `reset_mfa` on an active, non-privileged user outside the
 * authority groups (the helpdesk role, decided 2026-11-25). Anything else is refused before the operator is asked.
 *
 * Group membership is read from the directory at call time, never from a token, so a
 * change takes effect on the next call.
 */
import { type Directory, normalize, type User } from "./directory.ts";

export const HELPDESK_GROUP = "it-support";

/**
 * Groups that give authority over other users' accounts. The agent never grants them,
 * even with approval: `it-support` isn't flagged privileged in the data and its name
 * matches no privileged marker, so without this an approver could hand it out.
 */
export const AUTHORITY_GROUPS: ReadonlySet<string> = new Set(["it-support", "directory-admins"]);

export const CARD_FIELDS = ["email", "name", "department", "title", "manager", "status"] as const;

export const RESTRICTED_NOTE =
  "Restricted view: groups, MFA state and devices are shown only to the user, their manager and IT support.";

export type View = "full" | "card";

const inGroup = (user: User, group: string) =>
  user.groups.some((g) => normalize(g) === normalize(group));

function isHelpdesk(directory: Directory, email: string): boolean {
  const user = directory.findUser(email);
  return user !== null && user.status === "active" && inGroup(user, HELPDESK_GROUP);
}

const same = (a: string | null | undefined, b: string) => !!a && normalize(a) === normalize(b);

/** How much of `target`'s record `requester` may see. */
export function readView(directory: Directory, requester: string, target: User): View {
  if (same(target.email, requester)) return "full";
  if (same(target.manager, requester)) return "full";
  if (isHelpdesk(directory, requester)) return "full";
  return "card";
}

/** The directory card: what a colleague may see. */
export function card(user: User): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of CARD_FIELDS) out[field] = user[field];
  out.view = RESTRICTED_NOTE;
  return out;
}

export function isAuthorityGroup(name: string): boolean {
  return AUTHORITY_GROUPS.has(normalize(name));
}

/**
 * Null when `requester` may ask for `tool` on `target`, else the reason it may not (the
 * gate reports it as a policy refusal, and the approver is never asked).
 */
export function mayRequest(
  directory: Directory,
  requester: string,
  tool: string,
  target: User,
): string | null {
  if (same(target.email, requester) || same(target.manager, requester)) return null;
  if (
    tool === "reset_mfa" &&
    isHelpdesk(directory, requester) &&
    target.status === "active" &&
    directory.privilegedMemberships(target).length === 0 &&
    // Accounts with authority over others (another helpdesk member, an admin) are not
    // "ordinary": resetting their MFA is an account-takeover path, so it needs a human
    // outside the helpdesk role. A helpdesk member may still reset their own (self, above).
    !target.groups.some(isAuthorityGroup)
  ) {
    return null;
  }
  return (
    `${target.email} is not the requester or someone who reports to them, so this ` +
    "request must come from that person or their manager; escalate if IT needs to look."
  );
}
