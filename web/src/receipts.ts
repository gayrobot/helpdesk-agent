/**
 * Identity phase I4: approval receipts (docs/identity-plan.md, Tokens).
 *
 * After the operator approves a write, the gate signs a receipt over exactly what was
 * approved: who approved, the ticket, the tool and the SHA-256 of the arguments. It lives
 * 120 seconds and is used once. The write's handler recomputes the hash from the
 * arguments it is about to run and refuses on any difference, so an approval can't be
 * spent on a different target or group ("approve then swap").
 *
 * The receipt is separate from the access token on purpose: the access token stays
 * standard, and an outside issuer can replace ours without touching approvals. The
 * signing key is generated in memory per gate and never leaves this object. Receipts
 * never appear in the prompt, tool results or logs; the audit records the receipt's
 * `jti` and `args_sha256` only.
 */
import {
  b64urlEncode,
  type KeyPair,
  ReplayCache,
  signJws,
  TokenError,
  verifyJwsSignature,
} from "./identity.ts";

export const RECEIPT_SECONDS = 120;
const RECEIPT_TYPE = "approval-receipt+jwt";
const MAX_CLOCK_SKEW_SECONDS = 30;

/** JSON with keys sorted at every level: one byte string per set of arguments. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

export async function argsSha256(args: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(args));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface Receipt {
  readonly approver: string;
  readonly ticketId: string;
  readonly tool: string;
  readonly argsSha256: string;
  readonly jti: string;
}

export class ReceiptAuthority {
  private keys: Promise<KeyPair> | null = null;
  private readonly replay = new ReplayCache();
  private readonly now: () => number;

  constructor(now: () => number = () => Math.floor(Date.now() / 1000)) {
    this.now = now;
  }

  private keyPair(): Promise<KeyPair> {
    this.keys ??= crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
      "sign",
      "verify",
    ]) as Promise<KeyPair>;
    return this.keys;
  }

  /** Sign a receipt for an approved write. Returns the token and the claims it carries. */
  async sign(
    approver: string,
    ticketId: string,
    tool: string,
    args: unknown,
  ): Promise<{ token: string; receipt: Receipt }> {
    const iat = this.now();
    const receipt: Receipt = {
      approver,
      ticketId,
      tool,
      argsSha256: await argsSha256(args),
      jti: b64urlEncode(crypto.getRandomValues(new Uint8Array(16))),
    };
    const token = await signJws(
      { typ: RECEIPT_TYPE },
      {
        approver,
        ticket_id: ticketId,
        tool,
        args_sha256: receipt.argsSha256,
        iat,
        exp: iat + RECEIPT_SECONDS,
        jti: receipt.jti,
      },
      (await this.keyPair()).privateKey,
      "ES256",
    );
    return { token, receipt };
  }

  /** The handler side: the receipt must cover exactly this ticket, tool and arguments. */
  async verify(token: unknown, ticketId: string, tool: string, args: unknown): Promise<Receipt> {
    if (typeof token !== "string" || !token) throw new TokenError("no approval receipt");
    const { header, payload } = await verifyJwsSignature(
      token,
      (await this.keyPair()).publicKey,
      "ES256",
    );
    if (header.typ !== RECEIPT_TYPE) throw new TokenError("not an approval receipt");
    let c: Record<string, unknown>;
    try {
      c = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(payload));
      if (!c || typeof c !== "object" || Array.isArray(c)) throw new Error();
    } catch {
      throw new TokenError("claims are not a JSON object");
    }
    for (const name of ["approver", "ticket_id", "tool", "args_sha256", "iat", "exp", "jti"]) {
      if (!(name in c)) throw new TokenError(`missing claim ${name}`);
    }
    const t = this.now();
    if (!Number.isInteger(c.exp) || !Number.isInteger(c.iat)) {
      throw new TokenError("exp and iat must be integers");
    }
    const exp = c.exp as number;
    const iat = c.iat as number;
    if (exp <= t - MAX_CLOCK_SKEW_SECONDS) throw new TokenError("receipt expired");
    if (iat > t + MAX_CLOCK_SKEW_SECONDS) throw new TokenError("receipt issued in the future");
    if (exp - iat > RECEIPT_SECONDS) throw new TokenError("receipt lives too long");
    if (c.ticket_id !== ticketId) throw new TokenError("receipt is for another ticket");
    if (c.tool !== tool) throw new TokenError("receipt is for another tool");
    if (c.args_sha256 !== (await argsSha256(args))) {
      throw new TokenError("receipt is for different arguments");
    }
    if (typeof c.approver !== "string" || typeof c.jti !== "string" || !c.jti) {
      throw new TokenError("bad receipt claims");
    }
    this.replay.use(c.jti, exp, t);
    return {
      approver: c.approver,
      ticketId,
      tool,
      argsSha256: c.args_sha256 as string,
      jti: c.jti,
    };
  }
}
