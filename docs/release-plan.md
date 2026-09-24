# SRE Retail OS — Release plan & path to a store pilot

_Owner-facing. Written in plain English. Grounded entirely in the live completion ledger
(`docs/completion-status.json`) and the roadmap's own release structure (roadmap §15, mirrored in
`docs/requirements/index.md`). No dates are invented; where a date depends on a decision only the owner or an
outside party can make, that is said plainly._

_Last updated: 24 September 2026. Re-read alongside `docs/STATUS.md`, `docs/traceability.md`, and — for the
detail behind the summaries here — `docs/runbooks/store-go-live-checklist.md` (the tickable checklist),
`docs/registers/uat-calendar.md` (the 58 in-store tests), `docs/registers/external-dependencies.md` (the
outside-party list) and `docs/OWNER-ACTION-REGISTER.md` (your decisions)._

---

## 1. The honest short answer to "when will this be done?"

There is no single finish line — there are **milestones**, and they depend on decisions and outside parties, so a
firm calendar date cannot be given honestly yet. What *can* be said precisely:

- **The build is a little over half-done by our internal measure: 55.4%** (the weighted "technical
  implementation" score). Of the 104 tracked pieces: **26 fully verified end-to-end, 9 integration-tested, 9
  wired, 58 partly built, 1 engine-only, 1 not started.**
- **Nothing has been through UAT (you testing it in the store) or gone live yet** — both of those scores are
  **0%**. That last mile is the biggest remaining phase, and it is partly yours and partly outside parties'.
- **The nearest real milestone is a store pilot on the "Store Core" (R2) scope**, not "100% of the roadmap". The
  trading spine for that pilot is mostly built and verified already; the gap is now small (see §4).
- **The roadmap's own name for that milestone is "M5 Controlled Store Core", pencilled at 1 April 2027**
  (roadmap §36.1). That is the target to aim the pilot at — reachable, but only once the owner and outside-party
  items in §6 are moving, because those have lead times that code cannot shorten.

To turn this into an actual date, three things are needed, none of them code (see §6): your **pilot scope**
decision, the **external items** (payment provider onboarding; GST production credentials + CA sign-off; an
independent penetration test; hardware and licences), and a **pace** you're comfortable with (this is one AI
building in small, tested steps).

---

## 2. Where we are today (from the ledger)

| Maturity | Count (of 104) | Meaning in plain English |
|---|---|---|
| E2E verified | 26 | Proven working in a real browser, end to end |
| Integration tested | 9 | The server pieces are proven together |
| Wired | 9 | Live on the system, not yet fully test-proven |
| Partly built | 58 | Some pieces exist; not yet joined up |
| Engine-only / not started | 2 | — |
| **UAT verified** (you tested it in-store) | **0** | Not started — can only move in the store |
| **Production verified** (live in the shop) | **0** | Not started — can only move in the shop |

**Headline (weighted): 55.4%.** The money- and safety-critical spine — the till, refunds, pricing, cash office,
stock health, expiry/recall, cold-chain **quality hold/release**, goods-receipt review, the audit trail — is the
part that is already verified end-to-end.

---

## 3. The roadmap's releases (R0–R8)

These are the roadmap's own releases (§15), not ours. The project is currently working inside **R2**.

| Release | What it delivers | Roughly where it stands |
|---|---|---|
| **R0 Definition** | Governance, requirements, architecture, data model, security & UI design, migration design | Substantially in place (this planning, the requirement register, ADRs, the completion model all exist) |
| **R1 Technical foundation** | Repo, environments, CI/CD, login/roles/approvals, audit, config, API, store edge & offline-sync proof | Substantially in place (CI is green every change; RBAC, audit trail, offline till+sync are all verified) |
| **R2 Store Core** | Product → POS → finance/Tally → owner control; **one store trades end-to-end** | **In progress — this is the pilot target (see §4)** |
| **R3 Data cutover** | Migrate your existing data, reconcile, opening balances, parallel run, rollback, archive | Migration controls MG-01…12 mostly built/integration-tested; needs your real data + the retention numbers |
| **R4 Customer commerce** | Mobile & web apps, CRM, loyalty, catalogue, cart, payment, privacy, service | Foundations exist; a larger later phase (payroll and the online store are parked here per your decisions) |
| **R5 Fulfilment** | Online orders, picking/packing, routing, delivery, proof, settlement | Foundations exist; later. **Exchanges/no-receipt returns are parked here** (change CH-01) |
| **R6 Enterprise operations** | Fresh, B2B, supplier portal, workforce, facilities, concessions, sustainability, advanced BI | Foundations exist; later. **The persisted planogram/shelf-map store is parked here** (change CH-02) |
| **R7 Governed AI** | The 10 AI agents with evaluation, authority limits, privacy, kill-switch | Several agents wired/verified; the governance gates are the work |
| **R8 Scale & innovation** | Multi-branch, SaaS readiness (selling this system to other shops), self-checkout, ESL, RFID, IoT | Later. **The paid-plan/subscription billing is parked here** (OA-12) |

---

## 4. The critical path to a store pilot (R2 "Store Core")

The roadmap defines R2 Store Core as **M01–M15, M23, M29, M30, M32–M35** — 22 modules whose job is "one store
trades end-to-end." That is the nearest milestone worth aiming at. Here is the honest state of exactly those 22:

**Already verified end-to-end (14):** M05 pricing/promotions · M06 purchase orders · M07 goods receipt · M08
stock health · M09 warehouse/counts · M10 expiry, recall & quality hold · M11 production · M12 POS/store-edge ·
M14 cash office · M15 loss prevention · M30 import/export · M32 integrations · M33 setup · M34 audit trail.

**Wired, not yet fully test-proven (3):** M02 login/roles · M03 product master · M29 reporting.

