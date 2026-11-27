# Moving the helpdesk to Savory Air

Decided 2026-11-27 (Skylar): the helpdesk moves from Larkspur Labs to **Savory Air**, the fictional retailer of the sister repo `identity-lifecycle-agent`. Both demos fold into one larger project that proves AI enablement for IT, and they share one Okta tenant. One Okta login can't be two people, so the personas have to agree first.

Skylar approved the mapping on 2026-11-27. The data move (step 2) is built as described below, with the two small departures noted in the table. Identity I5 (Okta) is paused until the move lands.

Checked against `identity-lifecycle-agent` `src/people.ts` at `origin/main` `74a3da5` on 2026-11-27.

## Approach: keep the Larkspur people, re-homed inside Savory Air

The helpdesk directory becomes the **union** of:
- **Savory Air's 19 hand-written personas,** with their names, emails, titles, departments and managers exactly as in `people.ts`. Savory Air is authoritative wherever the two disagree.
- **The Larkspur personas whose emails don't collide,** kept under the same email, moved into Savory Air's departments, with retail titles where needed.

Why the union rather than a rewrite onto Savory Air's 19 people:
- Only **three emails collide** (Rosa Delgado, Morgan Hale, Omar Haddad). Everyone else keeps their email, so 58 of 62 eval tickets keep their requester, and most tests change in a name only.
- **Every fixture role survives:**
  - the `jamie` / `jaime.rivas` look-alike pair
  - non-ASCII names
  - two disabled users with no groups
  - the planted title
  - manager pairs
  - privileged members
  - `people-ops` readers

  Savory Air's own set has no look-alike pair and no disabled users.
- **Eval numbers stay comparable,** because the tickets, checks and runbook text barely move.

The helpdesk-only personas become proposals for Savory Air's shared set (see "Requests to the sister repo"), so the two lists converge on one.

## The three collisions

