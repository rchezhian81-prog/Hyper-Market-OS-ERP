# Screen gap audit — 31 October 2026

**Asked by the owner:** "a lot of modules are non-functional." **Scope chosen by the owner:** screens that don't work, everywhere.

**How it was checked:** four checkers opened every menu page and handheld screen as the roles the menu offers it to, against a seeded demo copy (synthetic data only; head office's real routes; a real store computer behind a copy of the demo front). Each page got one verdict:

| Verdict | Meaning |
|---|---|
| WORKS | The page's main job can be done, or it honestly says there is nothing to do yet |
| EMPTY | The page opens but has nothing, and nothing in the product will ever fill it |
| SAMPLE | The page shows made-up sample work, not real work |
| BROKEN | The page does the wrong thing (wrong numbers, cannot be reached, no file) |
| BLOCKED-BY-ROLE | The menu offers the page to a role that cannot use it, or the reverse |
| DEAD-END | The first step needs a setup screen that does not exist |

## Totals (about 160 pages and screens)

| Area | Pages | Works | Empty | Sample | Broken | Blocked by role | Dead end |
|---|---|---|---|---|---|---|---|
| Lane 1: Today, Sales, Orders, Products, Purchase, Receiving, Inventory, Floor, Production | 47 | 22 | 10 | 0 | 5 | 2 | 10 |
| Lane 2: Finance, Reports, Customers, People, Operations | 49 | 27 | 11 | 0 | 1 | 1 | 13 |
| Lane 3: Administration, Devices, sign-in, landing | ~28 | 15 (+4 split) | 4 | 3 | 1 | 1 | (in Empty) |
| Lane 4: till, kiosks, handhelds, owner, customer, supplier, B2B | 21 | 9 | 2 | 2 | 3 | 2 | 3 |

About half of the screens do their job today. The other half fall into four kinds of gap, listed below as proposed fix rounds.

## Fixed already

- **SEC-1 (security, P-04):** on the hosted copy, any signed-in person, even a cashier or the supplier login, could open the owner, manager and Admin pages and see takings and margin. The store computer now checks the person's own permissions on every screen (`edge/store-edge/src/screen-server.ts`).

## Round A — head office does not send the page its data (pages empty forever)

| Page(s) | What is missing | Where |
|---|---|---|
| Products, Pricing | product master, categories, price entries | `services/api/src/store-pack-builder.ts` |
| Expiry and recalls | batches, recalls | `store-pack-builder.ts`; `edge/store-edge/src/screen-data.ts` |
| Waste, Category rules | write-offs, category policy (and the empty page wrongly says "all clear") | `screen-data.ts` |
| Finance | ledger, postings, period state | `store-pack-builder.ts` |
| Reports | the list of what the shop records (hard-coded empty) | `store-pack-builder.ts` |
| GST reconciliation | the e-invoice and e-way bill queue | `store-pack-builder.ts` |
| Company report | nothing produces branch contributions; the page says "none reported" and "every branch reported" at once | `services/reporting/src/consolidation-route.ts` |
| Today | approvals show 0 while one is waiting; purchase orders 0 | `screen-data.ts` |
| Owner app Today | takings ignore refunds | `screen-data.ts` |
| Checklists | no checklists at all reads as "every checklist is signed" | page wording |

## Round B — wrong numbers and broken actions

| Problem | Where |
|---|---|
| Buying and requisitions order kg and litre goods 1000 times too small | `apps/web-erp/web/buying.js`, `apps/web-erp/src/buying-session.ts`, `apps/web-erp/src/requisitions-session.ts` |
| Demo opening stock for "each" goods 1000 times too big; warehouse handheld shows 1000-times quantities and codes instead of names | `db/seed/pilot/dataset.ts`; `apps/warehouse-app/web/app.js` |
| The demo's rice and oil cannot be sold properly at the till (wrong unit) | `db/seed/pilot/dataset.ts` |
| Export says "Exported" but gives no file | `apps/web-erp/src/browser-entry.ts` |
| A bill number cannot be keyed by hand at the till (letters, digit-only pad) | `apps/pos/web/app.js` |
| Handhelds show "could not be reached" when the real answer is "not allowed" | `apps/warehouse-app/web/app.js` |
| Assistant drafts gives the wrong reason ("switched off or out of budget") | page wording |
| Supplier bills offered to the accountant, who is then refused | `apps/web-erp/src/navigation.ts` |

## Round C — the demo is not set up (seed, build and front)

- Seeded suppliers are not in the supplier master, so buying refuses them.
- No till is registered at head office and no bill-number prefix is issued; close-day needs a till PIN the demo never issues.
- No warehouse supervisor is named, so Transfers cannot be used.
- The demo release does not build the supplier portal, self-checkout, price kiosk, queue till or B2B portal; the queue till and B2B portal have no route in the front.
- The deployment runbook drops a build setting the till needs (`docs/runbooks/automatic-deployment.md`).
- The picker and driver handhelds show sample work: the demo has no online order, picker or driver.
- Self-checkout is off and its message does not say which page turns it on.
- Handheld writes through the demo front are allowed only for people who may sell.

## Round D — setup screens that do not exist (dead ends)

| Missing screen | Unblocks | Size |
|---|---|---|
| Staff list and roster | Rota, Staff certificates, Appointment letters, Staff schedule, food-handler checks | L |
| Posting map and Tally ledger names | Day book, Tally files, Month-end adjustment, Supplier offer funding | M |
| Give and take back a role | Users and roles | L |
| Facilities and food-safety schedules, assets, monitored rooms | Facilities, Food-safety checks | M |
| Register a till or device | Tills and devices | M |
| Read the audit trail | Audit log | M |
| Promotion rules, rebate schemes, production recipes | those three pages | M each |
| Shelf map, planogram, floor plan | Shelves and space, Floor heat map, Shelf compliance | L |
| Internal Committee annual report | Committee annual report (POSH) | M |
| Supplier sends an invoice or delivery note | Supplier portal | M |
| Publish procedures, contacts and drills on the store computer | Help and procedures | S–M |
| Sign out inside the product; Settings duplicates Store setup | — | S |

## Owner decisions this audit needs

1. **OB-613:** who is the second approver for the three owner-only requests (decided in principle 31 Oct 2026).
2. Buyer, receiver and warehouse roles: there are none, so only the owner and manager can use those pages.
3. Business customers: switch the feature on in the demo, or leave it off.
4. Loyalty: give the cashier the enrol permission, or take Loyalty off the cashier's menu.
5. AI on the demo: the kill switch is on and no model pricing is set, so three pages do nothing.
6. Customer sign-in on the demo: ordering cannot be tried until it is switched on.
7. SEC-1: a request where the front names nobody — keep the refusal (as built) or show a "please sign in" page.

The checkers' full reports, screenshots and raw results were kept outside the repository.