**Still partly built (5) — but read the "why" column, because most of this is *deliberately* out of pilot scope:**

| Module | Domain | What's left, and is it a real pilot gap? |
|---|---|---|
| **M01** | Organisation / config / number series | **Real, small gap.** The org hierarchy is now wired; what remains is document templates and org-scoped report roll-ups. Finish to WIRED. |
| **M04** | Merchandising / planogram | **Mostly deferred, not a pilot blocker.** All four engines are wired and shelf-compliance works today; only the *persisted* planogram store is parked to R6 by your decision (CH-02). |
| **M13** | Returns / service | **Mostly deferred, not a pilot blocker.** Returns, refunds (with the cross-lane/offline guards) and store credit are built and tested; only *exchanges* and *no-receipt* returns are parked to R5 by your decision (CH-01). |
| **M23** | Finance / GST | **Externally blocked, not a build gap.** Month-close totals and the GST safety checks are integration-tested; **live filing to the government portal** needs production credentials + a CA sign-off (§6). A pilot can trade without live filing. |
| **M35** | Ops / backup / DR | **Real, small gap.** Backup-and-restore is proven; a few operational-health/verifier legs remain. |

**So the honest remaining pilot *build* gap is much smaller than "5 modules":** it is really **M01** (document
templates + report roll-ups) and **M35** (operational-health legs), plus **hardening M02/M03/M29** toward
integration-tested where the pilot leans on them. Everything else in that list is either owner-deferred out of the
pilot (M04 planogram store → R6, M13 exchanges → R5) or externally blocked (M23 live filing) — none of which
stops one store trading end-to-end.

**The path to a pilot is therefore:**
1. **Close the small build gap** — M01 and M35 to WIRED; harden M02/M03/M29.
2. **UAT — you and your staff trade on it in the store.** Nothing is UAT-verified yet; this is the step that turns
   "built" into "trusted", and it can only happen in the shop. It needs a defined **pilot scope** from you. The
   exact tests are already written down: `docs/registers/uat-calendar.md` (58 items) and, in plain English,
   `docs/runbooks/store-go-live-checklist.md` + `docs/runbooks/pilot-run-sheet.md`.
3. **Go-live plumbing + data migration (R3)** — import your real products, suppliers and opening balances; run in
   parallel with the old system; keep a rollback (`docs/runbooks/cutover-weekend.md`).

---

## 5. Beyond the pilot

R4 (customer apps, loyalty, payments, payroll, online store), R5 (online fulfilment/delivery, exchanges), R6
(B2B, supplier portal, workforce, facilities, planogram store), R7 (governed AI) and R8 (multi-branch, SaaS
billing, self-checkout) are each substantial later phases. Their foundations largely exist in the codebase (many
are "partly built"), but they come **after** the store trades on R2 — there is no value in polishing online
delivery before the shop's own till, stock and books are trusted in daily use.

---

## 6. What's blocked on a decision or an outside party (why there's no firm date yet)

The full, tracked list lives in `docs/registers/external-dependencies.md` (EX-01…EX-14) and
`docs/OWNER-ACTION-REGISTER.md`. In plain English, the items that actually gate a pilot or full go-live:

**Yours to decide (I will not invent these):**
- **Pilot scope** — which departments/tills/staff the first real-store run covers. This sets what "done enough to
  pilot" means and unlocks the UAT step. **This is now the single most useful decision.**
- **Retention periods** — *largely handled:* a sensible default keep-schedule is now wired, so this no longer
  blocks the archive/disposal workflow. What remains is you **confirming or adjusting** the periods per data class
  (sales/GST records, CCTV, HR, audit evidence) and the DPDP customer-data clock.
- **Licences and certificates** — provide the actual FSSAI / Legal Metrology / local licence documents and a named
  responsible person for each (EX-08). The register is built; the alerts can't fire until the real ones are entered.

**Outside parties (cannot be completed by building, and have lead times):**
- **Payment provider** — an RBI-authorised, tokenising provider for card/UPI, refunds and settlement (EX-03). You
  chose to **run the pilot in test mode** (OA-4), so this does not block the pilot — but real money needs the live
  account, and card details are never stored either way (hard rule #3).
- **GST production credentials + CA sign-off** — for live e-invoice / e-way-bill / GSTR filing (EX-07). The tax is
  computed exactly in-system and sandbox-tested; **a pilot can trade without live filing**, but full production
  cannot.
- **Independent penetration test** — an external security vendor (EX-13/QG-06). Required **before customer
  launch**, not before a scoped internal pilot.
- **Store hardware** — lanes, scanners, printers, weighing scales, cash drawers (EX-09). Confirm existing or
  purchase. The performance target (scan-to-line under 300 ms) is measured on the actual pilot hardware.

**Pace** — this is one agent working in small, individually-tested, separately-reviewed steps (each a pull request
that must pass the full test gate before it merges). How fast the small remaining pilot build + hardening land
depends partly on how quickly decisions and reviews come back.

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

1. **Name the pilot scope** (which departments/tills/staff) — this unblocks planning the UAT step and confirms
   exactly the small remaining build (M01 + M35 + hardening) is the right work to finish first.
2. **Start the outside-party clocks now, in parallel** — payment-provider onboarding, GST-credential + CA
   conversation, a pen-test vendor, and hardware/licences. They have lead times and are the true gating items for
   full production even though a test-mode pilot can start without them.
3. **Confirm the retention periods** (the default is wired; your sign-off finalises it) and **enter the real
   licence/certificate details** so the compliance alerts become live.

With the pilot scope fixed, the remaining pilot build is a short, countable list, and a real target date can be
set against it — with 1 April 2027 (roadmap "M5 Controlled Store Core") as the anchor to aim at.
