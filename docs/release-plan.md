# SRE Retail OS — Release plan & path to a store pilot

_Owner-facing. Written in plain English. Grounded entirely in the live completion ledger
(`docs/completion-status.json`) and the roadmap's own release structure (roadmap §15, mirrored in
`docs/requirements/index.md`). No dates are invented; where a date depends on a decision only the owner or an
outside party can make, that is said plainly._

_Last updated: 20 September 2026. Re-read alongside `docs/STATUS.md` and `docs/traceability.md`._

---

## 1. The honest short answer to "when will this be done?"

There is no single finish line — there are **milestones**, and they depend on decisions and outside parties, so a
firm calendar date cannot be given honestly yet. What *can* be said precisely:

- **The build is a little over half-done by our internal measure: 52.6%** (the weighted "technical
  implementation" score). Of the 104 tracked pieces: **16 fully verified end-to-end, 10 integration-tested, 15
  wired, 61 partly built, 2 barely started.**
- **Nothing has been through UAT (you testing it in the store) or gone live yet** — both of those scores are
  **0%**. That last mile is the biggest remaining phase, and it is partly yours and partly outside parties'.
- **The nearest real milestone is a store pilot on the "Store Core" (R2) scope**, not "100% of the roadmap". The
  trading spine for that pilot is mostly built and verified already; the gap is a handful of modules plus your
  in-store testing.

To turn this into an actual date, three things are needed, none of them code (see §6): your **pilot scope**
decision, the **external items** (GST production credentials + CA sign-off; an independent penetration test), and
a **pace** you're comfortable with (this is one AI building in small, tested steps).

---

## 2. Where we are today (from the ledger)

| Maturity | Count (of 104) | Meaning in plain English |
|---|---|---|
| E2E verified | 16 | Proven working in a real browser, end to end |
| Integration tested | 10 | The server pieces are proven together |
| Wired | 15 | Live on the system, not yet fully test-proven |
| Partly built | 61 | Some pieces exist; not yet joined up |
| Barely started / engine-only | 2 | — |
| **UAT verified** (you tested it in-store) | **0** | Not started |
| **Production verified** (live in the shop) | **0** | Not started |

**Headline (weighted): 52.6%.** The money- and safety-critical spine — the till, refunds, pricing, cash office,
stock health, expiry & recall, goods-receipt review, the audit trail — is the part that is already verified.

---

## 3. The roadmap's releases (R0–R8)

These are the roadmap's own releases (§15), not ours. The project is currently working inside **R2**.

| Release | What it delivers | Roughly where it stands |
|---|---|---|
| **R0 Definition** | Governance, requirements, architecture, data model, security & UI design, migration design | Substantially in place (this planning, the requirement register, ADRs, the completion model all exist) |
| **R1 Technical foundation** | Repo, environments, CI/CD, login/roles/approvals, audit, config, API, store edge & offline-sync proof | Substantially in place (CI is green every change; RBAC, audit trail, offline till+sync are all verified) |
| **R2 Store Core** | Product → POS → finance/Tally → owner control; **one store trades end-to-end** | **In progress — this is the pilot target (see §4)** |
| **R3 Data cutover** | Migrate your existing data, reconcile, opening balances, parallel run, rollback, archive | Migration controls MG-01…12 mostly built/integration-tested; needs your real data + the retention numbers |
| **R4 Customer commerce** | Mobile & web apps, CRM, loyalty, catalogue, cart, payment, privacy, service | Foundations exist; a larger later phase |
| **R5 Fulfilment** | Online orders, picking/packing, routing, delivery, proof, settlement | Foundations exist; later |
| **R6 Enterprise operations** | Fresh, B2B, supplier portal, workforce, facilities, concessions, sustainability, advanced BI | Foundations exist; later |
| **R7 Governed AI** | The 10 AI agents with evaluation, authority limits, privacy, kill-switch | Several agents wired; the governance gates are the work |
| **R8 Scale & innovation** | Multi-branch, SaaS readiness, self-checkout, ESL, RFID, IoT | Later |

---

## 4. The critical path to a store pilot (R2 "Store Core")

The roadmap defines R2 Store Core as **M01–M15, M23, M29, M30, M32–M35** — 22 modules whose job is "one store
trades end-to-end." That is the nearest milestone worth aiming at. Here is the honest state of exactly those 22:

**Already verified end-to-end (9):** M05 pricing/promotions · M08 stock health · M10 expiry & recall · M12
POS/store-edge · M14 cash office · M15 loss prevention · M30 import/export · M33 setup · M34 audit trail.

**Integration-tested (1):** M07 goods receipt (review screen browser-verified; handheld capture integration-tested).

**Wired, not yet fully test-proven (6):** M02 login/roles · M03 product master · M06 purchase orders · M09
warehouse/counts · M11 production · M29 reporting.

**Still partly built — the real remaining build gap for the pilot (6):**

| Module | Domain | What it still needs (in outline) |
|---|---|---|
| **M01** | Organisation / config / number series | Finish the org-hierarchy + config surface to WIRED |
| **M04** | Merchandising / picking | The picking flow is app-shell only; needs joining up |
| **M13** | Customer service / returns | Exchanges and parts of the service desk still pending |
| **M23** | Finance / GST | Close-totals are built; **live GST filing is externally blocked** (see §6) — the pilot can run without live filing |
| **M32** | Integrations / managed secrets | Parts wired; finish the remaining legs |
| **M35** | Ops / backup / DR | Restore proven; finish the operational-health/verifier legs |

**So the path to a pilot is:**
1. **Finish those 6 partly-built modules** up to at least WIRED (this is the bulk of the remaining pilot build).
2. **Harden the 6 wired ones** toward integration-tested where the pilot relies on them.
3. **UAT — you and your staff trade on it in the store** (nothing is UAT-verified yet; this is the step that
   turns "built" into "trusted"). This needs a defined pilot scope from you.
4. **Go-live plumbing + data migration (R3)** — import your real products, suppliers, opening balances; run in
   parallel with the old system; keep a rollback.

**None of the 6 remaining pilot modules is blocked by an outside party** except M23's *live GST filing*, and a
pilot can trade without live filing (the GST safety checks and month-close totals are already integration-tested;
filing to the government portal can follow once credentials + CA sign-off are in place).

---

## 5. Beyond the pilot

R4 (customer apps, loyalty, payments), R5 (online fulfilment/delivery), R6 (B2B, supplier portal, workforce,
facilities), R7 (governed AI), R8 (multi-branch/SaaS/self-checkout) are each substantial phases. Their
foundations largely exist in the codebase (many are "partly built"), but they are **after** the store trades on
R2 — there is no value in polishing online delivery before the shop's own till, stock and books are trusted in
daily use.

---

## 6. What's blocked on a decision (why there's no firm date yet)

**Yours to decide (I will not invent these):**
- **Retention periods** — the archive/disposal workflow needs your "keep for N years" per data class (sales/GST
  records, CCTV, HR, audit evidence). Pinned and blocking that workflow.
- **Pilot scope** — which departments/tills/staff the first real-store run covers. This sets what "done enough to
  pilot" means and unlocks the UAT step.

**Outside parties (cannot be completed by building):**
- **M23 live GST filing + e-invoice / e-way-bill** — needs your **production tax credentials** and a **CA/legal
  sign-off** (tracked; the safety checks and totals are already built).
- **QG-06 independent penetration test** — needs an **external security vendor**; required before production, not
  before a scoped pilot.

**Pace** — this is one agent working in small, individually-tested, separately-reviewed steps (each a pull
request that must pass the full test gate before it merges). How fast the remaining ~6 pilot modules + hardening
land depends partly on how quickly decisions and reviews come back.

---

## 7. How to read progress

Every working session updates three files, so the picture never drifts:
- **`docs/STATUS.md`** — what changed this session, what's next, what's blocked.
- **`docs/traceability.md`** — the module-by-module ladder (built → wired → integration-tested → E2E → UAT →
  production).
- **`docs/completion-status.json`** + `node scripts/completion-report.mjs` — the six honest scores and the
  headline %, computed from a fixed weighting (no estimates).

The headline % moves a little with each merged step; the number that will matter most next is the **UAT** score,
which stays at 0% until you start testing in the store.

---

## 8. The single most useful next decisions

1. **Give the retention numbers** (unblocks the archive/disposal workflow).
2. **Name the pilot scope** (unblocks planning the UAT step and finishing exactly the right 6 modules first).
3. **Start the GST-credential + CA conversation and line up a pen-test vendor** now, in parallel — they have lead
   times and are the true gating items for full production.

With the pilot scope fixed, the remaining pilot build is a countable list (the 6 partly-built modules + hardening
+ your in-store UAT), and a real target date can be set against it.
