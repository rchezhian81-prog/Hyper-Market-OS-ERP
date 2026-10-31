# Combined fix list, 31 October 2026

**Why this list exists.** Two audits looked at the same product from different sides:
- the roadmap re-audit (`docs/audit/REAUDIT-2026-10-30.md`, every roadmap row against the code);
- the screen gap audit (`docs/audit/SCREEN-GAP-AUDIT-2026-10-31.md`, every screen opened as a real role on the demo copy).

On 31 Oct 2026 the owner chose one combined list with no duplicates, fixed in one session in the order below, most serious first. Row IDs come from the re-audit lane tables (`docs/audit/reaudit-2026-10-30/`); "Screen A–D" are the screen audit's rounds.

**Already done.**
- The urgent five (#851): M04-FR-01 Range tab, M05-FR-03/04 offer definition, M07-FR-04 bill charges, AI-SCREEN, M10-FR-02 offline samples.
- SEC-1 (#850): screens check the person's own permission.
- The kg/litre quantity fix (Screen B, first row): finished by the screen audit's session as its own pull request.

## Round 1: wrong numbers and broken actions (no owner decision needed)

| Item | Source | Where |
|---|---|---|
| Buying and requisitions order kg/litre goods 1000 times too small | Screen B | `apps/web-erp/src/buying-session.ts`, `requisitions-session.ts`, `web/buying.js` (in progress in the other session) |
| Demo opening stock for "each" goods 1000 times too big; warehouse handheld shows 1000-times quantities and codes, not names | Screen B | `db/seed/pilot/dataset.ts`, `apps/warehouse-app/web/app.js` |
| The demo's rice and oil cannot be sold properly at the till (wrong unit) | Screen B | `db/seed/pilot/dataset.ts` |
| Export says "Exported" but gives no file | Screen B | `apps/web-erp/src/browser-entry.ts` |
| A bill number cannot be keyed by hand at the till (letters, digit-only pad) | Screen B | `apps/pos/web/app.js` |
| Handhelds say "could not be reached" when the answer is "not allowed" | Screen B | `apps/warehouse-app/web/app.js` |
| Assistant drafts gives the wrong reason | Screen B | page wording |
| Supplier bills offered to the accountant, who is then refused | Screen B | `apps/web-erp/src/navigation.ts` |
| Bills captured before OB-556 already carry other charges in stock cost: prove the re-match takes it back | #851 follow-up | test only |

## Round 2: pages head office never fills (no owner decision needed)

Everything in Screen A:
- Products, Pricing, Expiry and recalls, Waste, Category rules, Finance, Reports, GST reconciliation, Company report.
- Today's approvals and PO counts.
- The owner app's takings ignore refunds.
- "No checklists" reads as "all signed".

## Round 3: the demo copy (needs owner decisions 3, 5 and 6 below)

Everything in Screen C:
- suppliers in the master;
- a till registered and a bill-number prefix issued;
- a warehouse supervisor;
- the five apps the demo does not build;
- the deployment runbook's dropped setting;
- sample work on the picker and driver handhelds;
- the self-checkout message;
- handheld writes through the front.

## Round 4: setup screens, in groups (some need owner decisions 1 and 2)

| Group | Screen audit (Screen D) | Roadmap re-audit rows |
|---|---|---|
| **4a Products and prices** | promotion rules (overlap with #851's offer definition: re-check); shelf map, planogram and floor plan | M03-FR-01..04 (categories, variants, bundles, case-pack, GST rates and cess, nutrition and allergens, substitutes, merges); M05-FR-01 (dated, zone and channel prices); M04-FR-04 (display contracts); M01-FR-01 (department categories and report); R8-8 (clusters and season plans); WF-01 |
| **4b Buying and stock** | rebate schemes | M06-FR-03 (supplier contracts, rebate schemes); M06-FR-04 (PO amend/cancel, commitment report); M09-FR-02 (stored reorder parameters, replenishment screen); WF-03; M08-FR-03 (approve handheld adjustments); D10-FR-01 (supplier advances); WF-05 (after M07-FR-04, now done); supplier portal invoice/delivery note |
| **4c People and administration** | staff list and roster; give and take back a role; register a till or device; read the audit trail; sign out inside the product; Settings duplicates Store setup; POSH committee annual report; help and procedures | M02-FR-02 (department scopes); M01-FR-03 (settings history and rollback); M01-FR-04 (branch lifecycle); M35-FR-04 (CERT-In, capacity report); M31-FR-04 (do-not-contact list) |
| **4d Money, facilities and production** | posting map and Tally ledger names; facilities and food-safety schedules, assets, monitored rooms; production recipes | M26-FR-01 (spare parts); M11-FR-03 (repack); M27-FR-03 (concession invoice and posting; the CA to confirm the GST); M21-FR-02 (campaign attribution) |

Not row gaps, kept on the list for the round they belong to:
- No screen reads expired batches or repeat orders (4b).
- The async events document lists fewer events than §30.2 (4c).
- The store-volume load test is never run in CI (Round 3).

## Owner decisions this list needs

1. **OB-613:** who is the second approver for the three owner-only requests.
2. Buyer, receiver and warehouse roles (roadmap §28: Purchase User, Purchase Approver, Receiver/QC, Warehouse User).
3. Business customers on the demo: on or off.
4. Loyalty: the cashier enrols, or Loyalty leaves the cashier's menu.
5. AI pages on the demo while live AI waits for R8 (OB-382).
6. Customer sign-in on the demo before an SMS provider exists.
7. SEC-1: a request that names nobody is refused (as built), or shows a "please sign in" page.

Each round is built, tested in full, recorded (decisions, traceability, STATUS) and merged through its own pull request before the next one starts.
