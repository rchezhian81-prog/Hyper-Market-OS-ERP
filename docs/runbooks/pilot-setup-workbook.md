# Pilot set-up workbook — fill this in and you are ready to pilot

**Who this is for:** the owner. Plain English, no technical answers anywhere. Every line is a
**business fact about how your shop runs.**

**What it is:** the one sitting-down job before the pilot. This is the "master-data configuration
workshop" (UAT-02) on the go-live checklist, turned into a form you can complete. Work down it
once: for each line, either **accept the default** (tick the box and move on) or **write your
value** in the blank. Nothing here blocks the software — every item already runs on a safe
default; this is where you replace the defaults that are guesses with the facts only you know.

**Prefer a spreadsheet?** The same workbook is in this folder as **`pilot-setup-workbook.xlsx`** —
fill the yellow "Your answer" cells, and filter the Configuration tab by "Action needed" to see the
"give now" items first. It is easy to hand to your accountant (filter to the "CA / migration" rows).

**Source of truth:** every line comes from `docs/registers/owner-configuration.md` (items
OC-01…OC-47). If this workbook and that register ever disagree, the register wins.

**The rule the defaults follow:** where a wrong value would cost money or break a rule, the
default **blocks and asks** rather than guessing — so approval limits start low and "empty" means
"the system will not pretend", not "zero".

---

## Part 1 — Facts to give now (the system will not guess these)

These have **no safe default** — they are empty, or they block until you enter them, because a
guess would be wrong in a way nobody would notice. Give a value for each.

- [ ] **OC-01  Café — what is made on site, and from what** (recipes / ingredients). *No café item
  is real until entered.* **Your answer:** _____________________________
- [ ] **OC-02  Café — yield and portion size per recipe.** Entered with each recipe. **Your
  answer:** _____________________________
- [ ] **OC-03  Café — use-by / shelf-life hours per item.** A recipe cannot be saved without one.
  **Your answer:** _____________________________
- [ ] **OC-06  Trading-day cut-off — when "today" ends for the close and GST.** Default: `00:00`
  (midnight). If your day's takings roll over at, say, 11pm, say so. **Your answer:** __________
- [ ] **OC-19  Licences & certificates** — FSSAI, Legal Metrology, trade, fire — each with a
  **named** responsible person. *Alerts cannot fire until these are entered.* Use the **Licence
  register sheet** at the end of this workbook.
- [ ] **OC-21  Default GST rate and HSN per category.** A product **cannot go on sale without a
  tax class.** *Do this with your CA.* **Your answer:** _____________________________
- [ ] **OC-27  Your scales' weight/price barcode layout.** Default: the common EAN-13 scheme
  (prefix `2`). If your scales print a different one, weighed items will not ring up right. **Your
  answer:** _____________________________
- [ ] **OC-39  Loyalty tiers, and how close to one a customer must be to get asked.** *Off until
  you give the tiers.* A tier prints on every receipt. **Your answer:** ____________________
- [ ] **OC-43  Shelf addresses** — aisle / rack / bay / shelf / position, and which product lives
  where. *Empty means the pick list comes in the order items arrived, and the handheld says so.*
  Usually a walk-round job with staff. **Your answer / who will map it:** ___________________
- [ ] **OC-46  Who picks up a refill task** (which role). *A task with no owner is not a task.*
  **Your answer:** _____________________________
- [ ] **OC-47  The shelf plan (planogram)** — what belongs on each facing and how many fit.
  *Absent means the shelf check refuses outright rather than reporting "no problems".* **Your
  answer / who will build it:** _____________________________
- [ ] **OC-05  Wastage / spill reason codes.** A standard retail set is provided; add any your
  shop uses. **Your answer (additions):** _____________________________
- [ ] **OC-15  Receipt header/footer, logo, statutory lines.** A generic template is in place;
  give your shop's details. **Your answer:** _____________________________
- [ ] **OC-20  Document number formats** (invoices, POs, etc.). Default: `PREFIX-YYYY-NNNNNN`.
  Change only if you need a specific prefix or format. **Your answer:** _______________________

---

## Part 2 — Defaults to check (fine as they are unless you want to change them)

Each of these already has a sensible default. Read it; tick to accept, or write your value.

- [ ] **OC-04  Café yield tolerance before a variance is raised.** Default: **5%**. Your value: ____
- [ ] **OC-10  Approval limits** (adjustment, refund, discount, write-off, PO value). Default:
  deliberately **low**, so more needs a second person until you raise it. Your value: ____
- [ ] **OC-11  Supervisor override limit and escalation.** Default: low, escalates to store
  manager. Your value: ____
- [ ] **OC-12  Goods-in tolerances.** Default: 2% excess, 1% shortage, 30 days near-expiry, 5°C
  cold-chain. Your value: ____
