# SRE Retail OS — Readiness to go live (the honest map)

_Owner-facing. First written 14 September 2026; **refreshed 24 September 2026** to the live ledger. This is the
plain-English answer to "how close are we to a finished, 10/10 product, and what stands between here and there?"
It is grounded in `docs/completion-status.json` and `scripts/completion-report.mjs`, not opinion._

_Companion document: `docs/release-plan.md` holds the **path to the store pilot** (the R2 "Store Core"
milestone) in detail. This file is the wider "how close to a finished product, and what's locked" map. If the
numbers here and there ever differ, re-run `node scripts/completion-report.mjs` — that script is the source of
truth._

---

## 1. Where we are today

**Product completion: 55.4%** (the weighted "technical implementation" headline). The completion model
(`docs/COMPLETION-MODEL.md`) scores each of the **104 controlling items** on a maturity ladder and weights it:
NOT_STARTED 0 · ENGINE_ONLY 20 · PARTIALLY_WIRED 40 · WIRED 60 · INTEGRATION_TESTED 75 · E2E_VERIFIED 85 ·
UAT_VERIFIED 95 · PRODUCTION_VERIFIED 100.

Six separate honesty scores:

| Score | Value | Plain meaning |
|---|---|---|
| Requirements / design | 99.0% | We know what to build. |
| **Technical implementation (headline)** | **55.4%** | How much is actually built and how mature. |
| Wired-and-integrated (≥ WIRED) | 42.3% | Live on the real API, not just an engine in a test. |
| End-to-end verified | 25.0% | Proven in a real browser through the whole path. |
| UAT readiness | 0.0% | Signed off by you and the staff **in the shop**. |
| Production readiness | 0.0% | Running **live on real hardware**. |

Where every item sits: 1 NOT_STARTED · 1 ENGINE_ONLY · 58 PARTIALLY_WIRED · 9 WIRED · 9 INTEGRATION_TESTED ·
26 E2E_VERIFIED · 0 UAT · 0 PROD.

The direction of travel since this file was first written (14 Sep, 48.0% / 3 E2E): the money- and safety-critical
spine is now **verified end-to-end** — the till and offline sync, refunds (with the cross-lane and offline
guards), pricing/promotions, the cash office and over/short sign-off, stock health, expiry/recall and cold-chain
**quality hold/release**, goods-receipt review, warehouse/counts, production, and the tamper-evident audit trail.
The count of end-to-end-verified items went from 3 to 26.

## 2. What "100% / 10 out of 10" honestly means

This is the most important paragraph in this document, and it is **not an excuse — it is the definition in our
own model**: the top two rungs, **UAT_VERIFIED (95)** and **PRODUCTION_VERIFIED (100)**, are *real-world*
verification. They cannot be earned by writing code or tests. UAT means you and your staff use each part in the
store and sign it off; PRODUCTION means it is running live on the shop's real tills, scanners and cloud with
real money going through it.

**Therefore no amount of autonomous development can reach 100% on its own.** The realistic ceiling for
"software built and machine-verified, before the store is involved" is around **E2E_VERIFIED (85)** for the
parts that have a screen. The last 15–50 points per item are earned **with you, in the shop.** Any tool that
tells you it hit 100% without a real store go-live is lying to you.

## 3. What was completed autonomously in this work stream

All merged to `main`, each backed by tests + docs, each merged only on green CI. The headline moved from ~47% to
**55.4%** across many small, individually-tested steps. Highlights:

