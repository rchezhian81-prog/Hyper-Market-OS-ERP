# Assignment matrix — every audit finding and every controlling item, one batch each (10 Oct 2026)

**What this is.** The per-item assignment table for [`repair-plan-2026-10-04.md`](./repair-plan-2026-10-04.md), which
stays the one canonical backlog. It invents no requirement and drops none: every row comes from
`docs/audit/repository-audit-2026-10-04-findings.tsv` (74 findings) or `docs/completion-status.json` (104 items).
Baseline: `main` = `1b45245e` (10 Oct 2026). One unmerged branch: `origin/claude/happy-cannon-l1g5pe`, commit
`c1076976` "PF-09 step 2: the till names a loyalty member by mobile number" (green, not merged; based on `ecc9dafa`, so it
also touches this plan and the evidence ledger) — recorded under PF-09, owned by Batch 3.

**States** (exactly one per row): `verified complete` · `pending software` · `approved deferral` · `external dependency`
· `staff/device acceptance`. A finding whose code is done but still needs a live provider, an admin action or a staff
run keeps the software state; the residual gate is written in its acceptance cell. In Table B, an item with nothing
left in software takes the state of what is left (staff run, outside party, deferral). Staff UAT (SP-10) has run **0**
sessions (`docs/registers/sp10-staff-uat.md`), so "Residual: SP-10" is true of every store-facing row.

**Batches.** **B1** Foundation, security and hybrid operation · **B2** Purchase, receiving and store inventory ·
**B3** Sales, returns and financial closure · **B4** Reporting, supporting workflows and readiness. Definitions and shared
contracts are in section C. Line numbers `L…` point into `docs/traceability.md` at `1b45245e`.

## A. The 74 audit findings (plus two residual sub-items)

PA-01-r1 and PA-06-r1 are residual defects reproduced by the coordinator on 10 Oct 2026 after their parents were
recorded; they sit under their parent and are counted separately from the 74. PA-01 itself moves to `pending software`
because its own record says only the consolidation, drill-through and roster routes were repaired.

