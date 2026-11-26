/**
 * The governance gate: the only path from a model's tool call to a tool. Port of
 * `helpdesk_agent/governance.py`.
 *
 * Order of checks for every call, each audited:
 *
 * 1. Allowlist: unknown tool names are rejected.
 * 2. Input validation: exact schema match (required keys, string types, length, no
 *    extras), then field rules: `email` must be a lowercase `@example.test` address and
 *    `group` must not mix scripts.
 * 3. Policy check: privileged groups, disabled accounts and the like are refused before a
 *    human is ever asked, so an approval can't override them.
 * 4. Write gate: write tools show the operator exactly what will happen and need an
 *    explicit approval (`true`, nothing else).
 * 5. Run, with any exception turned into an error result (fail closed).
 *
 * Every audit record carries `result_sha256` and `result_bytes` for the exact text
 * returned to the model, so what the model saw can be proved later without logging it.
 *
 * Differences from Python, all forced by the runtime: `execute` and the approver are
 * async (a Worker can't block waiting for a click), and the clock, escalation store and
 * audit sink are passed in instead of using files.
 */
import type { AuditSink } from "./audit.ts";
import { card, mayRequest, readView } from "./authz.ts";
import { type Directory, isMixedScript, normalize } from "./directory.ts";
import { Principal } from "./identity.ts";
import { compareCodePoints, pyJsonDumps, pyLen, pyRepr, pyStrip } from "./pycompat.ts";
import {
  type Args,
  type EscalationStore,
  PolicyDenied,
  type Retriever,
  TOOLS,
  type ToolContext,
  ToolError,
  ToolKind,
  type ToolSpec,
} from "./tools.ts";

/** Reads that return a person's record: filtered by `readView`. */
const FILTERED_READS: ReadonlySet<string> = new Set(["lookup_user", "list_devices"]);

export const DENIED_BY_HUMAN =
  "Denied by human operator. Do not retry this action. Tell the requester it was not " +
  "approved, or escalate if they need follow-up.";

export const Decision = {
  ALLOWED: "allowed", // read or write-lite, ran without approval
  APPROVED: "approved", // write, the operator approved
  DENIED_BY_HUMAN: "denied_by_human",
  DENIED_BY_POLICY: "denied_by_policy",
  UNKNOWN_TOOL: "unknown_tool",
  INVALID_INPUT: "invalid_input",
  TOOL_ERROR: "tool_error", // ordinary failure, e.g. no such user
  INTERNAL_ERROR: "internal_error", // bug or unexpected state; nothing was changed
} as const;
export type Decision = (typeof Decision)[keyof typeof Decision];

export const Approval = {
  NOT_REQUIRED: "not_required", // read or write-lite tool
  NOT_ASKED: "not_asked", // stopped before the prompt (unknown, invalid, policy, error)
  APPROVED: "approved",
  DENIED: "denied",
} as const;
export type Approval = (typeof Approval)[keyof typeof Approval];

/**
 * Rule 2, matched against the raw argument: no uppercase, no padding, no look-alike
 * letters, no other domains. Without the `m` flag, `$` matches only at the very end, so
 * a trailing newline fails (as Python's `\Z` does).
 */
export const EMAIL_PATTERN = /^[a-z0-9._-]+@example\.test$/;

export interface Proposal {
  readonly tool: string;
  readonly args: Args;
  readonly description: string;
  readonly requester: string; // who filed the ticket, from the harness
  readonly target: string; // whose account the write changes
  readonly requesterIsTarget: boolean;
}

export interface Outcome {
  /** What goes back to the model as the tool_result, plus the decision for the audit. */
  readonly decision: Decision;
  readonly content: string;
  readonly isError: boolean;
}

/** Resolves true only to approve. Any other value, a rejection or a throw denies. */
export type Approver = (proposal: Proposal) => Promise<unknown> | unknown;

/** Approver for evals and CI: every write is denied, so nothing is ever changed. */
export const denyAll: Approver = async () => false;

