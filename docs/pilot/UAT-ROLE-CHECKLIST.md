# Role-based UAT checklist (Phase 5)

_Release candidate `pilot-rc-1`. Non-production pilot only. **Authoring is autonomous; execution and
business sign-off are the owner's / the store's** (⛔ sign-off is an external gate)._

This is the formal User-Acceptance-Test checklist for the controlled pilot: **12 roles**, each with the
connected end-to-end flows they own, and a per-case row a tester fills in on the day. It complements the
owner-witness schedule `../registers/uat-calendar.md` (UAT-01…58, the "when/who") — this document is the
"who tests what, step by step, and did it pass". Cross-references to `UAT-##` are given where a case matches
a scheduled witness activity.

## How to use it

- Run against the **seeded demo tenant** `pilot-demo` on the pilot environment (see `PILOT-SEED-DATASET.md`).
  Log in as the role's demo user (e.g. `pilot-cashier`) using the pilot's test IdP.
- Fill in every field per case. A case is **Pass** only when *Actual* matches *Expected* and evidence is
  attached (a screenshot, a receipt, an exported row, or a log line).
- **Severity** on a failure: **P0** (no sale / data-integrity doubt), **P1** (a core flow blocked), **P2**
  (workaround exists), **P3/P4** (cosmetic / minor). The defect policy that decides go/hold is in Phase 7
  (`PILOT-GATES.md`).
- **Business sign-off** is the owner's or the responsible manager's initials + date. It is required to
  close the role's section.

### Per-case fields (every row carries these)

`Case ID` · `Requirement ID` · `Role` · `Prerequisite` · `Steps` · `Expected` · `Actual` · `Pass/Fail` ·
`Severity` · `Defect ref` · `Retest` · `Business sign-off`

The tables below pre-fill the fixed columns (Case ID, Requirement, Prerequisite, Steps, Expected) and leave
`Actual · Pass/Fail · Severity · Defect ref · Retest · Sign-off` blank for the tester.

---

## 1. Cashier (`pilot-cashier`)

| Case | Requirement | Prerequisite | Steps | Expected | Actual | P/F | Sev | Defect | Retest | Sign-off |
|---|---|---|---|---|---|---|---|---|---|---|
| UATR-CASH-01 | M12 · hard rule #1 · QG-04 | Till floated (demo till open); network cable OUT | Scan the demo rice + biscuits, tender cash, print | Sale completes and prints with **no network**; unsent counter rises | | | | | | |
| UATR-CASH-02 | §31.1 | UATR-CASH-01 done | Reconnect; wait for sync | The sale reaches the cloud **exactly once** (no duplicate) | | | | | | |
| UATR-CASH-03 | M13-FR-04 · §4.3 | A synced sale exists | Start a refund; simulate the card machine not answering | Refund shows **UNCONFIRMED**; it **cannot** be marked done by hand | | | | | | |
| UATR-CASH-04 | M12-FR-02 | A basket in progress | Park the bill, pull the lane's power, restart | The parked bill returns with **every line**; a second lane refuses to recall it | | | | | | |

## 2. Store manager (`pilot-manager`)

| Case | Requirement | Prerequisite | Steps | Expected | Actual | P/F | Sev | Defect | Retest | Sign-off |
|---|---|---|---|---|---|---|---|---|---|---|
| UATR-MGR-01 | M14-FR-02 · §28 | A shift with a blind cash count | Enter a counted amount that differs from expected | An over/short is raised; correcting it needs a **second, more senior** approver with a reason (UAT-13) | | | | | | |
| UATR-MGR-02 | M08-FR-03 | Seeded stock on hand | Open the stock-health dashboard | On-hand, near-expiry and negative-stock exceptions are shown, exceptions first | | | | | | |
| UATR-MGR-03 | M10-FR-02/04 | A seeded batch | Start and close a recall on that batch | The manager can state how much went out; the lane refuses the recalled item offline (UAT-12) | | | | | | |
| UATR-MGR-04 | M05 | Owner-set price rules | Launch a promotion within the rules; try one above MRP | Within-rule launches; above-MRP is refused | | | | | | |

