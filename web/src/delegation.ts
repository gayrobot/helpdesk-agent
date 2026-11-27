/**
 * Identity phase I2: no tool runs without a delegated token (docs/identity-plan.md).
 *
 * Each tool belongs to one resource server and needs one scope. For every call the gate
 * asks the harness's `SignIn` for a fresh grant (token exchange), and `runWithGrant`, the
 * handler side, verifies it before the tool runs: right audience, exactly the scope, this
 * ticket, the agent acting for this requester, unexpired, never used before, and the
 * requester's directory account (looked up now, not when the token was minted) not
 * disabled. Anything else throws `GrantError` and nothing runs.
 */
import { type Grant, type Resources, TokenError } from "./identity.ts";
import type { Args, ToolContext, ToolResult, ToolSpec } from "./tools.ts";

export interface ToolGrant {
  readonly audience: string;
  readonly scope: string;
}

/** The scope and audience each tool needs (docs/identity-plan.md, Tokens). */
export const TOOL_GRANTS: Readonly<Record<string, ToolGrant>> = {
  lookup_user: { audience: "larkspur-directory", scope: "directory:read" },
  list_devices: { audience: "larkspur-directory", scope: "devices:read" },
  search_runbooks: { audience: "larkspur-runbooks", scope: "runbooks:read" },
  reset_mfa: { audience: "larkspur-directory", scope: "directory:mfa.reset" },
  add_to_group: { audience: "larkspur-directory", scope: "directory:group.add" },
  escalate: { audience: "larkspur-tickets", scope: "tickets:escalate" },
};

export class GrantError extends Error {
  override name = "GrantError";
}

export function toolGrant(tool: string): ToolGrant {
  const grant = Object.hasOwn(TOOL_GRANTS, tool) ? TOOL_GRANTS[tool] : undefined;
  if (!grant) throw new GrantError(`no grant is defined for ${tool}`);
  return grant;
}

/**
 * The handler side: verify `token` for this tool and this call, then run the tool.
 * Returns the tool's result and the verified grant (for the audit record).
 */
export async function runWithGrant(
  spec: ToolSpec,
  ctx: ToolContext,
  args: Args,
  token: unknown,
  resources: Resources,
): Promise<{ result: ToolResult; grant: Grant }> {
  const needed = toolGrant(spec.name);
  let grant: Grant;
  try {
    grant = await resources.get(needed.audience).verify(token, needed.scope, ctx.ticketId);
  } catch (exc) {
    if (exc instanceof TokenError) throw new GrantError(`grant refused: ${exc.message}`);
    throw exc;
  }
  if (grant.sub !== ctx.requester) throw new GrantError("grant refused: grant is for someone else");
  const account = ctx.directory.findUser(grant.sub);
  if (account && account.status !== "active") {
    throw new GrantError("grant refused: the requester's account is not active");
  }
  return { result: await spec.run(ctx, args), grant };
}
