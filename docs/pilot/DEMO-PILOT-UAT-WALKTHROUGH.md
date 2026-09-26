# Demo-pilot human-UAT walkthrough & access (Option 1)

_Non-production, synthetic data only. This is what the store's people use to run UAT on the hosted demo once
it is stood up. It gives the access method, a short role-based walkthrough, and the coverage map (which
checks are already proven by automated tests vs. which need a person). It complements the full case list in
`UAT-ROLE-CHECKLIST.md` — that is the witness sheet; this is the "how to start and what to look at"._

**Automated verification and human acceptance are recorded separately** (owner's §4): the automated column
below is already green in CI/gate; the human column is signed on the witness sheet during UAT.

## Access (filled in at stand-up)

- **Demo URL:** `https://<demo-host>/` — **pending the host (EX-01/OA-5)**; a `DEMO / PILOT — NOT PRODUCTION`
  banner is visible on every screen (build with `PILOT_DEMO_BANNER=1`).
- **HTTPS only**, behind the reverse proxy; the demo is **not** exposed without authentication.
- **Logins:** each tester gets their **own** pilot login via the local/test IdP — **no shared logins, no
  default/shared passwords** (hard rule #4). The test IdP is permitted **only** inside this isolated
  synthetic environment and is never exposed as a public bypass.
- **Sensitive actions require step-up:** granting a role and executing an erasure now require a **recent
  MFA re-auth** at the API tier (GAP-SEC-06) — testers will be re-prompted; that is the control working.
- **Data:** the seeded demo tenant `pilot-demo` (synthetic). **No real customer/product data** (that is
  Option 2, unapproved). Live payment/GST/Tally/payroll/messaging stay **off** (sandbox/simulator only).

## Role → workflow → coverage map

| # | UAT persona | Enforced role | Connected flow to walk | Automated evidence (already green) | Human check to sign |
|---|---|---|---|---|---|
| 1 | Administrator | platform_admin | log in; view health; **cannot** post a business txn | `demo-uat`, `the-platform-admin-cannot-post-...` | admin screen loads; SoD refusal visible |
| 2 | Store manager | store_manager | day dashboard; approve a return; day-close | `pilot-seed`, `authorization-is-enforced`, e2e | figures read back; approval works |
| 3 | Cashier | cashier | sign in; scan sale offline; refund; **cannot** set a price | `core-one-lane` e2e, `demo-uat` | sale rings sub-second; price denied |
| 4 | Purchase user | store_manager | propose a PO; receive goods → stock | `pilot-seed`, M06/M07 e2e | PO proposes; GRN → on-hand |
| 5 | Warehouse operator | store_manager | goods receipt; bin; pick | M07/M09 e2e | handheld GRN captures |
| 6 | Finance user | accountant | post a journal; reconcile; **cannot** set a price | `demo-uat`, finance suites | journal posts; price denied |
| 7 | HR/payroll user | owner/accountant | payroll **draft** (demo-marked, non-real) | `payroll-pay-run`, `payroll-bank-file` | draft only; no bank file leaves |
| 8 | Online-order picker | store_manager | pick list; substitution | M19 picker e2e | substitution message bilingual |
| 9 | Delivery supervisor | store_manager | dispatch; partial delivery | delivery e2e | state machine advances |
| 10 | Customer-service user | store_manager | service case; store credit refund | `store-credit-refund`, service suites | case + credit issue |
| 11 | B2B customer | (b2b entitlement) | portal login; own orders/statement | `access-durability`, portal suites | sees only own data |
| 12 | Retail customer | customer app | browse; place an online order | `customer-login` e2e, OMS suites | order reserves seeded stock |

Cross-cutting checks every tester should confirm once: **the demo banner is visible**; a **role restriction**
they lack is refused (403); **English/Tamil** both render; and an **offline sale reconnects** without loss.
The connected flows purchase-to-stock, POS-to-day-close, online order-to-delivery, return/refund,
reconciliation, GST **sandbox**, payroll **demo**, concession tagging, company reports and the privacy
workflow **simulation** are all exercised across the rows above and in `pilot-seed.test.ts` / the e2e suite.

## What stays disabled during UAT

Live payment capture, live GST/e-invoice submission, live Tally, live payroll/bank-file release, production
messaging, production/autonomous AI, production "delete my data", irreversible migration, and **all real
data**. Store-floor operation is a **separate owner GO**, not part of this UAT.

## Recording

- **Automated:** the gate (typecheck/lint/secret-scan/unit+integration/perf/e2e) is green — the machine
  column above. Re-run on the host as a smoke test.
- **Human:** each case is signed on `UAT-ROLE-CHECKLIST.md` with requirement ID, prerequisite, steps,
  expected, actual, pass/fail, severity, defect ref, retest, and business sign-off. Defects follow the
  policy in `PILOT-GATES.md` (P0/P1 block; P2 written acceptance; P3/P4 backlog; nothing closed without a
  retest; expected results are never edited to force a pass).