- [ ] **OC-13  Three-way-match tolerances.** Default: 1% price, 0% quantity, ₹1 immaterial. Your
  value: ____
- [ ] **OC-17  Stock-ageing buckets.** Default: 0-30 / 31-60 / 61-90 / 90+ days. Your value: ____
- [ ] **OC-22  Languages on the tills and app.** Default: **English + Tamil**. Your value: ____
- [ ] **OC-23  Session timeouts / lockout.** Default: 15 min idle, 10 h absolute, 5 failed
  attempts. Your value: ____
- [ ] **OC-24  Offline identity window at the lane.** Default: 12 hours. Your value: ____
- [ ] **OC-25  Emergency-access maximum duration.** Default: 4 hours. Your value: ____

---

## Part 3 — Already decided (nothing to do — shown so you can see them)

These you (or the roadmap) already confirmed. No action; here for completeness.

- **OC-07  Age-restricted minimum age = 18** ✅
- **OC-08  Licensed selling hours = off** ✅
- **OC-09  Production departments = café only** ✅
- **OC-42  Picker's zone order = ambient → secure → chilled → frozen** ✅
- **OC-44  A shelf count stays worth acting on for 120 minutes** ✅
- **OC-45  A facing is worth refilling once it is past half-empty** ✅
- **OC-28  Backups kept 30 days, restore tested monthly** ✅ (proven at the Stage 5 gate)

---

## Part 4 — Leave for your CA, at migration (not needed to start the pilot)

These belong to bringing your **old data** across, and most need your CA. Do them at the migration
gate, not now — listed so nothing is a surprise.

- **OC-18  How long each kind of record is kept** (default: keep — never auto-delete). *With
  legal/CA.*
- **OC-29  Supplier "still in the post" window** (default: 15 days).
- **OC-30 / OC-32 / OC-37 / OC-40  What difference may be left unexplained** — all default to
  **₹0 / zero**: every difference is worked. You set the real till float (OC-32) with your CA.
- **OC-31  Card/UPI commission, GST on it, settlement lag** — taken off your **merchant
  agreement**; the check refuses to run until given.
- **OC-33  GST slabs you may have traded at** (default: the Indian set).
- **OC-34  Rounding allowed on a filed return** (default: ₹1).
- **OC-35  Which tax periods the migration covers.**
- **OC-36  Accounts only your CA has** (depreciation, provisions, accruals, prepayments,
  drawings).
- **OC-38  What one redeemed loyalty point costs you in goods.**

---

## Part 5 — Later stages (not part of pilot set-up)

- **OC-14  Delivery radius / zones** — Stage 15 (roadmap commits 10 km at launch).
- **OC-16  Message wording** (WhatsApp/SMS/email) — Stage 14.
- **OC-26  Catch-weight standard yields** — only if you sell weighed cuts.
- **OC-41  Whether customers are held at their old loyalty tier for a while after go-live** —
  decided at cutover.

---

## Sheet A — Licence & certificate register (OC-19 / checklist UAT-04)

One row per document. The system cannot warn you of an expiry it was never told about.

| Document (FSSAI, Legal Metrology, trade, fire, …) | Number | Expiry date | Responsible person |
| --- | --- | --- | --- |
|  |  |  |  |
|  |  |  |  |
|  |  |  |  |
|  |  |  |  |
|  |  |  |  |

---

## Sheet B — Staff logins (checklist UAT-05)

One named login per person — **no shared accounts**. List everyone who will use a till, the back
office, or a handheld.

| Name | Role (cashier / manager / warehouse / picker / driver …) | Deli/food certified? |
| --- | --- | --- |
|  |  |  |
|  |  |  |
|  |  |  |
|  |  |  |
|  |  |  |

---

## Sheet C — Incident quick-card (checklist UAT-56 / UAT-57 / UAT-58)

Fill this in and keep a printed copy **outside** the system — a contact list stored inside the
thing that is down is not a contact list.

- **Security lead** (the named person accountable for the 6-hour breach report): _______________
- **Second custodian** (who you call first): __________________  Phone: __________________
- **CERT-In** contact/number: __________________
- **Payment provider** emergency number: __________________
- **The first 90 seconds, from memory:** note the **time** → touch **nothing** → call the
  **second custodian**. (Full procedure: `docs/runbooks/security-incident.md`.)

---

## When you have finished

You are ready for the pilot's Phase 1. Next on the go-live checklist
(`docs/runbooks/store-go-live-checklist.md`): create the logins, then the pilot drills — most of
which take two minutes and prove the shop keeps trading when things break.

Two things still sit only with you and are **not** on this form: choosing **where it is hosted**
(the cloud vendor) and choosing the **live AI provider**. Both are decisions, not settings.