## 3. Owner (`pilot-owner`)

| Case | Requirement | Prerequisite | Steps | Expected | Actual | P/F | Sev | Defect | Retest | Sign-off |
|---|---|---|---|---|---|---|---|---|---|---|
| UATR-OWN-01 | M29-FR-02 | A day's demo trading | Tap a headline figure on the owner app | It drills through to the actual bills behind it, and they add up (UAT-18) | | | | | | |
| UATR-OWN-02 | M29-FR-04 · AI-NFR-04 | Internet off overnight | Open the next morning's brief | The brief still arrives with sales/margin/baskets/cash; only the AI written summary is absent (UAT-19) | | | | | | |
| UATR-OWN-03 | M01-FR-01 | Org seeded | View the branch + GST registration | The branch is active and filed under the correct GSTIN | | | | | | |
| UATR-OWN-04 | §28 | — | Attempt to approve own price change | Refused — the owner cannot be their own second person | | | | | | |

## 4. Accountant (`pilot-accountant`)

| Case | Requirement | Prerequisite | Steps | Expected | Actual | P/F | Sev | Defect | Retest | Sign-off |
|---|---|---|---|---|---|---|---|---|---|---|
| UATR-ACC-01 | M14-FR-03 | Seeded tenders/settlement | Open the settlement list | Two figures shown (not-due vs genuinely late); each late one has a named owner + date (UAT-15) | | | | | | |
| UATR-ACC-02 | M14-FR-04 · §28 | A closed day | Attempt to reopen the day | Reopen is recorded and flagged; an approver lacking §28 authority is flagged, never silently allowed | | | | | | |
| UATR-ACC-03 | finance.einvoice | Sandbox e-invoice seeded | Open the e-invoice register | The sandbox invoice shows as submitted; no live IRP call is possible | | | | | | |

## 5. Chartered accountant (`pilot-ca`)

| Case | Requirement | Prerequisite | Steps | Expected | Actual | P/F | Sev | Defect | Retest | Sign-off |
|---|---|---|---|---|---|---|---|---|---|---|
| UATR-CA-01 | M23-FR-04 · QG-07 | A month's evidence pack | Walk the control-total pack | Both sides of every figure shown (our ledger + what Tally received) + derivation; a non-reconciling pack refuses to present as signable (UAT-17) | | | | | | |
| UATR-CA-02 | MG-06 · migration.controltotal.sign | Migration rehearsal totals | Attempt to sign totals as the load operator | Refused — the operator cannot sign their own totals (UAT-09 needs Owner + CA) | | | | | | |

## 6. Warehouse / goods-receipt operator (store_manager rights) 

| Case | Requirement | Prerequisite | Steps | Expected | Actual | P/F | Sev | Defect | Retest | Sign-off |
|---|---|---|---|---|---|---|---|---|---|---|
| UATR-WH-01 | M07-FR-02 | A PO / delivery | Receive a batch-tracked item with no batch or expiry | **Refused** — you cannot receive what you cannot recall | | | | | | |
| UATR-WH-02 | M07-FR-03 | A delivery with a damaged line | Receive good + damaged lines | Only the good, in-date quantity becomes sellable; damaged goes to quarantine | | | | | | |
| UATR-WH-03 | M09-FR-04 · §28 | Seeded bins | Move stock bin-to-bin; attempt a self-approved count correction | Bin move recorded; count correction needs a second approver (UAT-13) | | | | | | |

## 7. Picker — online orders (store_manager rights)

| Case | Requirement | Prerequisite | Steps | Expected | Actual | P/F | Sev | Defect | Retest | Sign-off |
|---|---|---|---|---|---|---|---|---|---|---|
| UATR-PICK-01 | M18-FR-04 · A04 | A seeded online order | Item out of stock, customer does not answer | The right action is **leave it out, don't charge** — never substitute the closest thing (UAT-24) | | | | | | |
| UATR-PICK-02 | M19-FR-03 | A pick in progress | Record a substitution with the customer's confirmation reference | The swap is accepted only WITH the reference; without it, refused on screen | | | | | | |

