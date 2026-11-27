/**
 * Identity phase I3: permission-filtered retrieval (docs/identity-plan.md).
 *
 * - **ACL manifest.** `RUNBOOK_ACL` maps every runbook to the groups that may read it. A
 *   runbook with no entry, or an entry naming a group that doesn't exist, fails the load.
 *   The 14 shared runbooks are `all-staff`, so retrieval numbers for ordinary staff are
 *   unchanged. Everyone, including the anonymous guest, reads as `all-staff`.
 * - **Restricted runbooks.** Three synthetic ones below, each with a canary string. They
 *   live only in the TypeScript code: the frozen Python agent's corpus is unchanged.
 * - **Filter before ranking.** `AclCorpus.forReader(groups)` builds a retriever over only
 *   the chunks that reader may see, so BM25's statistics come from the visible subset and
 *   hidden text never enters the candidates, the scores or the context. One retriever per
 *   audience (the set of readable runbooks), cached; never one shared across audiences.
 * - **No existence oracle.** A search whose only matches are hidden returns exactly what
 *   a search with no matches returns.
 * - **Groups are read at call time.** `search_runbooks` asks the directory for the
 *   requester's groups on every call, so removing someone from a group hides the runbook
 *   on their next search.
 */
import type { Directory } from "./directory.ts";
import { type Chunk, chunksFrom, type RankingRetriever } from "./retrieval.ts";
import type { Retriever, RunbookHit } from "./tools.ts";

export const EVERYONE = "all-staff";

export const RESTRICTED_RUNBOOKS: Readonly<Record<string, string>> = {
  "break-glass-accounts": `# Break-glass accounts

Emergency admin accounts for when Okta itself is down. Synthetic runbook for helpdesk-agent, restricted to IT support. Reference code CANARY-RB-ACL-1.

## When break-glass access is allowed

Only during a declared identity outage, when no admin can sign in through Okta. The on-call IT lead declares the outage in the incident channel before anyone opens the vault.

## Opening the vault

Two members of IT support open the sealed envelope together. One reads the account name and the other types the passphrase. Both sign the access log with the time.

## After the outage

Rotate both break-glass passphrases within 24 hours, reseal new envelopes and file a post-incident review.
`,
  "privileged-access-review": `# Privileged access review

The quarterly review of who holds admin and production groups. Synthetic runbook for helpdesk-agent, restricted to IT support. Reference code CANARY-RB-ACL-2.

## What is reviewed

Every member of admins, domain-admins, okta-super-admins, aws-prod-admins and finance-approvers. Each group owner confirms or removes each member.

## Running the review

Export the group memberships on the first business day of the quarter. Owners have ten business days to answer. Anyone not confirmed by the deadline is removed.

## Evidence

Keep the export, each owner's answer and the removal tickets for two years for the auditors.
`,
  "compensation-letters": `# Compensation letters

How People Ops prepares and sends salary change letters. Synthetic runbook for helpdesk-agent, restricted to People Ops. Reference code CANARY-RB-ACL-3.

## Preparing letters

Letters are drafted from the approved compensation sheet, one per employee, and checked by a second People Ops partner before sending.

## Sending

Letters go out through the HR system's secure inbox, never as email attachments. The employee's manager is copied only after the employee has opened theirs.
`,
};

/** Which groups may read each runbook. Every runbook needs an entry. */
export const RUNBOOK_ACL: Readonly<Record<string, readonly string[]>> = {
  "access-requests": [EVERYONE],
  "email-and-calendar": [EVERYONE],
  "jamf-enrollment": [EVERYONE],
  "lost-or-stolen-device": [EVERYONE],
  "new-hire-onboarding": [EVERYONE],
  offboarding: [EVERYONE],
  "office-wifi-and-printing": [EVERYONE],
  "okta-verify-reenrollment": [EVERYONE],
  "password-policy": [EVERYONE],
  "phishing-reporting": [EVERYONE],
  "software-requests": [EVERYONE],
  "vpn-setup": [EVERYONE],
  "vpn-troubleshooting": [EVERYONE],
  "windows-intune-enrollment": [EVERYONE],
  "break-glass-accounts": ["it-support"],
  "privileged-access-review": ["it-support"],
  "compensation-letters": ["people-ops"],
};

