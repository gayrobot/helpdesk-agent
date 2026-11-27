/**
 * Identity phase I2: no tool runs without a delegated token (docs/identity-plan.md).
 *
 * Each tool belongs to one resource server and needs one scope. For every call the gate
 * asks the harness's `SignIn` for a fresh grant (token exchange), and `runWithGrant`, the
 * handler side, verifies it before the tool runs: right audience, exactly the scope, this
 * ticket, the agent acting for this requester, unexpired, never used before, and the
 * requester's directory account (looked up now, not when the token was minted) not
 * disabled. Anything else throws `GrantError` and nothing runs.
 *
 * Identity phase I4: a write also needs the gate's approval receipt, covering exactly this
 * ticket, tool and arguments (recomputed here), approved by someone other than the
 * requester, and used once.
 */
import { type Grant, type Resources, TokenError } from "./identity.ts";
import type { Receipt, ReceiptAuthority } from "./receipts.ts";
import { type Args, type ToolContext, ToolKind, type ToolResult, type ToolSpec } from "./tools.ts";

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

/** A write's approval receipt and the authority that signed it. */
export interface ApprovalProof {
  token: unknown;
  authority: ReceiptAuthority;
}

/**
 * The handler side: verify `token` (and, for a write, the approval receipt) for this tool
 * and this call, then run the tool. Returns the result plus the verified grant and
 * receipt, for the audit record.
 */
export async function runWithGrant(
  spec: ToolSpec,
  ctx: ToolContext,
  args: Args,
  token: unknown,
  resources: Resources,
  approval: ApprovalProof | null = null,
): Promise<{ result: ToolResult; grant: Grant; receipt: Receipt | null }> {
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
  let receipt: Receipt | null = null;
  if (spec.kind === ToolKind.WRITE) {
    if (!approval) throw new GrantError("receipt refused: no approval receipt");
    try {
      receipt = await approval.authority.verify(approval.token, ctx.ticketId, spec.name, args);
    } catch (exc) {
      if (exc instanceof TokenError) throw new GrantError(`receipt refused: ${exc.message}`);
      throw exc;
    }
    if (receipt.approver === grant.sub) {
      throw new GrantError("receipt refused: the requester approved their own request");
    }
  }
  return { result: await spec.run(ctx, args), grant, receipt };
}
