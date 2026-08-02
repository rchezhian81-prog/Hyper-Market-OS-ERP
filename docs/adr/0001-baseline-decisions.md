# ADR 0001 — Baseline decisions and the rules the machine enforces

- **Status:** Accepted (baseline). Owner-decision fields marked ⛔ remain open.
- **Date:** 2 August 2026
- **Context:** Recorded during Setup 4 of the Claude Code Build Pack (Annexure H),
  before any application code exists.

An Architecture Decision Record captures a decision, why it was made, and what it
commits us to. This first record fixes the technology baseline and the
non-negotiable rules so they are visible and, where possible, checked by the
machine rather than by memory.

> **Source-of-truth note.** The authoritative text of owner decisions OD-01 to
> OD-10 and the developer decisions D1–D8 lives in the roadmap decision register
> (roadmap §25). That document (`docs/roadmap/roadmap-v2.0.docx`) is **not yet in
> the repository**. The entries below marked ⛔ are recorded from the Annexure G
> audit and Annexure H build pack only, or are still blank owner fields. When the
> roadmap is added, this ADR must be completed verbatim from §25 — nothing here
> is invented, and gaps are left as gaps.

---

## Part A — Owner decisions (OD-01 to OD-10)

| ID | Decision (as known) | Source | Consequence |
| --- | --- | --- | --- |
| OD-02 | Scope ratchet: nothing in scope is silently dropped; "not included is unacceptable" (§24). Deferral must be explicit, in writing, with a named target release. | Annexure G | The missing control becomes a schedule trigger, not a scope gate. |
| OD-04 | Build the SRE standalone POS as an independent product. Stated as final. | Annexure G | The POS is the critical path to the 1 April 2027 Store Core target: checkout speed, tender handling, peripheral certification and 72-hour offline resilience are all ours to prove. |
| OD-05 | Migrate **all usable history** (§34). | Annexure G | "Usable" must be defined before the migration rehearsal (see Stage 11 / finding A-08): a dataset is usable if it can be extracted, has an identifiable key, and its totals reconcile. |
| OD-09 | Source-code ownership: the owner owns the product outright. | Annexure G | Reinforced by the quarterly rebuild-by-second-custodian discipline (AID-10). |
| OD-01, OD-03, OD-06, OD-07, OD-08, OD-10 | ⛔ Pending roadmap §25. | — | Record verbatim when the roadmap is added. |

## Part B — Developer / owner decision fields (D1–D8)

| ID | Field | Value (as known) | Status |
| --- | --- | --- | --- |
| D1 | Budget | ₹5–10 lakh planning envelope (not permission to weaken scope, security, migration, testing, documentation or ownership) | Recorded (Annexure G) |
| D2 | Owner capacity | 30 hours / week | Recorded (Annexure G) |
| D3 | Running-cost ceiling | ⛔ blank | **Blocking** before production |
| D4 | Second technical custodian | ⛔ blank | **Blocking** — Annexure H: the one field it would refuse to start without. Fill first. |
| D5 | GO date | ⛔ blank | **Blocking** before coding |
| D6, D7 | ⛔ Pending roadmap §25 | — | Record when roadmap added |
| D8 | Completion date | ⛔ blank | **Blocking**; M5 currently the only dated milestone (1 April 2027) |

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