## 8. Delivery driver (delivery entitlement)

| Case | Requirement | Prerequisite | Steps | Expected | Actual | P/F | Sev | Defect | Retest | Sign-off |
|---|---|---|---|---|---|---|---|---|---|---|
| UATR-DEL-01 | M19-FR-03 · P-01 | An out-for-delivery order | Record a partial delivery WITH proof, then WITHOUT proof | With proof it queues on the device; without proof it is refused, nothing queued (UAT-25) | | | | | | |
| UATR-DEL-02 | §31 | Network off | Record pick-up / arrive offline | Events queue on the device and sync later, once | | | | | | |

## 9. Buyer / purchasing (store_manager rights)

| Case | Requirement | Prerequisite | Steps | Expected | Actual | P/F | Sev | Defect | Retest | Sign-off |
|---|---|---|---|---|---|---|---|---|---|---|
| UATR-BUY-01 | M06 | Seeded catalogue + supplier | Propose a purchase order | The PO proposal is recorded for approval; a buyer cannot self-approve above policy | | | | | | |
| UATR-BUY-02 | M07-FR-04 | A GRN + invoice | Run the three-way PO–GRN–invoice match | Discrepancies are valued and surfaced; the price cannot be edited at the door | | | | | | |

## 10. Supplier — portal (`pilot-supplier`, supplier role)

| Case | Requirement | Prerequisite | Steps | Expected | Actual | P/F | Sev | Defect | Retest | Sign-off |
|---|---|---|---|---|---|---|---|---|---|---|
| UATR-SUP-01 | M24-FR-01 · SEC | Two seeded suppliers | Log in as one supplier; try to open the other's invoice | **Refused**, and the attempt is a recorded security event — an empty screen is not enough (UAT-27) | | | | | | |
| UATR-SUP-02 | M24-FR-01 | Supplier login | View own orders / statement | Sees only own scoped data | | | | | | |

## 11. Customer — app / self-service (customer_app / loyalty)

| Case | Requirement | Prerequisite | Steps | Expected | Actual | P/F | Sev | Defect | Retest | Sign-off |
|---|---|---|---|---|---|---|---|---|---|---|
| UATR-CUST-01 | M20-FR-01/02 | Seeded catalogue | Search a product spelled wrong; view a recalled item | Misspelled search still finds it; a recalled item does not appear (UAT-22) | | | | | | |
| UATR-CUST-02 | M16-FR-03 · PRV | A demo customer with consent | Ask the service desk to "delete my data" | The erasure letter names which records stay and which law requires them; execution needs two people (UAT-21) — **legal confirmation required before any production use** | | | | | | |
| UATR-CUST-03 | loyalty | A demo customer with points | Check the points balance | The seeded 100-point balance shows | | | | | | |

## 12. Platform admin (`pilot-platform-admin`)

| Case | Requirement | Prerequisite | Steps | Expected | Actual | P/F | Sev | Defect | Retest | Sign-off |
|---|---|---|---|---|---|---|---|---|---|---|
| UATR-PA-01 | M36-FR-01 | — | Attempt to post a business transaction (e.g. a price change) | **Refused** — platform admin has no business-transaction authority | | | | | | |
| UATR-PA-02 | M36 | Fresh tenant | View entitlements / flags | All optional features OFF until deliberately enabled | | | | | | |
| UATR-PA-03 | M36-FR-02 | — | Show the system as a different retailer (branding/modules) | A second retailer runs from the same install — no code copy (UAT-33) | | | | | | |

---

## 13. Additions for rounds 6 to 16 (owner decisions OB-500 to OB-612, 28–30 October 2026)

Cases for what was built after this checklist was first written. Same fields and rules as above. "Shop time"
cases are run once on a laptop or phone whose clock is set to **another country** (London or New York), and
the device is set back to India time afterwards. Cases marked *after midnight* are run between 00:00 and 05:30
shop time.