| Email | Larkspur (today) | Savory Air (wins) | What happens to the Larkspur role |
| --- | --- | --- | --- |
| `rosa.delgado@example.test` | IT Support Specialist, approver, in `admins` | Director of operations (warehouse) | The approver role moves to **Casey Nguyen** (Savory Air's IT systems administrator, reports to Morgan Hale; not a lifecycle leaver): `it-support` and `admins`. Rosa becomes an ordinary requester. Tier 2's helpdesk side switches between **Casey Nguyen and Theo Park**. |
| `morgan.hale@example.test` | VP of Engineering, `aws-prod-admins`, manager of the engineers | IT director, the lifecycle escalation target | Keeps the role's shape: a privileged leader with reports. E035 (a privileged MFA reset) stays as written. |
| `omar.haddad@example.test` | Staff Accountant | Marketing operations lead, reports to Hannah Brooks | His four finance tickets (E006, E012, E033, E061) move to **Wes Harper** (FP&A analyst, finance). |

## Proposed mapping: the Larkspur personas

Departments follow Savory Air (`sales`, `warehouse`, `support_repair`, `marketing`, `it`, `corporate`), plus a small **e-commerce team inside IT** for the engineers. A retailer with an online store plausibly has developers, and their tickets (GitHub, VPN, production admin) keep working.

| Person (email unchanged) | Larkspur role | Savory Air role (proposed) | Reports to |
| --- | --- | --- | --- |
| Sam Whitfield | IT Manager (`domain-admins`, `okta-super-admins`) | IT manager, same groups | Morgan Hale |
| Theo Park | IT Support Specialist, approver | IT support specialist, approver | Sam Whitfield |
| Priya Nair | Staff Engineer | E-commerce engineering lead (it) | Morgan Hale |
| Jamie Rivera | Software Engineer, the main requester | E-commerce developer (it) | Morgan Hale |
| Tomás Berg | Site Reliability Engineer, prod admin | E-commerce platform engineer, prod admin | Morgan Hale |
| Lena Cho, Inês Costa | Software / Data Engineer | E-commerce developer / Data engineer | Priya Nair / Morgan Hale |
| Kofi Mensah | QA Engineer, contractor | QA engineer, contractor | Priya Nair |
| Riley Okafor | Software Engineer, **disabled** | Same, disabled | Priya Nair |
| Dana Ito | Head of Sales | Regional Sales Manager | Victor Shaw |
| Jaime Rivas, Marcus Reed, Ana Souza | Account Executive / SDR | Titles unchanged (B2B sales) | Dana Ito |
| Eli Novak | Account Executive, **planted title** | Title and planted text unchanged | Dana Ito |
| Jordan Blake | Account Executive, **disabled** | Same, disabled | Dana Ito |
| Grace Lin | Controller, `finance-approvers` | Controller (corporate) | (none) |
| Bea Kowalski, Wes Harper | AP Specialist / FP&A Analyst | Same (corporate, finance) | Grace Lin |
| Nora Quinn | Head of People | People partner, `people-ops` | Dana Whitfield |
| Felix Adeyemi | Recruiter | Recruiter, `people-ops` | Nora Quinn |
| Zara Ali | Marketing Director | Brand marketing manager | Hannah Brooks |
| Leo Fischer | Content Marketer | Content marketer | Zara Ali |
| Iris Vance, Hugo Martin, Mei Tanaka (contractor) | Design team | Creative team in marketing, `figma-users` | Hannah Brooks / Iris Vance |
| Ruth Ogden, Caleb Moss | Legal | Legal (corporate) | (none) / Ruth Ogden |

Savory Air's other personas join the directory as ordinary users with devices and MFA state:
- Marcus Webb, Priya Natarajan, Tomás Reyes, Jordan Lee, Alex Kim, Samuel Okafor, Riley Chen
- Dana Whitfield, Lee Park (also `people-ops`), Ben Carter, Hannah Brooks, Victor Shaw, Elena Ruiz, Grace Okoye, Theo Lindqvist

The directory grows from 30 users to 46 (30 plus Savory Air's 19, less the three collisions).

## Groups and apps

Group names stay where they still make sense, so ticket text barely changes. The rest line up with Savory Air's app registry, so the helpdesk grants the same access the lifecycle demo later revokes.

| Today | Proposed | Note |
| --- | --- | --- |
| `engineering` | `ecommerce` | the team above |
| `design` | `creative` | inside marketing |
| (new) `warehouse`, `support-repair`, `corporate` | department groups | Savory Air departments |
| `salesforce-users` | `crm-users` | Savory Air's CRM (SCIM in the lifecycle demo) |
| (new) `wms-users`, `ad-platform-users`, `parts-ordering-users` | app groups | Savory Air's warehouse system, ad platform and parts ordering |
| `aws-prod-admins` (privileged) | `ecommerce-prod-admins` (privileged) | "AWS Console (production)" becomes "E-commerce platform (production)" |
| `all-staff`, `it-support`, `people-ops`, `contractors`, `vpn-users`, `github-users`, `figma-users`, `netsuite-users`, `admins`, `domain-admins`, `okta-super-admins`, `finance-approvers` | unchanged | |

The runbook access lists (`it-support`, `people-ops`) are unchanged.

## Runbooks

"Larkspur Labs" becomes "Savory Air". Engineering-only details stay, because the e-commerce team still exists. No runbook is rewritten, so the retrieval numbers should hold. The retrieval eval is re-run to confirm.

## Sequence

Each step is a PR unless marked otherwise. The live site isn't redeployed until the data PR, the live evals and the docs have all merged, so it is never half Larkspur.

| Step | What | Done when |
| --- | --- | --- |
| 1 | This document, signed off | Skylar approves the mapping, or edits it |
| 2 | **The data move**, in one PR, because CI ties the directory, tickets and parity fixtures together. It covers: `directory.json`, runbook names, the four Omar tickets, group renames in tickets, transcripts, Python and TypeScript tests, regenerated parity fixtures (`scripts/parity_fixtures.py`), the restricted runbooks' company name, the site pages and tier 2's personas | `uv run pytest` and `npm run check` pass. Every ticket still names a real directory user. No "Larkspur" outside history (`evals/results/`, dated plan entries). |
| 3 | **Live evals** (Claude Code, via `op run`) | `--limit` first to measure cost, then full Python (the new baseline), then full TypeScript compared with `scripts/compare_results.py`, plus the retrieval eval. Results committed. Old Larkspur results stay as history. |
| 4 | **Redeploy** `hddemo.damiano.dev` from the merged, green `main` | The site shows Savory Air. Sessions created before the deploy expire within 24 hours (alarm cleanup). |
| 5 | **Resume I5** (PR #43 and onward): the Okta subset and seeding | See "Okta" below. Resumed 2026-11-27 after the redeploy; the subset is decided. |

## Results (2026-11-27)

Step 3 ran on the data PR's branch, before merge.
- **Python, the new baseline of record:** [`2026-11-27T203630Z.json`](../evals/results/2026-11-27T203630Z.json), `eval --grade`. 62/62, every category 100%. Grader 9/14, the same as the Larkspur baseline (answers_question 12/14, grounded 9/14, no_contradiction 14/14). $0.610 agent + $0.0035 grader, $0.0098 per ticket, 277 s.
- **TypeScript:** [`ts-2026-11-27T204129Z.json`](../evals/results/ts-2026-11-27T204129Z.json), `--grade`. 62/62, grader 9/14 (answers_question 13/14). `scripts/compare_results.py` against the Python run: parity bar items 2 and 4 met.
  - **Cost:** $0.0048 per ticket, half of Python's. The two runs made about the same number of calls (165 and 167). The TypeScript run started minutes after the Python run with identical prompts, so it mostly read the prompt cache Python had written: 372k cached tokens read and 38k written, against Python's 263k read and 181k written (`logs/`). That's run order, not a code difference. Don't quote it as a TypeScript saving.
- **Retrieval (key-free):** BM25 recall@3 0.974 and MRR 0.891 in both languages, unchanged from Larkspur.

## Okta: the shared subset

The Okta tenant holds only the personas a live demo needs, not the whole directory.
- **Cap:** the sister spec notes a possible **ten active users** across both demos. That's unconfirmed; check it in the admin console.
- **The lifecycle demo deactivates its leavers** (P001 to P007). None of them can be a helpdesk requester or approver in tier 3.
- **The helpdesk's tier 3 accounts (decided 2026-11-27, Skylar):**
  - Jamie Rivera, the requester
  - Casey Nguyen and Theo Park, the approvers
  - Morgan Hale, Jamie's manager and the `directory-admins` persona. Morgan is already the lifecycle demo's IT director, so this account is shared, not added.

  That's three new accounts. Sam Whitfield and Dana Ito stay directory-only.
- **The lifecycle demo** needs its seven leavers plus Morgan Hale. With the helpdesk's three, that's eleven. If ten is the cap, the lifecycle demo keeps at most six leavers active at once (for example, only the leavers of the scenario being run).

## Requests to the sister repo (Skylar routes; Claude Code doesn't edit it from here)

- **Add the helpdesk-only personas** to `people.ts` (or a shared list both repos read later), with the roles above.
- **Make the staff generator skip the emails both demos reserve,** so a generated employee never takes `jamie@example.test` and its neighbours.
- **Casey Nguyen joins `it-support` and `admins`** in the helpdesk directory. Check this fits the lifecycle demo's view of Casey.
- **Morgan Hale's Okta account is shared:** the helpdesk adds Morgan to an Okta group `directory-admins`. The lifecycle demo should never deactivate Morgan, and should treat that group as the helpdesk's.
- **At most six leavers active at once** in Okta, if the org's cap turns out to be ten active users.

## Open questions for Skylar

1. **The mapping.** Approve it as is, or edit the rows. The approver swap (Casey Nguyen for Rosa Delgado) and the e-commerce team are the two biggest choices.
2. **Look-alike names across the two lists:**
   - Priya Nair and Priya Natarajan
   - Tomás Berg and Tomás Reyes
   - Theo Park and Theo Lindqvist
   - Riley Okafor, Riley Chen and Samuel Okafor
   - Marcus Reed and Marcus Webb
   - Jordan Blake and Jordan Lee
   - Grace Lin and Grace Okoye
   - Dana Ito and Dana Whitfield

   Fine as extra look-alike tests, or rename some helpdesk ones for a clearer demo?
3. **Who routes the sister-repo requests,** and whether the shared persona list should eventually live in one place.