- **The whole trading spine is now E2E-verified** (see §1) — 26 items proven end-to-end in a real browser.
- **All ten AI agents' deterministic legs are wired or verified** — Inventory (A03), Purchase (A02), Operations
  (A06), Security/Fraud (A07), Data Quality (A08), Service (A05), Marketing (A09), Workforce (A10). Every one is
  **draft-only**: the AI recommends; a named human commits through the ordinary screen (hard rule #5).
- **The governance and finance backbone** — the tamper-evident audit trail across every money/privilege path,
  document retention & disposal, GST month-close totals and safety checks (filing waits on the government
  portal), migration controls MG-01…12, and the workforce/HR data stores.
- **Most recently (24 Sep):** the cold-chain **quality hold/release register** (M10-FR-02) — a batch under a
  quality check can only be released for sale by an authorised QC, and release is refused on a failed/pending
  sample, a cold-chain breach or an expired batch.

## 4. What is still buildable without you (the queue is nearly empty)

An important honesty update: two deep re-scans of the codebase (23–24 Sep) confirm the **clean, safe, pure-cloud
build queue is essentially exhausted.** What remains that can be built without a decision from you is small:

- **M01** — document templates + org-scoped report roll-ups (finish to WIRED).
- **M35** — a few operational-health / verifier legs (backup-and-restore itself is already proven).
- **Hardening** the three still-"wired" pilot modules (M02 login/roles, M03 product master, M29 reporting)
  toward integration-tested where the pilot leans on them.

Everything larger that remains is now either **owner-gated** (§5), **externally blocked** (§6), or **deliberately
deferred** to a later release. This is why the honest next step is no longer "keep building" — it is **taking what
is built into the store** (§6, §7).

## 5. What needs a decision from you (owner-gated)

- **Name the pilot scope** — which departments, tills and staff the first real-store run covers. This is now the
  single most useful decision: it defines "done enough to pilot" and unlocks the UAT step.
- **Deferred features you asked to hold** (surface them again when you want them built):
  **exchanges & no-receipt returns** (change CH-01, parked to R5), the **persisted planogram/shelf-map store**
  (change CH-02, parked to R6), and the **paid-plan/subscription billing** for selling this system to other shops
  (OA-12, parked to R8). These are the honest reason M13, M04 and M36 sit at "partly built".
- **The AI model provider** — deterministic agent guards are all built and verified; a provider account is needed
  only for the *live-model evaluation* and for AI-*drafted* text (case replies, campaign drafts, task guidance).
- **Retention periods** — *largely handled:* the default keep-schedule is wired; your sign-off finalises the
  periods per data class, plus the DPDP customer-data clock.

## 6. What needs a real-world step (nobody can self-certify these)

- **UAT — you and the staff sign off each module in the store.** This is the single biggest locked score (0%).
  The tests are already written: `docs/registers/uat-calendar.md` (58 items) and, in plain English,
  `docs/runbooks/store-go-live-checklist.md` + `docs/runbooks/pilot-run-sheet.md`.
- **Production go-live on real hardware** — tills, scanners, scales, printers, the store computer, the cloud,
  with real money (`docs/runbooks/in-store-install.md`, `docs/runbooks/cutover-weekend.md`).
- **Payment provider** — an RBI-authorised, tokenising provider for live card/UPI, refunds and settlement. You
  chose a **test-mode pilot** (OA-4), so real money — not the pilot — is what this gates.
- **Live GST-return filing + e-invoice/e-way-bill (M23)** — the government portal **production credentials** and
  a **CA/tax sign-off**. Built and sandbox-tested; a pilot can trade without live filing.
- **Independent penetration test (QG-06)** and **certified-hardware performance sign-off (QG-05)** — external
  vendor / real hardware; required before customer launch.
- **Full disaster-recovery rehearsal (QG-08)** and **migration parallel-run (MG-10)** — running old and new
  side by side in the shop for a period.
- **FSSAI / Legal Metrology / local licences (EX-08)** — enter the real certificate details and a named
  responsible person so the compliance alerts go live.

## 7. The shortest honest path to a real go-live

1. **You:** name the pilot scope; start the outside-party clocks (payment onboarding, GST credentials + CA,
   pen-test vendor, hardware, licences) since they have lead times; confirm retention periods.
2. **Me:** close the small remaining build (§4) — M01, M35, and hardening M02/M03/M29 — so the pilot spine is as
   test-proven as it can be before the store touches it.
3. **Together, in the shop:** a UAT pass module by module (`uat-calendar.md`), a migration parallel-run, then the
   production cutover — with the CA on the GST piece and an external pen-test booked.

That sequence is what turns 55.4% built into a shop actually running on this system. Steps 1 and 3 are yours to
start; step 2 is now a short list, not an open-ended queue. The roadmap's own anchor for the pilot milestone
("M5 Controlled Store Core") is **1 April 2027** — reachable, provided the step-1 clocks start moving.