### Cashier

| Case | Requirement | Prerequisite | Steps | Expected | Actual | P/F | Sev | Defect | Retest | Sign-off |
|---|---|---|---|---|---|---|---|---|---|---|
| UATR-R16-01 | OB-500 · OB-519 · OB-520 | A product with a known lowest price; a store manager present | Ask for a price cut below the lowest price; then one more than ₹100 off a line | Both refused in words on the till, network cable in or out; the manager may approve up to ₹100 a line | | | | | | |
| UATR-R16-02 | OB-500 (#831) | A manager-approved cut on one line | Change that line's quantity | Refused: the cut line keeps its quantity; void and ring again | | | | | | |
| UATR-R16-03 | OB-506 · OB-523 · OB-533 | A quotation made in the office | More → Quotation number; key it; Hold; recall; give the held basket up ("customer left without it") | Quoted prices ring up; the held basket keeps the quotation; giving it up frees it (Quotations list shows "freed again" with who and why), also with the internet out | | | | | | |
| UATR-R16-04 | OB-501 · OB-603 | A till whose app version head office has stopped | Start a new bill; key a quotation number; recall a held basket | New bill refused with "Update this till"; quotation refused and still Open; the held basket can be finished | | | | | | |
| UATR-R16-05 | OB-607 · OB-606 | Till with the network cable out | Record a concession tag with no shift; look at the "last contact" badge | Filed under today's shop date; the time shown is the shop's clock | | | | | | |

### Store manager

| Case | Requirement | Prerequisite | Steps | Expected | Actual | P/F | Sev | Defect | Retest | Sign-off |
|---|---|---|---|---|---|---|---|---|---|---|
| UATR-R16-06 | OB-505 | A product with a price per kg/litre | Print a shelf tag in English, Tamil and both | Till price never above MRP; price per kg/litre shown; a missing Tamil name is said, not left blank | | | | | | |
| UATR-R16-07 | OB-502 · OB-522 · OB-538 | A staff member whose food-handling certificate has expired | Record a production run or bakery batch as that person, network in and out | Refused in words; a renewed, verified certificate lets them record again | | | | | | |
| UATR-R16-08 | OB-507 · OB-531 · OB-539 · OB-541 | Store PC with head office unreachable, then with head office refusing its sign-in, then with the office PIN ended | Open the Rota each time | Unreachable/refused: the store computer's copy, read only, with its age and no "Assign"; PIN ended: asks for the PIN again | | | | | | |
| UATR-R16-09 | OB-540 · OB-601 | A handheld on a stopped app version did one pick offline | Reconnect; open Devices; switch language | The pick is listed with handheld, version and what was done, this store's only; "Not known" when head office cannot be reached; Tamil too | | | | | | |
| UATR-R16-10 | OB-612 | Signed in as a store manager | Open Reports → Bill findings | Only this store's bills; asking for another store is refused by name | | | | | | |
| UATR-R16-11 | OB-606 · OB-607 | Shop time (another country's clock) | Open Day book, GST returns, Store tasks → Assign, Food-safety board | Day book = the shop's yesterday; GST = the shop's last month; deadline 23:59 shop time; food-safety heading is the shop's date | | | | | | |
| UATR-R16-12 | M01-FR-02 · round 12/16 | *After midnight* | Open Waste analytics, Floor heat map, Today ("deliveries today"), a shelf plan dated today | All on the shop's date; the plan dated today is in force | | | | | | |

### Owner

| Case | Requirement | Prerequisite | Steps | Expected | Actual | P/F | Sev | Defect | Retest | Sign-off |
|---|---|---|---|---|---|---|---|---|---|---|
| UATR-R16-13 | OB-532 · OB-542 | A product never received at a cost | Make a quotation as a manager; then as yourself | Manager's: "Ask the owner to approve this price", approved by you; yours: "Ask the accountant", which you cannot approve yourself | | | | | | |
| UATR-R16-14 | OB-525 · OB-602 | A product with a known lowest price | Quote below it as a manager; then as yourself | Manager's needs you; yours needs the accountant | | | | | | |
| UATR-R16-15 | OB-610 | Bought together (basket affinity) | Draft a one-day promotion | Runs 00:00 to 23:59:59 that day, shop time | | | | | | |
| UATR-R16-16 | OB-608 · OB-606/607 | Shop time (another country's clock) | Book a dock door for 10:30; add an incident timeline entry; record a competitor price "seen at" | Each shows the typed time on the store PC (India time); 25:00 or 30 February is refused | | | | | | |
| UATR-R16-17 | M05 · round 16 | *After midnight*, on a day a new MRP starts | Publish the price pack; ring the product at the till | The till charges the new MRP that morning | | | | | | |

### Accountant

| Case | Requirement | Prerequisite | Steps | Expected | Actual | P/F | Sev | Defect | Retest | Sign-off |
|---|---|---|---|---|---|---|---|---|---|---|
| UATR-R16-18 | OB-543 · OB-600 · OB-534 · OB-548 | A delivery waiting for its bill, received by someone else | Open Goods receipt review; Match the bill with a wrong number, then the right one; try another stock screen | Wrong number refused; right one shows the bill, cost and your name; other stock screens stay closed | | | | | | |
| UATR-R16-19 | OB-542 · OB-602 | The owner's own no-floor or below-floor quotation waiting | Approvals → approve it with a reason | Approved; the owner can then make the quotation | | | | | | |
| UATR-R16-20 | OB-509 · OB-517 · OB-530 | Goods received with no order | Look at the receipt's value and the price-variance report | Valued only once its supplier bill is matched; variance uses the bill matched to that receipt | | | | | | |

### Warehouse / goods receipt

| Case | Requirement | Prerequisite | Steps | Expected | Actual | P/F | Sev | Defect | Retest | Sign-off |
|---|---|---|---|---|---|---|---|---|---|---|
| UATR-R16-21 | OB-504 · OB-605 | Van delivery (DSD) at the back door; wifi out | Scan a packed item without the month of manufacture; a batch-tracked item (milk) without batch, then without expiry; switch language | Each refused in words until set; Tamil too; set batch (scan), expiry (8 digits) and month (6 digits) and it is counted | | | | | | |
| UATR-R16-22 | OB-604 · OB-611 | One product in two batches on the same van | Scan both batches; hand some back to the driver | Each batch shows its own count; the handheld asks which batch went back (56px, Tamil); a single-batch product goes straight to "How many?" | | | | | | |
| UATR-R16-23 | OB-508 · OB-528 | A delivery short, damaged or with a different price | Book it in | Every difference names its owner (buyer or store manager), or says why none can | | | | | | |
| UATR-R16-24 | OB-534 | Signed in as the person who received the delivery | Open Goods receipt | No "Match the bill" button; the screen says someone else must match it | | | | | | |
| UATR-R16-25 | OB-536 · OB-537 | A handheld on a stopped app version | Put away goods already received; do a pick | Put-away is accepted; the pick counts and appears on Devices as done on a stopped version | | | | | | |
| UATR-R16-26 | OB-607 | Print a counter label late at night; leave the 6 a.m. rota shift empty | Read USE BY; read the rota gap message | USE BY = wall-clock time + shelf life; the gap message says 06:00 | | | | | | |

## Coverage note

These role cases exercise the **connected flows** across POS, inventory, orders/fulfilment, finance,
supplier and customer surfaces — the same guarantees the automated suite proves (`FAILURE-DRILLS.md`) and
the feature-safety posture asserts (`FEATURE-SAFETY.md`). UAT re-proves them **with real people on the real
screens**, which a test on a laptop cannot. Any case that fails is logged against the Phase-7 defect policy;
no floor pilot starts until the blocking cases pass (Phase 7 gate).

## Maturity

**UAT assets authored.** Execution and **business sign-off** are the owner's / the store's (⛔). This
document becomes **UAT approved** when every role section is signed off on the pilot environment.