/** SHA-256 (hex) and UTF-8 length of a tool result, as recorded in the audit log. */
export async function resultFingerprint(content: string): Promise<[string, number]> {
  const bytes = new TextEncoder().encode(content);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const hex = [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
  return [hex, bytes.length];
}

// ---------------------------------------------------------------- validation

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * An error message if `args` doesn't match the tool's schema, else null. Supports exactly
 * what our schemas use: an object of required, non-empty strings with optional maxLength
 * and no additional properties.
 */
export function validateArgs(spec: ToolSpec, args: unknown): string | null {
  const schema = spec.inputSchema;
  if (!isObject(args)) return "Arguments must be a JSON object.";
  const allowed = new Set(Object.keys(schema.properties));
  const extra = Object.keys(args)
    .filter((k) => !allowed.has(k))
    .sort(compareCodePoints);
  if (extra.length > 0) return `Unexpected argument(s): ${extra.join(", ")}.`;
  const missing = schema.required.filter((k) => !Object.hasOwn(args, k));
  if (missing.length > 0) return `Missing required argument(s): ${missing.join(", ")}.`;
  for (const [key, prop] of Object.entries(schema.properties)) {
    const value = args[key];
    if (prop.type === "string") {
      if (typeof value !== "string") return `${key} must be a string.`;
      if (!pyStrip(value)) return `${key} must not be empty.`;
      if (prop.maxLength !== undefined && pyLen(value) > prop.maxLength) {
        return `${key} is longer than ${prop.maxLength} characters.`;
      }
    }
  }
  return checkFields(args);
}

/** Field rules that apply whichever tool the field belongs to. */
function checkFields(args: Record<string, unknown>): string | null {
  const email = args.email;
  if (typeof email === "string" && !EMAIL_PATTERN.test(email)) {
    return (
      "email must be a lowercase address at example.test (letters, digits, '.', '_', " +
      "'-'), with no spaces or other characters."
    );
  }
  const group = args.group;
  if (typeof group === "string" && isMixedScript(group)) {
    return "group mixes letters from different alphabets; use the exact group name.";
  }
  return null;
}

// ---------------------------------------------------------------- the gate

export interface GateOptions {
  directory: Directory;
  approver: Approver;
  audit: AuditSink;
  escalations: EscalationStore;
  retriever: Retriever;
  ticketId: string;
  /**
   * Who filed the ticket: a verified identity (identity phase I1), never a string. The
   * model never supplies it, and `Gate` refuses anything that isn't a real `Principal`.
   */
  principal: Principal;
  clock?: () => Date;
}

interface FinishOptions {
  error?: boolean;
  summary?: string | null;
  approval?: Approval;
  reason?: string | null;
}

export class Gate {
  readonly ctx: ToolContext;
  readonly principal: Principal;
  private readonly approver: Approver;
  private readonly audit: AuditSink;

  constructor(options: GateOptions) {
    if (!Principal.is(options.principal)) {
      throw new TypeError("Gate needs a verified Principal, not a string or a copy");
    }
    const requester = options.principal.sub;
    if (!EMAIL_PATTERN.test(requester)) {
      throw new TypeError("requester must be a lowercase @example.test address");
    }
    this.principal = options.principal;
    this.approver = options.approver;
    this.audit = options.audit;
    this.ctx = {
      directory: options.directory,
      escalations: options.escalations,
      retriever: options.retriever,
      clock: options.clock ?? (() => new Date()),
      nextSeq: (() => {
        let seq = 0;
        return () => seq++;
      })(),
      ticketId: options.ticketId,
      requester,
    };
  }

  async execute(name: string, args: unknown): Promise<Outcome> {
    const spec = typeof name === "string" ? TOOLS.get(name) : undefined;
    if (spec === undefined) {
      return this.finish(name, null, args, Decision.UNKNOWN_TOOL, `Unknown tool ${pyRepr(name)}.`, {
        error: true,
      });
    }

    const problem = validateArgs(spec, args);
    if (problem !== null) {
      return this.finish(name, spec, args, Decision.INVALID_INPUT, problem, { error: true });
    }
    const valid = args as Args;

    // Identity phase I1: may this requester ask for this write at all? Checked before the
    // policy checks and before any operator is asked. An unknown target falls through to
    // the tool's own "no such user" error.
    if (spec.kind === ToolKind.WRITE) {
      const target = this.ctx.directory.findUser(valid.email as string);
      const refusal = target && mayRequest(this.ctx.directory, this.ctx.requester, name, target);
      if (refusal) {
        return this.finish(
          name,
          spec,
          valid,
          Decision.DENIED_BY_POLICY,
          `Refused by policy: ${refusal}`,
          {
            error: true,
          },
        );
      }
    }

    try {
      spec.check?.(this.ctx, valid);
    } catch (exc) {
      if (exc instanceof PolicyDenied) {
        return this.finish(
          name,
          spec,
          valid,
          Decision.DENIED_BY_POLICY,
          `Refused by policy: ${exc.message}`,
          { error: true },
        );
      }
      if (exc instanceof ToolError) {
        return this.finish(name, spec, valid, Decision.TOOL_ERROR, exc.message, { error: true });
      }
      return this.internalError(name, spec, valid, exc, Approval.NOT_ASKED);
    }

    let decision: Decision = Decision.ALLOWED;
    let approval: Approval = Approval.NOT_REQUIRED;
    let reason = `${spec.kind} tool on the allowlist; arguments valid`;
    if (spec.kind === ToolKind.WRITE) {
      let proposal: Proposal;
      let approved: boolean;
      try {
        if (spec.describe === undefined) throw new Error("write tool without describe");
        const target = valid.email as string;
        proposal = {
          tool: name,
          args: { ...valid },
          description: spec.describe(this.ctx, valid),
          requester: this.ctx.requester,
          target,
          requesterIsTarget: normalize(this.ctx.requester) === normalize(target),
        };
        approved = (await this.approver(proposal)) === true;
      } catch (exc) {
        return this.internalError(name, spec, valid, exc, Approval.NOT_ASKED);
      }
      if (!approved) {
        return this.finish(name, spec, valid, Decision.DENIED_BY_HUMAN, DENIED_BY_HUMAN, {
          error: true,
          approval: Approval.DENIED,
          reason: "operator did not type y",
        });
      }
      decision = Decision.APPROVED;
      approval = Approval.APPROVED;
      reason = "passed policy checks; operator typed y";
      // Record the approval before acting. If the audit sink rejects, the write never
      // happens.
      await this.audit.record("write_approved", {
        ticket_id: this.ctx.ticketId,
        requester: this.ctx.requester,
        requester_is_target: proposal.requesterIsTarget,
        tool: name,
        args: valid,
        effect: proposal.description,
      });
    }

    let result: Record<string, unknown>;
    let summary: string;
    try {
      [result, summary] = await spec.run(this.ctx, valid);
    } catch (exc) {
      if (exc instanceof ToolError) {
        return this.finish(name, spec, valid, Decision.TOOL_ERROR, exc.message, {
          error: true,
          approval,
        });
      }
      return this.internalError(name, spec, valid, exc, approval);
    }

    // Reads of another person's record are filtered to the directory card unless the
    // requester is that person, their manager or IT support. The tool ran on the full
    // record; only what goes back to the model (and is fingerprinted) is reduced.
    if (FILTERED_READS.has(name)) {
      const target = this.ctx.directory.findUser(valid.email as string);
      if (target && readView(this.ctx.directory, this.ctx.requester, target) === "card") {
        result = card(target);
        summary = `${summary} (restricted view)`;
        reason = `${reason}; restricted view`;
      }
    }

    return this.finish(name, spec, valid, decision, pyJsonDumps(result), {
      summary,
      approval,
      reason,
    });
  }

  // ------------------------------------------------------------ internals

  private internalError(
    name: string,
    spec: ToolSpec,
    args: unknown,
    exc: unknown,
    approval: Approval,
  ): Promise<Outcome> {
    // The model gets a generic message; the exception type goes to the audit log.
    const type = exc instanceof Error ? exc.name : typeof exc;
    return this.finish(
      name,
      spec,
      args,
      Decision.INTERNAL_ERROR,
      "Internal error; nothing was changed. Escalate this ticket.",
      { error: true, summary: type, approval },
    );
  }

  /**
   * Audit one tool call (rule 7) and build what goes back to the model. `reason` says why
   * the decision came out as it did; for refusals and errors it is the message the model
   * sees. `content` itself isn't logged, only its fingerprint.
   */
  private async finish(
    name: string,
    spec: ToolSpec | null,
    args: unknown,
    decision: Decision,
    content: string,
    { error = false, summary = null, approval = Approval.NOT_ASKED, reason = null }: FinishOptions,
  ): Promise<Outcome> {
    const [sha256, size] = await resultFingerprint(content);
    await this.audit.record("tool_call", {
      ticket_id: this.ctx.ticketId,
      requester: this.ctx.requester,
      tool: name,
      kind: spec ? spec.kind : null,
      args: isObject(args) ? args : pyRepr(args),
      decision,
      reason: reason || content,
      approval,
      is_error: error,
      summary: summary || content,
      result_sha256: sha256,
      result_bytes: size,
    });
    return { decision, content, isError: error };
  }
}
