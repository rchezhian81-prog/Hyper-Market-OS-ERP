# ADR 0001 — Baseline decisions and the rules the machine enforces

- **Status:** Accepted (baseline). Owner-closure fields D3/D4/D5/D8 remain open.
- **Date:** 2 August 2026 (updated when the roadmap was added to the repository)
- **Context:** Recorded during Setup 4 of the Claude Code Build Pack (Annexure H);
  completed from the roadmap decision register when `docs/roadmap/roadmap-v2.0.docx`
  was placed in the repository. No application code exists.

An Architecture Decision Record captures a decision, why it was made, and what it
commits us to. This first record fixes the technology baseline and the
non-negotiable rules so they are visible and, where possible, checked by the
machine rather than by memory.

> **Source of truth.** Owner decisions OD-01…OD-10 and decision fields D1–D8 below
> are recorded **verbatim from roadmap §14 and §25**. The full register is also in
> `docs/registers/decisions.md`.

---

## Part A — Owner decisions OD-01 to OD-10 (roadmap §14)

| ID | Decision | Binding requirement |
| --- | --- | --- |
| OD-01 | Product | Build a completely new, independently owned SRE Retail OS. |
| OD-02 | Scope | All approved modules, channels, controls and AI agents remain in final scope; nothing is silently removed. |
| OD-03 | Hybrid | Store operations and POS continue safely without internet; cloud provides central truth, control and omnichannel services. |
| OD-04 | POS | Build the new SRE standalone POS as an independent product. This architecture decision is final. |
| OD-05 | Migration | All usable previous-system data is migrated, reconciled and evidenced. Exceptions require owner approval. |
| OD-06 | Legacy | Any legacy adapter is temporary, preferably read-only, and retired after accepted cutover. |
| OD-07 | Commerce | Customer Android/iOS app, web store, online payment, pickup and delivery are committed scope. |
| OD-08 | AI | AI assists development and product operation; critical business actions remain governed and auditable. |
| OD-09 | Ownership | SRE owns source code, repositories, databases, documentation, deployment assets, backups and credentials. |
| OD-10 | Sequence | Phasing controls risk and adoption; it never reduces final scope. |

**Consequence for the build:** OD-04 makes the POS the critical path to the
1 April 2027 Store Core target (M5); OD-09 + AID-10 require the second custodian
(D4) to rebuild the system quarterly; OD-02 + OD-10 mean deferral is only ever via
a written change (`docs/registers/changes.md`), never a silent drop.

## Part B — Decision fields D1 to D8 (roadmap §25)

| ID | Field | Value | Status |
| --- | --- | --- | --- |
| D1 | Indicative programme budget | ₹5–10 lakh (planning envelope only) | Recorded; commercial validation required |
| D2 | Owner review capacity | ≥ 30 hours/week | Recorded |
| D3 | Monthly running-cost ceiling | OWNER VALUE REQUIRED | **Open — blocking** before hosting/vendor commitment |
| D4 | Second technical custodian | NAME REQUIRED | **Open — blocking** before production. Fill first. |
| D5 | Formal GO date | DATE/SIGNATURE REQUIRED | **Open — blocking** before coding |
| D6 | Initial online catalogue | 300–600 fast-moving products | Recorded; SKU list required |
| D7 | Migration history | Full usable history | Recorded; exceptions only by owner approval |
| D8 | Cutover targets | Store Core 1 April 2027; full completion date OWNER VALUE REQUIRED | Store Core scope & final date must be signed |

## Part C — Technology baseline (roadmap §19)

This is the agreed baseline. **Any substitution requires a new ADR** covering
offline, support, security, cost, portability and maintainability impact.

| Layer | Baseline |
| --- | --- |
| Web ERP / Admin | TypeScript + modern SSR web framework |
| Cloud services | Modular domain services |
| Cloud data | PostgreSQL + Redis; object storage for documents |
| Store edge | Containerised local services + local relational database |
| POS | Desktop / PWA shell; sub-second scan; no cloud round trip |
| Mobile | Cross-platform; must run well on a low-spec Android phone |
| Messaging | Durable broker with idempotency, retry and dead letter |
| AI | Central model gateway; scoped tools, evidence, budget, kill switch |
| Delivery | Containers, infrastructure as code, CI/CD |

### Setup tooling chosen within the baseline (not a substitution)

These are engineering choices *inside* the TypeScript baseline, recorded for
transparency; they do not change any layer above:

- **Package manager / monorepo:** pnpm workspaces.
- **Test runner:** Vitest (`pnpm test` runs the whole suite).
- **Type checking:** `tsc --noEmit`. **Linting:** ESLint (flat config).
- **Secret scanning:** a zero-dependency Node script (`scripts/secret-scan.mjs`).
- **CI:** GitHub Actions (`.github/workflows/ci.yml`).

## Part D — The rules the machine enforces (roadmap §18, §20)

These are the six hard rules from `CLAUDE.md` turned into automated guardrail
tests in `tests/guardrails/`. Each test does two things: it confirms the real
codebase is clean today, and it confirms the tripwire actually fires on a
known-bad sample — so a green result means "checked and clean", never "the check
is broken". They are **tripwires, not proofs**: conservative pattern checks that
stop a rule being broken *silently*, tightened as real code lands.

| Guardrail file | Hard rule | How it works | How you know it tripped |
| --- | --- | --- | --- |
| `card-data.test.ts` | #3 No card number / CVV / expiry stored | Scans app/service/edge/db code for fields named like `cardNumber`, `cvv`, `cardExpiry`. | `pnpm test` goes red naming the file and line where a card field was introduced. |
| `secrets.test.ts` (+ `scripts/secret-scan.mjs`) | #4 No secrets in code | The test scans code for keys and credential URLs; the script scans the **whole repository** in the pre-commit hook and in CI. | A commit is blocked, or CI/`pnpm test` goes red, naming the file and line. |
| `ledger-append-only.test.ts` | #2 Ledgers are append-only | Scans for `UPDATE`/`DELETE` (SQL or ORM) aimed at a ledger, movement, journal, audit or dead-letter table. | Red test naming the offending statement; the fix is a compensating event, never an edit. |
| `pos-offline.test.ts` | #1 POS sale never depends on the network | Scans POS sale/checkout/tender files for direct network calls (`fetch`, `axios`, …). The edge sync agent is intentionally not scanned. | Red test showing a network call was added to the sale path. |
| `ai-agent-db-write.test.ts` | #5 AI agents never write to the database | Scans files on an "agent" path for database writes (`INSERT`/`UPDATE`/`DELETE`, ORM `create`/`update`/`delete`). | Red test showing an agent tried to write directly instead of drafting for a human. |
| `shared-login.test.ts` | #4 No shared / generic logins | Scans for shared/generic account patterns and default `admin`/`admin` credentials. | Red test naming the shared-account or default-credential line. |

To see what a failure looks like on purpose, read
`docs/runbooks/how-to-check-tests.md`.
