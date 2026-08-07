# SRE Retail OS — Migration & cutover design (Stage 4)

- **Roadmap:** §34 (migration/cutover), §34.1 (parallel-run discipline), **MG-01…MG-12**, **WF-19**. Owner decisions **OD-05 / OD-06**, field **D7**. **QG-07** (control totals signed). **Hard rules #6** (never delete migration exceptions), **#7** (never touch prod from dev/test).
- **Purpose:** How legacy data becomes trustworthy **opening truth** in SRE Retail OS — profile, map, clean, trial, reconcile, delta, parallel-run, cutover, rollback, archive — with signed control totals and a tested rollback at every step. Release **R3**.

> This is the migration **design** (Stage 4). The operational **parallel-run plan and
> cutover runbook** are produced in Stage 13 under `../cutover/`.

## 1. Principles
- **All usable** previous-system data is migrated, reconciled and evidenced (OD-05);
  exceptions require **owner approval**.
- Any legacy adapter is **temporary, preferably read-only, and retired** after accepted
  cutover (OD-06).
- **No cutover without signed control totals** (QG-07). **No production access from
  dev/test** (#7). **Every exception kept, never deleted** (#6). A **rollback path exists
  at all times**.

## 2. The migration pipeline (MG-01…MG-12, WF-19)

| Step | What | Control |
| --- | --- | --- |
| **Profile & map** | Source profiling; map legacy fields to the SRE data model (`data-model.md`) | Mapping reviewed & versioned |
| **Clean (MG-04)** | Resolve duplicate products/barcodes/suppliers/customers, invalid tax, negative stock, incomplete batches | Each unresolved item is a **kept exception** (#6) |
| **Trial load (MG-05)** | Repeatable, **full-volume** load | **Non-production only** (#7); repeatable |
| **Reconcile** | Control totals — migration, stock, financial, tax, loyalty | **Signed before cutover** (QG-07) |
| **Delta** | Catch changes since the trial snapshot | Idempotent |
| **Parallel run (§34.1)** | Old and new run together; differences resolved same day | Exceptions owned & valued |
| **Cutover** | Guided checklist; opening balances posted | Owner **GO**; edge fully synced |
| **Rollback** | Tested; **one clearly-labelled action** | **Demonstrated before go-live** |
| **Archive** | Legacy dataset archived, immutable | Retained; **never deleted** (#6) |

*(MG-04 Cleaning and MG-05 Trial loads are named explicitly from the roadmap; the other
MG-01…12 controls map onto the surrounding steps and are expanded at R3 — not invented
here.)*

## 3. Control totals & sign-off (QG-07)
Migration, stock, financial, tax and loyalty **control totals must validate and be signed**
before cutover completes — a **CA signs the finance/tax totals** (M23 / C-01). The migration
surface shows each total, its difference, and who signed it.

## 4. Environment isolation (hard rule #7)
Trials and deltas run only against controlled **non-production** environments; production is
never the target of a test run; production secrets are isolated (see
`../security/threat-privacy-model.md`).

## 5. Exceptions (hard rule #6)
Every cleaning/reconciliation exception is a **kept record** — resolved, or carried forward
with an **owner-approved reason**. Migration exceptions are **never deleted**.

## 6. Rollback & continuity
A **tested rollback** returns to the last-good state; the store keeps trading throughout
(P-01); cutover is timed to minimize disruption. Legacy adapters are retired once cutover is
accepted (OD-06).

## 7. Acceptance (QG-07 / QG-02)
- Cutover is **blocked** until every control total is signed.
- A full-volume trial reconciles; differences are **explained and valued**.
- A **rollback is demonstrated** before go-live.
- **No** test or delta run points at production.
- Migration exceptions are **retained, never deleted**.

## 8. Related
- Surface: `../design/screens/migration.md`
- Legacy export rights: `../discovery/legacy-data-access.md`
- Decisions: `../registers/decisions.md` (OD-05/06, D7)