export class AclError extends Error {
  override name = "AclError";
}

/** A retriever that can produce a filtered view for one reader. */
export interface AudienceRetriever extends Retriever {
  forReader(groups: ReadonlySet<string>): Retriever;
}

export function isAudienceRetriever(r: Retriever): r is AudienceRetriever {
  return typeof (r as Partial<AudienceRetriever>).forReader === "function";
}

/** The groups a requester reads as, looked up now. Disabled or unknown: everyone only. */
export function readerGroups(directory: Directory, requester: string): Set<string> {
  const user = directory.findUser(requester);
  const groups = new Set([EVERYONE]);
  if (user && user.status === "active") for (const g of user.groups) groups.add(g);
  return groups;
}

/** A view that searches only one audience's chunks. Its name is the base retriever's. */
class FilteredView implements Retriever {
  readonly name: string;
  readonly ranking: RankingRetriever | null;

  constructor(name: string, ranking: RankingRetriever | null) {
    this.name = name;
    this.ranking = ranking;
  }

  search(query: string, k: number): RunbookHit[] {
    return this.ranking ? this.ranking.search(query, k) : [];
  }
}

export class AclCorpus implements AudienceRetriever {
  readonly name: string;
  readonly chunks: readonly Chunk[];
  private readonly acl: Readonly<Record<string, readonly string[]>>;
  private readonly build: (chunks: readonly Chunk[]) => RankingRetriever;
  private readonly views = new Map<string, FilteredView>();

  /**
   * `build` makes a retriever over a chunk list (BM25, embeddings, hybrid). It is called
   * once per audience with only that audience's chunks. `knownGroups`, when given, is the
   * directory's group names; an ACL naming any other group fails the load.
   */
  constructor(
    chunks: readonly Chunk[],
    build: (chunks: readonly Chunk[]) => RankingRetriever,
    options: {
      name: string;
      acl?: Readonly<Record<string, readonly string[]>>;
      knownGroups?: ReadonlySet<string>;
    },
  ) {
    this.name = options.name;
    this.chunks = [...chunks];
    this.acl = options.acl ?? RUNBOOK_ACL;
    this.build = build;
    for (const c of this.chunks) {
      const groups = Object.hasOwn(this.acl, c.runbook) ? this.acl[c.runbook] : undefined;
      if (!groups || groups.length === 0) {
        throw new AclError(`runbook ${c.runbook} has no ACL entry`);
      }
      for (const g of groups) {
        if (options.knownGroups && !options.knownGroups.has(g)) {
          throw new AclError(`runbook ${c.runbook} names unknown group ${g}`);
        }
      }
    }
  }

  /** The runbooks a reader with these groups may see. */
  readable(groups: ReadonlySet<string>): Set<string> {
    const out = new Set<string>();
    for (const c of this.chunks) {
      if ((this.acl[c.runbook] ?? []).some((g) => groups.has(g))) out.add(c.runbook);
    }
    return out;
  }

  /** The ranking retriever behind a reader's view (null if they can see nothing). */
  rankingFor(groups: ReadonlySet<string>): RankingRetriever | null {
    return (this.forReader(groups) as FilteredView).ranking;
  }

  forReader(groups: ReadonlySet<string>): Retriever {
    const visible = this.readable(groups);
    const key = [...visible].sort().join("\n");
    let view = this.views.get(key);
    if (!view) {
      const chunks = this.chunks.filter((c) => visible.has(c.runbook));
      view = new FilteredView(this.name, chunks.length ? this.build(chunks) : null);
      this.views.set(key, view);
    }
    return view;
  }

  /** Without a reader there is no audience: nothing is returned. */
  search(_query: string, _k: number): RunbookHit[] {
    return [];
  }
}

/** The shared runbooks plus the restricted ones, as chunks. */
export function allChunks(shared: readonly (readonly [string, string])[]): Chunk[] {
  return chunksFrom([...shared, ...Object.entries(RESTRICTED_RUNBOOKS)]);
}