| Finding ID | Severity | Requirement refs | Current evidence | Disposition | Primary batch | Dependencies / shared-component owner | Acceptance criteria | State |
|---|---|---|---|---|---|---|---|---|
| EA-01 | HIGH | M29-FR-01, M29-FR-03, D13, P-08 | None yet (repair plan Wave 5) | Repair, Wave 5 | B4 | Sync watermark from B1 (`packages/sync`, `edge/store-edge/src/sync-status.ts`) | Each owner figure shows the last complete source sync per branch/domain, not the read time; a store trading through a long cloud cut shows lagging/stale; real-API test. | `pending software` |
| EA-02 | HIGH | M29-FR-01, D04, D13 | None yet (Wave 5) | Repair, Wave 5 | B4 | Tender/payment states owned by B3 | A split-tender sale is reported per tender kind; tender totals balance to captured payments; the old split-payment expectation is replaced by money reconciliation assertions. | `pending software` |
| EA-03 | HIGH | M01, M29-FR-01, M29-FR-02, D13, SEC-02 | #704; docs/traceability.md L110 | Repaired, Wave 2b-ii | B4 | Scope rule owned by B1 (`services/kernel/src/scope.ts`) | A branch-limited manager cannot widen consolidation or drill-through by `?scope=`; real-API test with a branch-limited manager. | `verified complete` |
| EA-04 | HIGH | M01, M29-FR-02, D13, M30-FR-02 | None yet (Wave 5) | Repair, Wave 5 | B4 | Export engine `packages/export` | Company report page and export run on the production route through the authenticated port with `exportDomain`; browser test against the real API with seeded contributions. | `pending software` |
| EA-05 | MEDIUM | M29-FR-02, D13, NFR-15 | None yet (Wave 5) | Repair, Wave 5 | B4 | Scope from B1 | Drill-through takes a governed report ID, period and filters, loads source rows and headline server-side, scope from grants; caller-supplied rows are not accepted. | `pending software` |
| EA-06 | MEDIUM | M29-FR-01, D13 | None yet (Wave 5) | Repair, Wave 5 | B4 | Source rows from B2 (stock) and B3 (sales/cash) | Store-core report producers return governed source rows and are listed PRODUCED only then; an unknown or unavailable name is refused, never answered with sales data. | `pending software` |
| EA-07 | MEDIUM | M29-FR-04, A01, D13 | `services/reporting/src/scheduled-brief.ts` (deterministic brief only) | Repair, Wave 6 | B4 | Delivery transport via PA-08 (B4); trading calendar B1 (M01) | A scheduled worker sends the brief on three scheduled days from governed figures, with outbox, retries and acknowledgements; no-AI fallback proven. Residual: live phone transport (provider). | `pending software` |
| EA-08 | MEDIUM | A01, A02, A04, AI-NFR-01, AI-NFR-08, AI-NFR-10 | None yet (Wave 6) | Repair, Wave 6 | B4 | Domain readers from B2/B3 | A01/A02/A04 remaining legs read real domain readers; server-owned cost admission, metering, immutable request/result audit and evaluations exist before any model provider is enabled. Residual: live model provider. | `pending software` |
| EA-09 | MEDIUM | A06, A08, A10, QG-11 | None yet (Wave 6) | Repair, Wave 6 | B4 | Branch scope B1 | One connected production-API + browser path per shared AI inbox (A06/A08/A10) covering branch scope, kill switch, restart and refreshed data; ledger records simulator/browser/API/UAT separately. | `pending software` |
| EA-10 | MEDIUM | D01, D02, D03, D04, D05, D06, D07, D08, D09, D10, D11, D12, D13, D14, WF-01, WF-02, WF-03, WF-04, WF-05, WF-06, WF-07, WF-08, WF-09, WF-10, WF-11, WF-12, WF-13, WF-14, WF-15, WF-16, WF-17, WF-18, WF-19, WF-20 | `docs/completion-status.json` D/WF entries (stale); this matrix Table B is a first pass | Repair, Wave 6 | B4 | Each batch supplies its own D/WF facts | Every D01-D14 and WF-01-WF-20 ledger entry refreshed against current connected tests; each open gap mapped to a slice and classed code / evidence / owner / physical-provider. | `pending software` |
| FUL-01 | HIGH | M11-FR-01, M11-FR-02, M11-FR-03 | `tests/integration/production-moves-ordinary-stock.test.ts` (memory + real PostgreSQL): consumed_in_production / produced kinds, valuation conserved, concurrent runs (Batch 2, 10 Oct 2026) | Repair, Wave 6 | B2 | Sale side B3 | Ingredient consumption, held output and QC release move ordinary stock atomically; receive -> make -> hold/release -> till sale -> trace/valuation on real PostgreSQL. | `verified complete` |
| FUL-02 | HIGH | M18-FR-02, M20-FR-02 | #702; docs/traceability.md L108 | Repaired, Wave 2a | B2 | Write guard B1; order linkage B3 | The last unit is promised once under a race on real PostgreSQL; duplicate lines are one line. | `verified complete` |
| FUL-03 | HIGH | M20-FR-03, M18-FR-01, M18-FR-03, M18-FR-04 | None yet (Wave 6) | Repair, Wave 6 | B3 | Reservations B2; checkout screen apps/customer-app | Checkout price, slot and serviceability recomputed on the server; provider intent and verified outcome bound to the quote/order; a forged client payment is refused. Residual: live payment provider. | `pending software` |
| FUL-04 | HIGH | M19-FR-02 | None yet (Wave 6) | Repair, Wave 6 | B2 | Order lines from B3 | Desk packing loads ordered/picked lines and cold-chain limits from the master; request-supplied rules and unknown orders refused; same resolver in desk and wave paths. | `pending software` |
| FUL-05 | HIGH | M18-FR-01, M18-FR-02, M19-FR-02, M19-FR-03, M19-FR-04, M20-FR-03 | None yet (Wave 6) | Repair, Wave 6 | B3 | Stock/reservations B2; outbox B1 | One idempotent fulfilment command advances the order from pack/door outcomes and posts stock and money once; partial, failed/RTO and COD remainder tested; customer tracking re-reads its own order. | `pending software` |
| FUL-06 | HIGH | M16-FR-02, M16-FR-03, M20-FR-04 | None yet (Wave 6) | Repair, Wave 6 | B4 | Customer session identity B1 | Consent and rights changes saved server-side in the customer's own session and re-read; a withdrawal excludes the next campaign; a request appears in the DPO queue; failure shown. | `pending software` |
| FUL-07 | HIGH | M18-FR-02, M20-FR-02, M20-FR-03 | None yet (Wave 6) | Repair, Wave 6 | B3 | Availability from B2 | The app follows the server answer; zero stock at checkout shows the shortage and needs the customer's decision before any charge. | `pending software` |
| FUL-08 | MEDIUM | M11-FR-01 | same test file: digest-judged recipe versions, each run names its version; a reused key with a changed payload is the kernel's 409 (Batch 2, 10 Oct 2026) | Repair, Wave 6 | B2 | - | An edit with the same ingredient count makes a new recipe version; a reused request key with a changed payload is a conflict; history kept. | `verified complete` |
| FUL-09 | MEDIUM | M22-FR-01, M22-FR-02, M22-FR-03, M22-FR-04 | None yet (Wave 6) | Repair, Wave 6 | B4 | Invoice/AR/collection money B3; reservation B2 | One B2B order -> reserve -> dispatch -> invoice -> AR -> collection slice connected on real PostgreSQL; then self-service order/payment and recurring/commission. | `pending software` |
| FUL-10 | MEDIUM | M16-FR-01, M16-FR-04 | None yet (Wave 6) | Repair, Wave 6 | B4 | Sale/return events B3 | Governed customer link/merge/reversal with household rules; CRM facts derived idempotently from sales, returns and corrections. | `pending software` |
| FUL-11 | MEDIUM | M04-FR-01, M04-FR-02, M04-FR-03, M04-FR-04 | None yet (Wave 6) | Repair, Wave 6 | B2 | Store-pack sections B1 (PA-06) | Planning and stock facts reach merchandising from head-office pack sections; range-drop stock derived server-side; effective range enforced at ordering; display funding reconciled to finance. | `pending software` |
| FUL-12 | MEDIUM | M16-FR-03, M20-FR-04 | None yet (Wave 6) | Repair, Wave 6 | B4 | Domain adapters from B2/B3 | Erasure runs over real domain adapters on synthetic data; retention, minimisation and prevent-restore proven. Residual: owner authorisation and legal retention confirmation before real data. | `pending software` |
| FUL-13 | MEDIUM | M11-FR-01, M11-FR-02, M11-FR-03, M11-FR-04 | `tests/e2e/production-delivery.e2e.ts` (QC screen only) | Repair, Wave 6 | B2 | Sale B3 | Production task pages over the existing APIs; one connected production -> label -> sale test on PostgreSQL. Residual: scale/printer/low-spec device UAT. | `pending software` |
| FUL-14 | MEDIUM | M19-FR-01, M18-FR-04 | None yet (Wave 6) | Repair, Wave 6 | B3 | Approval engine B1 (`services/identity/src/approval-requests.ts`) | Substitution reads ordered line, attributes, tender and preference from stored truth; an above-cap decision uses an approval record; missing policy fails closed. | `pending software` |
| GT-01 | HIGH | QG-02, QG-03, QG-04, QG-05 | docs/traceability.md L100; `.github/workflows/ci.yml`, `scripts/assert-suite-ran.mjs` | Repaired, Wave 1 | B1 | - | CI on the merge SHA runs non-zero browser and performance suites and fails when either skips; release waits for both. Residual (admin action): tick both checks as required in GitHub branch protection. | `verified complete` |
| GT-02 | HIGH | MG-11, QG-08, QG-12 | None yet (Wave 7) | Repair, Wave 7 | B4 | Backup/restore B4 | A rollback is shown as performed only after execution evidence; outcome survives reload and sync; rehearsal restores service and reconciles data. | `pending software` |
| GT-03 | HIGH | MG-06, MG-10, MG-11, QG-07, QG-12 | None yet (Wave 7) | Repair, Wave 7 | B4 | - | A forged all-green body cannot override open server totals, differences or missing rollback; only current signed records plus the owner's authenticated act give GO. | `pending software` |
| GT-04 | HIGH | MG-09, QG-07 | None yet (Wave 7) | Repair, Wave 7 | B4 | Domain write paths B2/B3 | A known delta changes stock/money readable in its domain; retry with a new idempotency key and after restart gives one effect with source identity kept. | `pending software` |
| GT-05 | HIGH | MG-05, MG-07, MG-08, QG-07 | None yet (Wave 7) | Repair, Wave 7 | B4 | Opening stock by location/batch B2 | A full-volume synthetic fixture of every approved domain migrates and reads back; openings reconcile by location/batch/account; an interrupted rerun doubles nothing. | `pending software` |
| GT-06 | HIGH | MG-03, MG-05, M06-FR-01 | `tests/unit/migration-load.test.ts`, `tests/integration/migration-load.test.ts`: supplier name + GSTIN into the supplier master, checksum-checked, read back, used on a PO, rerun keeps one (Batch 2, 10 Oct 2026) | Repair, Wave 7 | B4 | Supplier master B2 (`services/purchase`) | An imported supplier keeps name and GSTIN, reads back through supplier master and is selectable on a PO; rerun keeps one supplier; malformed/duplicate identity refused visibly. | `verified complete` |
| GT-07 | HIGH | QG-08, MG-02, M35-FR-01 | None yet (Wave 7) | Repair, Wave 7 | B4 | PA-12 | Concurrent appends during backup; restore into an empty isolated target; manifest counts and money match the exact snapshot; the durable boundary is stated. | `pending software` |
| GT-08 | MEDIUM | QG-02, QG-03, MG-04, MG-06 | docs/traceability.md L99; `docs/evidence/TEST-SCOPE.md`, `docs/evidence/evidence-ledger.md` | Repaired, Wave 1 | B4 | - | Evidence ledger records browser UI, device, cloud effect and staff/device evidence separately per requirement; CI refuses a stale ledger. | `verified complete` |
| GT-09 | LOW | QG-01, QG-03 | docs/traceability.md L99; `docs/evidence/TEST-SCOPE.md` v1 | Repaired, Wave 1 | B4 | - | One versioned report states suite scope, required execution, capability skips and human gates. | `verified complete` |
| GT-10 | MEDIUM | QG-03, QG-04 | docs/traceability.md L157; `tests/support/in-memory-till-box.ts` | Repaired, Wave 0 | B1 | Till tests B3 | The till-session suite passes under TZ=UTC and TZ=Asia/Kolkata. | `verified complete` |
| PA-01 | HIGH | M01-FR-01, M02-FR-02, M25-FR-01 | #704; docs/traceability.md L110 (consolidation, drill-through, roster only) | Partly repaired; residual reopened as PA-01-r1 | B1 | All branch-keyed route owners (B2 inventory first) | Closes only when PA-01-r1 passes (the #704 part stays proven). | `pending software` |
| ↳ PA-01-r1 | HIGH | M01-FR-01, M02-FR-02, M08 | Reproduced by the coordinator 10 Oct 2026; repair plan (Wave 2, PA-01 note) records "the other fifteen branch-keyed route files follow family by family" | Residual defect, sub-item of PA-01 | B1 | Inventory routes owned by B2 (`services/inventory`); B1 owns the scope rule | A manager granted only branch A: reading branch B inventory with an explicit selector is refused by name; an omitted selector returns branch A only; a stock movement to branch B is refused with nothing appended; a direct-ID read of a B record is refused; real API on PostgreSQL, after restart. | `pending software` |
| PA-02 | HIGH | M02-FR-04, M25-FR-01 | #703; docs/traceability.md L109 | Repaired, Wave 2b-i | B1 | - | A leaver's same token and a new session are refused after revocation and after restart, in memory and on PostgreSQL. Residual: SP-10. | `verified complete` |
| PA-03 | HIGH | M02-FR-02, M02-FR-03, M26-FR-03, M26-FR-04, M31-FR-01 | #705, #707, 2b-vi-a..c-4 (ADR-0024); docs/traceability.md L134-L148; `docs/registers/second-person-sites-2026-10-07.md` (26 of 26 fixed) | Repaired, Wave 2b-iii/2b-vi | B1 | - | Every second-person route takes the approver's own authenticated act; typed names refused. Residual: on a real store box the back-office screens have no sign-in until the OB-15 sign-in is switched on, so their decisions arrive flagged and are not applied; SP-10. | `verified complete` |
| PA-04 | HIGH | M01-FR-01, M01-FR-04 | `services/platform/src/branch-lifecycle.ts` (what-if only) | Repair, Wave 6 | B1 | Balances from B2/B3 | A governed branch transition reads real balances and sync state, needs separate owner approval, persists, revokes branch access; stock/non-zero/sync holds and post-close denial tested. | `pending software` |
| PA-05 | MEDIUM | M01-FR-01 | None yet (Wave 6) | Repair, Wave 6 | B1 | - | An organisation rename persists and reads back; rename, revert and restart regression; idempotency key separate from record version. | `pending software` |
| PA-06 | HIGH | M01-FR-03, M02-FR-01, M02-FR-02, M25-FR-02, M33-FR-02 | Parts a, 2a, 2b (9 Oct), 3a (#754, 10 Oct); docs/traceability.md L123-L126 | In progress, Wave 4 (OB-26 "A", OB-30 "A") | B1 | Quantity scale agreed with B2; buying screen B2 | Part 3b: the demo box takes its setup from head office; `db/seed/pilot/store-pack.ts`, `scripts/demo-store-pack.mjs` and `demo:store-pack` retired; buying screen runs as the signed-in person; warehouse bins and practice delivery from head office; one quantity scale across pack sections. Plus PA-06-r1. | `pending software` |
| ↳ PA-06-r1 | HIGH | M01-FR-03, M33-FR-02 | Reproduced by the coordinator 10 Oct 2026; `edge/store-edge/src/store-pack-held.ts`, `edge/store-edge/src/main.ts` (store-pack pull outcome) | Residual defect, sub-item of PA-06 | B1 | - | A newer validly signed store setup with unchanged business contents replaces the held envelope (new version and expiry kept); the box stops reporting an expired setup; restart keeps it; test fails on the old code. | `pending software` |
| PA-07 | HIGH | M26-FR-02, M10-FR-02 | docs/traceability.md L130; `packages/facilities/src/monitoring.ts` | Repaired, Wave 3 | B2 | - | A breach holds every batch registered in the room, once per excursion, released only by QC permission. Residual: room contents recorded by a person; no timer; no separate incident record; SP-10. | `verified complete` |
| PA-08 | HIGH | M31-FR-03, M31-FR-04, M32-FR-02, M32-FR-04 | `packages/notifications` queue (no worker) | Repair, Wave 6 | B4 | Outbox/retry/dead letter B1 | A full notification intent is persisted; recipient, approved template, current consent and budget re-checked at enqueue and before delivery; provider-neutral worker with stub transport, idempotent receipts, backoff, dead letter. Residual: real providers certified after. | `pending software` |
| PA-09 | MEDIUM | M31-FR-02 | None yet (Wave 6) | Repair, Wave 6 | B4 | Source records B2/B3 | Document issue resolves source type/id/version on the server, refuses missing/draft sources and client money overrides, freezes amounts/tax/template; PO/GRN/invoice/statement and audited reprint proven. | `pending software` |
| PA-10 | MEDIUM | M33-FR-02, M33-FR-03 | `services/platform/src/remote-sessions.ts` (registry only) | Repair, Wave 7 | B1 | - | A support session's grant is enforced on every request and its channel cut on expiry/revocation; a session held open while revoked is refused. | `pending software` |
| PA-11 | MEDIUM | M34-FR-01, SEC-07 | #702; docs/traceability.md L108 | Repaired, Wave 2a | B1 | - | Two writers cannot fork the audit chain (per-tenant guard), proven on PostgreSQL. | `verified complete` |
| PA-12 | HIGH | M35-FR-01, M35-FR-02, M35-FR-03, M35-FR-04 | `services/platform/src/backup-verification.ts`, `observed-health.ts` | Repair, Wave 7 | B4 | Lane signals from B1 (edge) | Backup success/failure and lane signals reach durable alert delivery and a named owner receives/escalates (software). Residual (external): owner names off-site destination and custodians; immutable off-site replication; restore on a spare store machine with RPO/RTO/control totals. | `pending software` |
| PA-13 | MEDIUM | M36-FR-01, M36-FR-02, M36-FR-03, M36-FR-04 | `docs/release-plan.md` section 3, R8 row (OA-12); ledger wording corrected 5 Oct (`docs/STATUS.md` GT-09 entry) | Deferred to R8 (OA-12) | B1 | - | Wording fix done. When R8 is scheduled: plan, dunning and metering bound to optional entitlements without blocking sales; tenant closure; SDK and partner sandbox. | `approved deferral` |
| PF-01 | CRITICAL | M13-FR-01, M13-FR-03, M17-FR-01, M17-FR-03, M17-FR-04 | #701; docs/traceability.md L107 (`packages/persistence/src/event-store.ts` write guard, PostgreSQL race test) | Repaired, Wave 2a | B3 | Write guard owned by B1 (`packages/persistence`) | Two concurrent distinct refunds/spends of one balance: one lands, the other is a named 409 `concurrent_change`, on real PostgreSQL. Residual: SP-10. | `verified complete` |
| PF-02 | CRITICAL | M12-FR-04, M13-FR-03, M14-FR-01 | #709, #710, 2b-v-c, 2b-v-d (ADR-0020..0023); docs/traceability.md L137-L140 | Repaired, Wave 2b-v | B1 | Till/refund use owned by B3 | Typed cashier or approver refused before the disk; manager approval bound to kind/bill/amount/till, 5 min, one use; head office flags unsealed facts. Residual: SP-10. | `verified complete` |
| PF-03 | CRITICAL | M12-FR-04 | #708; docs/traceability.md L136 | Repaired, Wave 2b-iv | B3 | - | A restricted item cannot commit without the signed-in cashier's age answer in the basket; head office flags a restricted line without it CRITICAL. Residual: SP-10. | `verified complete` |
| PF-04 | HIGH | M12-FR-02, M01-FR-02 | docs/traceability.md L117 (`edge/store-edge/src/receipt-numbers.ts`); OB-22 "A" | Repaired, Wave 4 | B3 | Ranges via store pack B1 | Receipt numbers issued on the box, never repeated across restart, two tabs, failed write, exhaustion. Residual: ranges published from a head-office screen ride PA-06; SP-10. | `verified complete` |
| PF-05 | HIGH | M12-FR-02 | docs/traceability.md L118 (`edge/store-edge/src/held-bills.ts`); #755 | Repaired, Wave 4 | B3 | - | Hold -> reload -> recall once at the held prices -> sale; give-up with a reason kept. Residual: held baskets per store computer; SP-10. | `verified complete` |
| PF-06 | HIGH | M12-FR-03, M14-FR-03, M23-FR-03, D04-FR-02 | docs/traceability.md L119 (`edge/store-edge/src/payment-attempts.ts`) | Code side repaired, Wave 4 | B3 | - | Attempt recorded before the machine; no-answer settled only by the provider; one payment one bill. Residual: live acquirer/UPI credentials (EX-03); unresolved list to head office in Wave 5; SP-10. | `verified complete` |
| PF-07 | HIGH | M15-FR-01, M12-FR-04 | docs/traceability.md L120 (voids only) | Partly repaired, Wave 4 | B3 | - | No-sale (open drawer) and price-override events recorded on the box first, relayed and judged on head office's record; raised exceptions shown in the owner/manager inbox; days judged by trading-day cut-off. | `pending software` |
| PF-08 | HIGH | M14-FR-02, M14-FR-04 | docs/traceability.md L132; OB-27 "A" | Repaired, Wave 5 | B3 | - | An open shift blocks the day close; no caller can type a zero variance. Residual: a card answer still pending does not yet hold the close (with PF-06); SP-10. | `verified complete` |
| PF-09 | HIGH | M17-FR-01, M17-FR-02, M17-FR-03, M17-FR-04, M12-FR-03 | Step 1 #753, docs/traceability.md L133; in flight: `origin/claude/happy-cannon-l1g5pe` c1076976 "PF-09 step 2" (green, unmerged) | In progress, Wave 5 (OB-28, OB-29) | B3 | Member code via store pack B1 | Step 2 merged (till keys the mobile, box turns it into the member code, number never on disk); step 3 points and store credit spent as tenders, liability figure; connected sale -> value -> return -> liability on PostgreSQL. Residual: SMS check R4 (OB-29). | `pending software` |
| PF-10 | HIGH | M21-FR-01, M21-FR-02 | None yet (Wave 6) | Repair, Wave 6 | B4 | Consent B4; transport PA-08 | Campaign joins stored template approval and recipient frequency history, enqueues approved recipients, re-checks withdrawal just before send, records delivery callbacks. Residual: provider access. | `pending software` |
| PF-11 | HIGH | M21-FR-03 | None yet (Wave 6) | Repair, Wave 6 | B3 | Approval engine B1 | Approval separated from execution; compensation fulfilled once through existing money/value ports with pending/completed/failed status and compensating recovery. | `pending software` |
| PF-12 | HIGH | M23-FR-02, M23-FR-03, M23-FR-04 | None yet (Wave 5) | Repair, Wave 5 | B3 | Tally outbox via B1 messaging | Imported independent evidence persisted with provenance and joined to the close; purchase tax/ITC capture and reconciliation; Tally outbox adapter with replay proof. Residual: CA mapping, Tally licence, bank statement, live GST credentials. | `pending software` |
| PF-13 | HIGH | M27-FR-01, M27-FR-04 | None yet (Wave 5) | Repair, Wave 5 | B3 | Store-pack section B1 | Contract approval is a second person's act; the current trading decision rides the store pack and blocks a counter before money; expired/insurance-lapsed served-till proof; offline facts kept as exceptions. | `pending software` |
| PF-14 | HIGH | M13-FR-02, M12-FR-01 | docs/traceability.md L114 (`packages/returns/src/return-lots.ts`) | Repaired, Wave 3 | B3 | Stock states B2 | A returned unit keeps its sold lot; non-resellable quantity held in quality state with linked disposition. Residual: the person's disposition decision step; SP-10. | `verified complete` |
| PF-15 | MEDIUM | M12-FR-01, M12-FR-02, M14-FR-04 | docs/traceability.md L99; `docs/evidence/evidence-ledger.md` | Repaired, Wave 1 | B4 | - | One acceptance matrix per FR with separate unit/integration/real-DB/browser/device/UAT columns. | `verified complete` |
| SF-01 | HIGH | M05-FR-01, M05-FR-02, M05-FR-03, M05-FR-04 | docs/traceability.md L115-L116 | Repaired, Wave 4 | B3 | - | Screen price and launched offer reach the next signed pack and the till charges them. Residual: head office price routes still read `marginFloorBps` from the request (`services/pricing/src/index.ts`; second-person register) - tracked under M05; SP-10. | `verified complete` |
| SF-02 | HIGH | M06-FR-04, M07-FR-01, M07-FR-03 | #730; docs/traceability.md L111 | Repaired, Wave 3 | B2 | - | 60 then 60 against 100: the second is held for excess approval; simultaneous receipts guarded. | `verified complete` |
| SF-03 | HIGH | M08-FR-01, M08-FR-02, M09-FR-03, M10-FR-03 | #731; docs/traceability.md L112 | Repaired, Wave 3 | B2 | - | Transfer availability from one batch/state/reservation-aware projection; split/unknown/reserved/expired batches tested. | `verified complete` |
| SF-04 | HIGH | M08-FR-02, M08-FR-03, M09-FR-03 | #702; docs/traceability.md L108 | Repaired, Wave 2a | B2 | Write guard B1 | Two transfers racing for the same stock: one lands, the other a named conflict. | `verified complete` |
| SF-05 | HIGH | M28-FR-01, M08-FR-03 | #733, #734; docs/traceability.md L113 | Repaired, Wave 3 | B2 | - | Loss value from stored cost; supplied zero refused; unknown cost needs approval. | `verified complete` |
| SF-06 | HIGH | M30-FR-01, M30-FR-03, M30-FR-04, M03-FR-04 | docs/traceability.md L121-L122; OB-23 "C", OB-24 "A" | Repaired, Wave 4 | B2 | Approval engine B1 | Invoice and product files write real records under a checker decision with rollback. Residual: no Undo button on screen; existing-product edits by file not built; 80+ line timing needs the owner; SP-10. | `verified complete` |
| SF-07 | HIGH | M07-FR-02, M10-FR-02 | docs/traceability.md L127-L129 | Repaired, Wave 3 | B2 | - | Cold-chain rule from product master; no reading or out of range is held for a second person; store screen and handheld take the reading. Residual: SP-10. | `verified complete` |
| SF-08 | HIGH | M10-FR-02, M10-FR-04, M08-FR-02 | docs/traceability.md L131; OB-25 "C (R3) and 1" | Repaired, Wave 3 | B2 | Pack delivery B1 (PA-06) | Recall/hold -> next signed pack -> offline scan refused. Residual: batch-precise block deferred to R3 (OB-25); delivery by store pull, no push; SP-10. | `verified complete` |
| SF-09 | MEDIUM | M24-FR-01, M24-FR-02, M24-FR-04 | None yet (Wave 6) | Repair, Wave 6 | B2 | Partner auth B1 | Supplier-scoped document submission with buyer review feeding existing ASN/invoice services, payload preserved; connected acceptance. Residual: partner API/EDI proof. | `pending software` |
| SF-10 | MEDIUM | M30-FR-02, M30-FR-04 | None yet (Wave 6) | Repair, Wave 6 | B4 | Domain adapters B2/B3; import rollback B2 (SF-06) | Export coverage register; adapters for missing domains on the existing engine; authenticated import rollback with compensating events. | `pending software` |
| SF-11 | MEDIUM | M03-FR-01, M03-FR-02, M03-FR-04 | None yet (Wave 6) | Repair, Wave 6 | B2 | - | FR acceptance checklist for M03; case -> inner -> base chain proven; missing image/bulk/category behaviour built only after the evidence inventory. | `pending software` |
| SF-12 | MEDIUM | M30-FR-01, M09-FR-04, M10-FR-01, M07-FR-01 | `docs/registers/sp10-staff-uat.md` (0 sessions run) | Wave 8 | B2 | All batches' software first | Named buyer -> receiver -> back-store -> floor -> cashier run SP-10 on real store hardware; results recorded in the SP-10 register and accepted by the owner. | `staff/device acceptance` |

## B. The 104 controlling items

| ID | Name | Current label | Linked findings | Primary batch | State | What remains |
|---|---|---|---|---|---|---|
| M01 | Organization, branch and configuration | WIRED | EA-03, EA-04, PA-01, PA-04, PA-05, PA-06, PF-04, PA-01-r1, PA-06-r1 | B1 | `pending software` | PA-01-r1; PA-04 branch lifecycle; PA-05 rename; PA-06 part 3b and PA-06-r1. |
| M02 | Identity, RBAC and approvals | INTEGRATION_TESTED | PA-01, PA-02, PA-03, PA-06, PA-01-r1 | B1 | `pending software` | PA-01-r1; buying screen as the signed-in person (PA-06 part 3b); OB-15 sign-in switched on for store-box back-office screens. |
| M03 | Product information and master data | INTEGRATION_TESTED | SF-06, SF-11 | B2 | `pending software` | SF-11 FR acceptance (case/inner/base, bulk, images, category). |
| M04 | Merchandising, space and planograms | WIRED | FUL-11 | B2 | `pending software` | FUL-11; replenishment tasks persisted and audited (M04-FR-03). |
| M05 | Pricing and promotions | E2E_VERIFIED | SF-01 | B3 | `pending software` | Margin floor from the shop's own policy, not the request (`services/pricing/src/index.ts`); SP-10. |
| M06 | Supplier and procurement | E2E_VERIFIED | GT-06, SF-02 | B2 | `pending software` | GT-06 supplier import keeps name/GSTIN (B4 builds, B2 reviews). |
| M07 | Receiving, QC and three-way match | E2E_VERIFIED | SF-02, SF-07, SF-12 | B2 | `staff/device acceptance` | Nothing in software; SF-12 / SP-10 receiving run on real devices. |
| M08 | Inventory ledger and availability | E2E_VERIFIED | SF-03, SF-04, SF-05, SF-08, PA-01-r1 | B2 | `pending software` | PA-01-r1 branch scope on inventory read and movement routes. |
| M09 | Warehouse and replenishment | E2E_VERIFIED | SF-03, SF-04, SF-12 | B2 | `pending software` | Warehouse bins and practice delivery from head office (PA-06 part 3b). |
| M10 | Batch, expiry, quality and recall | E2E_VERIFIED | PA-07, SF-03, SF-07, SF-08, SF-12 | B2 | `staff/device acceptance` | Nothing in software now; batch-precise till block deferred to R3 (OB-25); SP-10. |
| M11 | Fresh food and internal production | INTEGRATION_TESTED | FUL-01, FUL-08, FUL-13 | B2 | `pending software` | FUL-01, FUL-08, FUL-13; PostgreSQL proof of the production path. |
| M12 | POS sales and checkout | E2E_VERIFIED | PF-02, PF-03, PF-04, PF-05, PF-06, PF-07, PF-09, PF-14, PF-15 | B3 | `pending software` | PF-07 no-sale/override; PF-09 steps 2-3 (step 2 in flight). |
| M13 | Returns, exchanges and refunds | INTEGRATION_TESTED | PF-01, PF-02, PF-14 | B3 | `external dependency` | Nothing in software; live card/UPI refund reversal needs provider credentials (EX-03). |
| M14 | Till, cash office and day close | E2E_VERIFIED | PF-02, PF-06, PF-08, PF-15 | B3 | `pending software` | A pending card/UPI answer holding the day close and reaching head office (PF-06/PF-08 residual). |
| M15 | Loss prevention and fraud | E2E_VERIFIED | PF-07 | B3 | `pending software` | PF-07 no-sale/override evidence and exceptions in the inbox. |
| M16 | Customer 360 and consent | WIRED | FUL-06, FUL-10, FUL-12 | B4 | `pending software` | FUL-06, FUL-10, FUL-12; SMS check deferred to R4 (OB-29). |
| M17 | Loyalty, membership and gift value | E2E_VERIFIED | PF-01, PF-09 | B3 | `pending software` | PF-09 steps 2-3: member at the till, points and store credit spent, liability. |
| M18 | Order management and omnichannel | PARTIALLY_WIRED | FUL-02, FUL-03, FUL-05, FUL-07, FUL-14 | B3 | `pending software` | FUL-03, FUL-05, FUL-07, FUL-14. |
| M19 | Picking, packing and delivery | PARTIALLY_WIRED | FUL-04, FUL-05, FUL-14 | B3 | `pending software` | FUL-04 (B2), FUL-05, FUL-14. |
| M20 | Customer mobile app and web commerce | PARTIALLY_WIRED | FUL-02, FUL-03, FUL-05, FUL-06, FUL-07, FUL-12 | B3 | `pending software` | FUL-03, FUL-07; FUL-06/FUL-12 (B4). |
| M21 | CRM, marketing and service desk | INTEGRATION_TESTED | PF-10, PF-11 | B4 | `pending software` | PF-10 campaigns; PF-11 compensation (B3); service-desk screens browser-verified. |
| M22 | B2B and institutional sales | WIRED | FUL-09 | B4 | `pending software` | FUL-09 B2B vertical slice. |
| M23 | Finance, tax and accounting bridge | PARTIALLY_WIRED | PF-06, PF-12 | B3 | `pending software` | PF-12 close evidence, ITC, Tally outbox; live GST/e-invoice credentials external. |
| M24 | Supplier and external partner portals | E2E_VERIFIED | SF-09 | B2 | `pending software` | SF-09 supplier document submission. |
| M25 | Workforce, tasks and SOP | E2E_VERIFIED | PA-01, PA-02, PA-06 | B4 | `staff/device acceptance` | Nothing in software from the audit (roster scope fixed #704); SP-10. |
| M26 | Facilities, assets and utilities | E2E_VERIFIED | PA-03, PA-07 | B4 | `staff/device acceptance` | Nothing in software from the audit; IoT sensor feed is hardware; SP-10. |
| M27 | Concession and shop-in-shop | WIRED | PF-13 | B3 | `pending software` | PF-13 pre-sale block from the concession decision. |
| M28 | Waste, disposal and sustainability | E2E_VERIFIED | SF-05 | B2 | `staff/device acceptance` | Nothing in software; SP-10. |
| M29 | Owner command centre and BI | WIRED | EA-01, EA-02, EA-03, EA-04, EA-05, EA-06, EA-07 | B4 | `pending software` | EA-01, EA-02, EA-04, EA-05, EA-06, EA-07. |
| M30 | Import, export and data quality | INTEGRATION_TESTED | EA-04, SF-06, SF-10, SF-12 | B4 | `pending software` | SF-10 all-domain export and rollback; EA-04 export. |
| M31 | Document, notification and communications | WIRED | PA-03, PA-08, PA-09 | B4 | `pending software` | PA-08 deliverable consent-checked messages; PA-09 governed document issue. |
| M32 | Integration and developer platform | E2E_VERIFIED | PA-08 | B1 | `pending software` | PA-08 outbound worker (built by B4 on B1 messaging). |
| M33 | Platform administration and support | E2E_VERIFIED | PA-06, PA-10, PA-06-r1 | B1 | `pending software` | PA-06 part 3b, PA-06-r1, PA-10. |
| M34 | Audit, risk and compliance evidence | E2E_VERIFIED | PA-11 | B1 | `verified complete` | Nothing in software (PA-11 closed, E2E_VERIFIED). |
| M35 | Backup, disaster recovery and observability | PARTIALLY_WIRED | GT-07, PA-12 | B4 | `pending software` | GT-07, PA-12 alert wiring; off-site storage external. |
| M36 | Commercialization and multi-tenant readiness | PARTIALLY_WIRED | PA-13 | B1 | `approved deferral` | R8 scope (release-plan R8, OA-12): billing, metering, closure, SDK. |
| D01 | Product and catalogue | PARTIALLY_WIRED | EA-10 | B2 | `pending software` | Content/images authoring (D01-FR-06) not started; EA-10 refresh. |
| D02 | Merchandise planning | PARTIALLY_WIRED | EA-10 | B2 | `pending software` | FUL-11 planning facts; EA-10 refresh. |
| D03 | Supplier and buying | PARTIALLY_WIRED | EA-10 | B2 | `pending software` | SF-09; EA-10 refresh. |
| D04 | POS and cash | PARTIALLY_WIRED | EA-02, EA-10, PF-06 | B3 | `pending software` | PF-07, PF-09; EA-02 tender reporting (B4); EA-10 refresh. |
| D05 | Inventory and quality | PARTIALLY_WIRED | EA-10 | B2 | `pending software` | EA-10 refresh; batch-precise block R3 (OB-25). |
| D06 | Pricing and promotions | PARTIALLY_WIRED | EA-10 | B3 | `pending software` | Markdown/competitor capture partial; EA-10 refresh. |
| D07 | Customer and loyalty | PARTIALLY_WIRED | EA-10 | B3 | `pending software` | PF-09; coupons/referrals engine-only; EA-10 refresh. |
| D08 | Customer app/web | PARTIALLY_WIRED | EA-10 | B3 | `pending software` | FUL-03, FUL-07; EA-10 refresh. |
| D09 | OMS and delivery | PARTIALLY_WIRED | EA-10 | B3 | `pending software` | FUL-04, FUL-05, FUL-14; EA-10 refresh. |
| D10 | Finance and tax | PARTIALLY_WIRED | EA-10 | B3 | `pending software` | PF-12; EA-10 refresh. |
| D11 | Store and workforce | PARTIALLY_WIRED | EA-10 | B4 | `pending software` | EA-10 refresh of the stale workforce entry. |
| D12 | Platform/admin | PARTIALLY_WIRED | EA-10 | B1 | `pending software` | PA-04, PA-05, PA-06 part 3b, PA-10; EA-10 refresh. |
| D13 | Reporting/owner | PARTIALLY_WIRED | EA-01, EA-02, EA-03, EA-04, EA-05, EA-06, EA-07, EA-10 | B4 | `pending software` | EA-01, EA-02, EA-04, EA-05, EA-06, EA-07. |
| D14 | Hardware/integration | PARTIALLY_WIRED | EA-10 | B1 | `pending software` | Gateway/webhooks partial; EA-10 refresh; live hardware/ESL/IoT external. |
| A01 | Owner Intelligence | PARTIALLY_WIRED | EA-07, EA-08 | B4 | `pending software` | EA-07 scheduled delivery; EA-08 model governance. |
| A02 | Purchase | PARTIALLY_WIRED | EA-08 | B4 | `pending software` | EA-08 remaining legs. |
| A03 | Inventory | WIRED | — | B4 | `pending software` | Transfer-suggestion leg (multi-location stock reader). |
| A04 | Customer Shopping | PARTIALLY_WIRED | EA-08 | B4 | `pending software` | EA-08 remaining legs. |
| A05 | Service | WIRED | — | B4 | `pending software` | Draft case-response content leg and agent screen. |
| A06 | Operations | E2E_VERIFIED | EA-09 | B4 | `pending software` | EA-09 connected production path. |
| A07 | Security/Fraud | WIRED | — | B4 | `pending software` | Summarise-anomalies leg and security-officer screen. |
| A08 | Data Quality | E2E_VERIFIED | EA-09 | B4 | `pending software` | EA-09 connected production path. |
| A09 | Marketing | WIRED | — | B4 | `pending software` | Draft campaign/offer content legs and approver screen. |
| A10 | Workforce/SOP | E2E_VERIFIED | EA-09 | B4 | `pending software` | EA-09 connected production path. |
| WF-01 | Product onboarding | PARTIALLY_WIRED | EA-10 | B2 | `pending software` | SF-11, D01 content; EA-10 refresh. |
| WF-02 | Supplier onboarding | PARTIALLY_WIRED | EA-10 | B2 | `pending software` | SF-09, GT-06; EA-10 refresh. |
| WF-03 | Purchase planning | PARTIALLY_WIRED | EA-10 | B2 | `pending software` | A02 legs (EA-08); EA-10 refresh. |
| WF-04 | Receiving | PARTIALLY_WIRED | EA-10 | B2 | `pending software` | EA-10 refresh (SF-02/SF-07 closed); SP-10. |
| WF-05 | Supplier invoice | PARTIALLY_WIRED | EA-10 | B2 | `pending software` | PF-12 purchase tax/ITC join; EA-10 refresh. |
| WF-06 | Replenishment | PARTIALLY_WIRED | EA-10 | B2 | `pending software` | M04-FR-03 tasks; FUL-11; EA-10 refresh. |
| WF-07 | Stock transfer | PARTIALLY_WIRED | EA-10 | B2 | `pending software` | Dedicated connected transfer proof; EA-10 refresh. |
| WF-08 | Stock count | PARTIALLY_WIRED | EA-10 | B2 | `pending software` | EA-10 refresh; count-to-finance join (M23). |
| WF-09 | Expiry/recall | PARTIALLY_WIRED | EA-10 | B2 | `pending software` | EA-10 refresh; batch-precise block R3 (OB-25). |
| WF-10 | POS sale | E2E_VERIFIED | EA-10 | B3 | `pending software` | PF-09 member at the till; PF-07; SP-10. |
| WF-11 | POS return | PARTIALLY_WIRED | EA-10 | B3 | `pending software` | PF-09 step 3 store credit; EA-10 refresh; card refund live provider external. |
| WF-12 | Day close | PARTIALLY_WIRED | EA-10 | B3 | `pending software` | Pending card answer in the close; EA-10 refresh. |
| WF-13 | Customer order | PARTIALLY_WIRED | EA-10 | B3 | `pending software` | FUL-03, FUL-05, FUL-07; EA-10 refresh. |
| WF-14 | Fulfilment | PARTIALLY_WIRED | EA-10 | B3 | `pending software` | FUL-04, FUL-05; EA-10 refresh. |
| WF-15 | Delivery | PARTIALLY_WIRED | EA-10 | B3 | `pending software` | FUL-05 COD/RTO money; EA-10 refresh. |
| WF-16 | Online cancellation/return | PARTIALLY_WIRED | EA-10 | B3 | `pending software` | FUL-05 cancellation money join; EA-10 refresh. |
| WF-17 | Customer service | PARTIALLY_WIRED | EA-10 | B4 | `pending software` | PF-11 (B3); service screens; EA-10 refresh. |
| WF-18 | Finance close | PARTIALLY_WIRED | EA-10 | B3 | `pending software` | PF-12; EA-10 refresh. |
| WF-19 | Migration/cutover | ENGINE_ONLY | EA-10 | B4 | `pending software` | GT-02 to GT-07; never run on real data. |
| WF-20 | Release/incident | PARTIALLY_WIRED | EA-10 | B1 | `pending software` | PA-12, GT-07 (B4); EA-10 refresh. |
| QG-01 | Requirements | PARTIALLY_WIRED | GT-09 | B4 | `external dependency` | Nothing in software; owner signs the gate at pilot (QG-12 process). |
| QG-02 | UX | PARTIALLY_WIRED | GT-01, GT-08 | B4 | `staff/device acceptance` | Nothing in software; cashier training/performance targets proven in SP-10. |
| QG-03 | Code | PARTIALLY_WIRED | GT-01, GT-08, GT-09, GT-10 | B1 | `external dependency` | Nothing in software (`scripts/sbom.mjs` in CI); admin action: branch-protection ticks (GT-01). |
| QG-04 | Offline | INTEGRATION_TESTED | GT-01, GT-10 | B1 | `staff/device acceptance` | Nothing in software; offline sale on the real store PC and devices. |
| QG-05 | Performance | PARTIALLY_WIRED | GT-01 | B1 | `external dependency` | Scan-to-line p95 on certified pilot hardware. |
| QG-06 | Security | PARTIALLY_WIRED | — | B1 | `external dependency` | Independent penetration test (external security vendor). |
| QG-07 | Data | PARTIALLY_WIRED | GT-03, GT-04, GT-05 | B4 | `pending software` | GT-03, GT-04, GT-05; signed totals need real data. |
| QG-08 | Recovery | PARTIALLY_WIRED | GT-02, GT-07 | B4 | `pending software` | GT-02, GT-07, PA-12; DR rehearsal. |
| QG-09 | Adoption | PARTIALLY_WIRED | — | B4 | `staff/device acceptance` | Nothing in software; role competency and SOP acknowledgements. |
| QG-10 | Production | PARTIALLY_WIRED | — | B1 | `external dependency` | Production environment and domain (owner) for post-release verification. |
| QG-11 | AI | PARTIALLY_WIRED | EA-09 | B4 | `pending software` | EA-09; model accuracy evaluations (EA-08). |
| QG-12 | Owner | PARTIALLY_WIRED | GT-02, GT-03 | B4 | `pending software` | GT-02, GT-03 (no caller boolean overrides evidence). |
| MG-01 | Discovery | INTEGRATION_TESTED | — | B4 | `external dependency` | Nothing in software; lawful access to legacy data. |
| MG-02 | Preservation | INTEGRATION_TESTED | GT-07 | B4 | `pending software` | GT-07 one-snapshot backup and manifest. |
| MG-03 | Mapping | INTEGRATION_TESTED | GT-06 | B4 | `pending software` | GT-06 supplier mapping keeps identity. |
| MG-04 | Cleaning | E2E_VERIFIED | GT-08 | B4 | `external dependency` | Nothing in software; cleaning on legacy data, witnesses (Wave 7). |
| MG-05 | Trial loads | INTEGRATION_TESTED | GT-05, GT-06 | B4 | `pending software` | GT-05, GT-06. |
| MG-06 | Reconciliation | E2E_VERIFIED | GT-03, GT-08 | B4 | `pending software` | GT-03. |
| MG-07 | History | INTEGRATION_TESTED | GT-05 | B4 | `pending software` | GT-05. |
| MG-08 | Opening state | INTEGRATION_TESTED | GT-05 | B4 | `pending software` | GT-05. |
| MG-09 | Delta | INTEGRATION_TESTED | GT-04 | B4 | `pending software` | GT-04. |
| MG-10 | Parallel run | INTEGRATION_TESTED | GT-03 | B4 | `pending software` | GT-03. |
| MG-11 | Cutover | E2E_VERIFIED | GT-02, GT-03 | B4 | `pending software` | GT-02, GT-03. |
| MG-12 | Archive/retire | INTEGRATION_TESTED | — | B4 | `external dependency` | Nothing in software; retirement after accepted cutover and retention. |

## C. Batches and shared contracts

| Batch | Scope |
|---|---|
| B1 Foundation, security and hybrid operation | Identity, permissions, scope, staff lifecycle, config, store setup delivery (PA-06/DF-3), installed/offline operation, sync, retries, restart, install/upgrade, branch protection, Keycloak in CI (the real-Keycloak suites still run by hand — `docs/STATUS.md`, OB-15-a). |
| B2 Purchase, receiving and store inventory | Supplier master/imports, PR/PO/approval/invoice match, receiving/QC/quarantine/supplier return, bins/movements, floor indents/transfer/floor receipt/discrepancy, units/precision, batch/expiry/recall/cold chain, counts/adjustments/wastage/loss, production/conversion stock. |
| B3 Sales, returns and financial closure | Till, payments/split tenders/reversals/settlement, cash/shift/day close, refunds, loyalty/store credit/liabilities, PF-06..PF-13, concessions, online checkout/fulfilment money joins, compensation, B2B collection money. |
| B4 Reporting, supporting workflows and readiness | EA-xx reporting, owner reports, consent/privacy, campaigns/comms, B2B workflows (non-money), AI agents A01–A10, migration MG-xx/GT-xx, backup/restore/recovery, runbooks, QG documentation. |

Rule for every contract below: **another batch requests a change through the owning batch** (an issue or a PR the owner
batch reviews); it never edits the contract in its own slice.

| Contract | Owning batch | Where it lives |
|---|---|---|
| Event envelope and schemas, money, rates | B1 | `packages/contracts/src/event.ts`, `money.ts`, `rate.ts`, `allocate.ts`, `enums.ts` |
| Identity, tenant, branch, staff, device | B1 | `packages/identity/src` (`till-pin.ts`, `till-seal.ts`, `oidc-port.ts`, `lifecycle.ts`), `packages/tenant/src`, `packages/rbac/src/rbac.ts`, `services/identity/src`, `edge/store-edge/src/till-operators.ts`, `device-enrolments.ts`, `infra/keycloak/realm-sre-store.json` |
| Kernel permissions and branch scope | B1 | `services/kernel/src/router.ts`, `scope.ts`, `pipeline.ts`, `step-up.ts`, `audit-chain.ts` |
| Maker-checker approvals (ADR-0024) | B1 | `services/identity/src/approval-requests.ts`, `packages/approvals/src` |
| Store-pack format and delivery | B1 | `services/platform/src/store-packs.ts`, `services/api/src/store-pack-builder.ts`, `edge/store-edge/src/store-pack.ts`, `store-pack-held.ts`, `signed-pack-file.ts`; demo builder to retire: `db/seed/pilot/store-pack.ts`, `scripts/demo-store-pack.mjs` |
| Sync, outbox, idempotency, write guards | B1 | `packages/sync/src` (`outbox.ts`, `device-outbox.ts`, `device-drain.ts`, `device-relay.ts`), `packages/persistence/src/event-store.ts`, `outbox-store.ts`, `services/kernel/src/idempotency-store.ts`, `edge/store-edge/src/sync-pipeline.ts`, `idempotency.ts`, `dead-letter-log.ts` |
| Database migrations (shared schema) | B1 | `db/migrations/0001…0014`; inventory-specific changes are requested by B2 and reviewed by B1 |
| CI configuration | B1 | `.github/workflows/ci.yml`, `scripts/assert-suite-ran.mjs`, `scripts/sbom.mjs` |
| Product identifiers, units and quantity precision | B2 | `packages/product`, `packages/catalogue`, `services/catalogue/src`; the quantity type sits in `packages/contracts/src/quantity.ts` (B1 file, B2 decides its meaning) |
| Stock locations, states, batches, reservations | B2 | `packages/stock/src`, `packages/fefo`, `packages/quality`, `packages/warehouse`, `services/inventory/src` (`sale-blocks.ts`, `goods-receipt.ts`, `warehouse-transfers.ts`, `write-off.ts`), `services/orders` reservations |
| Price, promotion, tax and rounding rules | B3 | `packages/pricing`, `packages/price-list`, `packages/promotions`, `services/pricing/src`, `packages/contracts/src/money.ts` rounding (B1 file, B3 decides the rule) |
| Transaction, payment, refund and liability states | B3 | `packages/sale`, `packages/tender/src`, `packages/settlement`, `packages/returns/src`, `packages/loyalty/src`, `packages/day-close/src`, `edge/store-edge/src/payment-attempts.ts`, `held-bills.ts`, `receipt-numbers.ts`, `till-cash.ts` |
| Report definitions and freshness timestamps | B4 | `packages/reporting/src` (`freshness.ts`, `catalogue.ts`, `consolidation.ts`), `services/reporting/src` |

## D. Counts

**Table A — the 74 findings**

| Batch | verified complete | pending software | approved deferral | external dependency | staff/device acceptance | Total |
|---|---|---|---|---|---|---|
| B1 | 6 | 5 | 1 | 0 | 0 | 12 |
| B2 | 11 | 5 | 0 | 0 | 1 | 17 |
| B3 | 8 | 9 | 0 | 0 | 0 | 17 |
| B4 | 5 | 23 | 0 | 0 | 0 | 28 |
| Total | 30 | 42 | 1 | 0 | 1 | 74 |

**Table A — residual sub-items (counted separately)**

| Batch | verified complete | pending software | approved deferral | external dependency | staff/device acceptance | Total |
|---|---|---|---|---|---|---|
| B1 | 0 | 2 | 0 | 0 | 0 | 2 |
| B2 | 0 | 0 | 0 | 0 | 0 | 0 |
| B3 | 0 | 0 | 0 | 0 | 0 | 0 |
| B4 | 0 | 0 | 0 | 0 | 0 | 0 |
| Total | 0 | 2 | 0 | 0 | 0 | 2 |

**Table B — the 104 controlling items**

| Batch | verified complete | pending software | approved deferral | external dependency | staff/device acceptance | Total |
|---|---|---|---|---|---|---|
| B1 | 1 | 7 | 1 | 4 | 1 | 14 |
| B2 | 0 | 20 | 0 | 0 | 3 | 23 |
| B3 | 0 | 24 | 0 | 1 | 0 | 25 |
| B4 | 0 | 34 | 0 | 4 | 4 | 42 |
| Total | 1 | 85 | 1 | 9 | 8 | 104 |

Check: Table A has 74 finding rows (74 distinct IDs, matching the TSV) plus 2 sub-items; Table B has 104 rows (104
distinct IDs, matching `docs/completion-status.json`); 74 + 104 = 178 rows, each with exactly one primary batch and one
state; zero unassigned, zero duplicated. Verified by script on 10 Oct 2026 (the generator asserts every count above
before it writes this file).

**Residual outside gates carried in acceptance cells (not separate rows):** GT-01 branch-protection ticks (admin);
PF-06 live acquirer/UPI; PF-12 CA, Tally, bank, GST credentials; FUL-03 payment provider; PA-08/PF-10/EA-07
message transports; EA-08 model provider; PA-12 off-site storage and spare machine; FUL-12 owner and legal
authorisation; SP-10 staff runs throughout.
