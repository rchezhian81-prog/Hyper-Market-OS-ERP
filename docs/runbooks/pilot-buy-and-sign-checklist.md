# Store pilot: what to buy, sign and arrange

**Who this is for:** the owner. Plain English. Tick each box when its "done when" is true.

**What it is.** The software is built and tested. The roadmap's last count (`docs/audit/REAUDIT-2026-10-28.md`,
390 rows) has **41 rows that need something from outside**. In each case the software is finished, and what is left is
equipment to buy, a contract to sign, a person to do something, or real data. This page puts those 41 rows in the
order to start them, says who does each one, and says how you will know it is done. Every line keeps its roadmap row
ID so it ties back to the audit (`docs/audit/reaudit-2026-10-28/lane-a.md`, `lane-b.md`) and, where there is one, to the
outside-supplier register (`docs/registers/external-dependencies.md`, EX-##).

**What this page is not.** It is not a new requirement. Every line comes from those 41 rows. The drills a person
witnesses in the store (offline trading, cash, recall) are in `store-go-live-checklist.md`; the day-by-day timetable
is `pilot-run-sheet.md`; the settings form is `pilot-setup-workbook.md`. If this page and the audit ever disagree,
the audit wins.

**Already started (owner, 24 September 2026).** You started five of these. They are marked ⏳. "Started" means
the process is under way, not finished.

**Who:**
- **Owner**: you.
- **CA**: your chartered accountant.
- **IT**: whoever installs and looks after the store's computers.
- **Vendor**: the supplier of the item.
- **Reviewer**: the person you named for privacy and security reviews (OB-405).
- **Staff**: the named people for each role.

---

## Step 1. Start now: these take weeks to arrive

The test-mode pilot runs without these, but each has a long lead time and blocks full trading or the customer launch.

- [ ] **Store tills, scanners, receipt printers, cash drawers and customer displays** ⏳ (EX-09; D14-FR-01).
  **Who:** owner + IT + vendor. **Done when:** the equipment is in the store and each item has been tried with the
  system on the Devices page (each one shows as working).
- [ ] **A label printer and a legal-metrology scale** ⏳ (EX-09; M11-FR-03). These must be certified for trade.
  **Who:** owner + vendor. **Done when:** the scale's stamp certificate is entered and a weighed label prints from it.
- [ ] **An RBI-authorised payment gateway** ⏳ (EX-03; M18-FR-04, M20-FR-03, WF-13, D08-FR-04, M32-FR-04, D14-FR-03).
  Card and UPI payments, refunds and settlement. The system never stores a card number. **Who:** owner (contract) + IT
  (keys). **Done when:** the contract is signed and a real ₹1 payment and its refund appear in the day's settlement.
- [ ] **An independent penetration test** ⏳ (EX-13; SEC-09, QG-06). A paid outside security firm. Needed before
  customers use the app or website. **Who:** owner. **Done when:** the tester's report is received and every critical
  and high finding is fixed or accepted by you in writing.
- [ ] **A real live server setup for head office** (EX-01; QG-10). The cloud servers the system runs on, with their
  machine-login secrets set. **Who:** owner (choose and pay) + IT. **Done when:** a release has been put on it and its
  release record shows it came up (or rolled back by itself).
- [ ] **An off-site backup store that cannot be altered** (M35-FR-01). **Who:** owner (choose and pay) + IT. **Done
  when:** you have watched a backup be restored from it onto a spare machine.
- [ ] **Engage the CA for GST** ⏳ (EX-07). **Who:** owner + CA. **Done when:** the CA has agreed to check the GST
  file and to sign off the opening figures in Step 4.

## Step 2. Before the pilot days

- [ ] **Try every device on the real equipment** (D14-FR-01). **Who:** IT + a cashier. **Done when:** every scanner,
  printer, scale, drawer and display has been used in a real sale, and each shows as working on the Devices page.
- [ ] **Scan speed on a real till** (M12-FR-01, QG-05). The roadmap target: from scan to the line on screen in 300 ms
  or less, for 95 of every 100 scans. **Who:** IT + a cashier. **Done when:** the till's own scan-speed
  reading (which the store computer keeps) shows 300 ms or less after a full shift.
- [ ] **The 72-hour run on store equipment** (QG-04). The system runs for three days on the store's own machines
  without the queue of waiting sales building up. **Who:** IT. **Done when:** the three days are over and the store
  computer's status shows nothing stuck.
- [ ] **The tobacco notice board on the wall** (B15). **Who:** owner. **Done when:** the board is up where tobacco is
  sold, measured and photographed, and the photo is on file.
- [ ] **Online returns and the grievance contact** (WF-16, C21). Enter the return windows, the list of items that
  cannot be returned, and the grievance contact person. **Who:** owner. **Done when:** these show on the settings
  pages instead of "not set".
- [ ] **Recovery rehearsals** (QG-08). Restore from a backup, recover the store computer, roll back a release, and
  escalate an incident, all on the real store computer with the named incident team. **Who:** owner + IT + staff.
  **Done when:** all four are recorded as passed on the Incidents and recovery drills page.
- [ ] **Staff training** (QG-09). Each role finishes its course, you approve each role's list, and floor champions are
  named. **Who:** owner + staff. **Done when:** the Training and adoption page shows nobody listed as not ready.
- [ ] **Cashier speed practice** (QG-02). Cashiers practise the common till actions against the speed targets. **Who:**
  staff. **Done when:** each cashier has done the practice and met the targets, recorded on the Training and adoption page.

## Step 3. Before customers use the app, website or delivery

- [ ] **Text message (SMS), WhatsApp, email and phone-notification providers** (EX-04, EX-05; M20-FR-01, M20-FR-03,
  M21-FR-01, M29-FR-03, M29-FR-04, WF-16). Sign-in codes, order updates, offers to customers who agreed, and your own
  alerts and reports. **Who:** owner (accounts) + IT (keys). **Done when:** a test customer receives a sign-in code and
  an order update, and you receive an alert.
- [ ] **Maps, or a delivery-partner contract** (EX-10; D08-FR-05, D14-FR-04). **Who:** owner + IT. **Done when:** a
  test delivery shows the driver's live position to the customer.
- [ ] **A cheap Android phone for testing** (M20-FR-04). The customer app must run well on a low-cost phone. **Who:**
  owner (buy) + IT. **Done when:** the customer app has been used end to end on it, from search to paid order.
- [ ] **Card machine paperwork** (C11). The card-terminal model, plus the yearly PCI self-check (SAQ B / B-IP) and the
  bank's attestation (compliance register row C-08). **Who:** owner + the acquiring bank. **Done when:** the signed
  self-check and attestation are filed.

## Step 4. Bringing your real data across, then going live

These follow a successful pilot. The steps are in `real-data-load.md` and `cutover-weekend.md`.

- [ ] **Your real data, with totals signed by your CA** (QG-07). **Who:** owner + CA. **Done when:** the opening
  figures (stock, money owed, money owing, loyalty) match the outside evidence, and the CA has signed them.
- [ ] **The side-by-side run** (MG-10). The old system and this one both run for the agreed period, and differences
  are explained every day. **Who:** owner + staff. **Done when:** the agreed period is over with every difference
  explained.
- [ ] **The practice switch-over and the GO decision** (MG-11, WF-19). A rehearsal on the store computer, with the
  command team you name; then your written GO. **Who:** owner + IT + staff. **Done when:** the rehearsal is recorded
  and you have given GO in writing.

## Step 5. When you choose to: extra equipment and services

The shop trades without these. Each is finished in software and switched off until the item exists.

- [ ] **A fingerprint reader for attendance** (C21). You also sign the staff notice. **Who:** owner. **Done when:**
  a consenting staff member's fingerprint mark is accepted; one without consent is refused.
- [ ] **A handheld and printer for the queue till** (D04-FR-05). **Who:** owner + vendor. **Done when:** a queued
  basket is scanned on the handheld and paid at the till. The money switch on the handheld waits for your approval
  (ADR-0028 is still proposed).
- [ ] **A document-reading (OCR) service, or a live e-invoice feed** for supplier bills (WF-05, D03-FR-02). Until
  then a scanned bill waits for someone to type it. **Who:** owner + IT. **Done when:** a scanned supplier bill
  reaches the bill-matching screen without typing.
- [ ] **GST e-invoice credentials (GSP)** (A20). Needed only once turnover is above ₹5 crore. **Who:** owner + CA.
  **Done when:** a real e-invoice gets its official number (IRN).
- [ ] **Temperature and other sensors** (M26-FR-02). **Who:** owner + vendor. **Done when:** a cold room's readings
  appear on the Maintenance & Compliance page.
- [ ] **Electronic shelf labels, RFID and cameras** (D06-FR-06, D14-FR-05, R8-7). The roadmap places these at R8.
  Before any camera or floor device is switched on, the reviewer you named must do and record the privacy and
  security review, and that role must be granted through a second person (OB-405, OB-406). **Who:** owner + reviewer
  + vendor. **Done when:** the review is recorded, then the device is switched on.

---

## The count, so nothing is missed

All 41 rows appear above at least once:
- **Step 1:** EX-09 equipment (D14-FR-01, M11-FR-03); the payment gateway (M18-FR-04, M20-FR-03, WF-13, D08-FR-04,
  M32-FR-04, D14-FR-03); SEC-09, QG-06, QG-10, M35-FR-01.
- **Step 2:** M12-FR-01, QG-05, QG-04, B15, WF-16, C21, QG-08, QG-09, QG-02.
- **Step 3:** M20-FR-01, M21-FR-01, M29-FR-03, M29-FR-04, D08-FR-05, D14-FR-04, M20-FR-04, C11.
- **Step 4:** QG-07, MG-10, MG-11, WF-19.
- **Step 5:** D04-FR-05, WF-05, D03-FR-02, A20, M26-FR-02, D06-FR-06, D14-FR-05, R8-7.

The six rows deferred to R8 in writing are not on this page: the live Tally connector (OB-381; the daily Tally file
is used today), EDI (OB-312; the JSON API and CSV are used today) and the live-model AI parts (OB-382; switched off).
