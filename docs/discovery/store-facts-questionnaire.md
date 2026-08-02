# SRE Hyper Market — Store Facts Questionnaire (Stage 1)

_A plain-language companion to `avr-closure.md`. Answering these unlocks the
store-specific build (billing, stock, pricing, GST). No computer knowledge needed._

**How to use this**
1. Each section says **who is best placed to answer** — hand that section to that person.
2. Write the answer on the **Answer** line, plus **who answered** and the **date**.
3. Rough numbers and "we don't do this yet" are fine answers — honesty beats guessing.
4. Return it to me and I load the answers into the plan and start building those features.
5. The little tag like `[AVR-02]` is just for our tracking — you can ignore it.

> Nothing here is built on a guess. Until an answer is filled in, the feature that
> depends on it waits. That is deliberate (your rule: never invent a requirement).

---

## Section A — For the Owner (the big decisions)

**A1. The "trading day" cut-off.** If a bill is rung at 12:30 am, does it count as
*yesterday's* business or *today's*? Pick the exact cut-off time your day-close and
GST should use. _Example: "Trading day ends at 11:59 pm" or "…at 2 am next morning."_
_Why it matters: it drives day-close totals, shift reports and GST periods._ **[M01-FR-02]**
- Answer: __________________________  Answered by: ____________  Date: ________

**A2. Which special departments does the store actually run?** Tick any that apply, so we
build only what you have: ☐ bakery/central kitchen ☐ deli ☐ meat/fish ☐ food court
☐ pharmacy ☐ concession / shop-in-shop counters ☐ none of these.
_Why it matters: we don't build a module for a department you don't operate._ **[AVR-12]**
- Answer: __________________________  Answered by: ____________  Date: ________

**A3. Home delivery plan.** Do you want to deliver? If yes: how far (km), your own staff or
a delivery partner, roughly how many orders a day, and any time slots? _"Not yet" is fine._
**[AVR-13]**
- Answer: __________________________  Answered by: ____________  Date: ________

**A4. Customer app / online store plan.** Which areas (pin codes) would you serve, and
which payment methods online? Any loyalty/points scheme you want from day one? _"Later" is
fine — Store-Core comes first._ **[AVR-14]**
- Answer: __________________________  Answered by: ____________  Date: ________

**A5. Hosting & support.** Budget ceiling is already set at **₹20,000/month** (D3). Do you
have a preferred internet/hosting company, and who will be the day-to-day support contact
besides you and Mr Sivakumar? **[AVR-20]**
- Answer: __________________________  Answered by: ____________  Date: ________

---

## Section B — For the Store / Floor Manager

**B1. The store's shape.** Total area (sq ft), the list of departments/aisles, how many
billing counters (lanes), any back-room/warehouse space, and any plans for more branches.
**[AVR-02]**
- Answer: __________________________  Answered by: ____________  Date: ________

**B2. How things are done today.** Briefly, how do you currently: place purchase orders,
receive goods, change prices, bill a customer, handle a return, count the cash, and close
for the day? _A few lines each is plenty._ **[AVR-07]**
- Answer: __________________________  Answered by: ____________  Date: ________

**B3. People and permissions.** What roles work in the store, who is allowed to approve a
discount / a price change / a big purchase (and up to what value), and are any logins
shared between staff today? **[AVR-08]**
- Answer: __________________________  Answered by: ____________  Date: ________

**B4. Busiest times.** Roughly how many bills at peak (per hour), your busiest days/hours,
and how often the internet or power goes out. **[AVR-17]**
- Answer: __________________________  Answered by: ____________  Date: ________

**B5. Languages & staff.** Which languages do staff and customers need (English/Tamil/other),
any accessibility needs, and how much training staff will need on a new till. **[AVR-19]**
- Answer: __________________________  Answered by: ____________  Date: ________

**B6. Licences.** Which are current: FSSAI (food), Legal Metrology (weighing/measuring),
and any other local licences/registrations — with renewal dates if handy. **[AVR-11]**
- Answer: __________________________  Answered by: ____________  Date: ________

---

## Section C — For Accounts / your CA

**C1. Legal structure.** The company name(s), each GST registration (GSTIN) and which
branch/store each covers. **[AVR-01]**
- Answer: __________________________  Answered by: ____________  Date: ________

**C2. Tally & accounting.** Which Tally version, how the company/ledgers are set up, and how
sales and purchases reach the accounts today. Also: the GST rates used for your main product
groups. **[AVR-09]**
- Answer: __________________________  Answered by: ____________  Date: ________

---

## Section D — For whoever runs the current computer/ERP system

**D1. The current system.** What software is it, which version, how can data be exported
(and do we have the **right** to extract it from the vendor)? **[AVR-03]**
- Answer: __________________________  Answered by: ____________  Date: ________

**D2. Volumes.** Roughly how many: products/SKUs, barcodes, suppliers, customers, and bills
per day. **[AVR-04]**
- Answer: __________________________  Answered by: ____________  Date: ________

**D3. Stock data quality.** How accurate is the current stock on the system vs the shelf, do
you track batch/expiry, and does the system ever show negative stock? **[AVR-05]**
- Answer: __________________________  Answered by: ____________  Date: ________

**D4. Equipment.** The computers, internet connection, in-store network, any server, UPS/
power backup, and the scanners / receipt printers / weighing scales in use. **[AVR-06]**
- Answer: __________________________  Answered by: ____________  Date: ________

**D5. Backups & incidents.** How is data backed up today, has it ever been tested by
restoring, and have there been any data loss or cyber incidents. **[AVR-16]**
- Answer: __________________________  Answered by: ____________  Date: ________

**D6. Switch-over.** Would you want to run the old and new systems side by side for a while,
when is a good window to switch, and must the old data be kept as an archive (legally)?
**[AVR-18]**
- Answer: __________________________  Answered by: ____________  Date: ________

---

## Section E — Payments

**E1. How customers pay.** Which payment providers/banks, the card/UPI machines in use, how
settlements reach your account, and how refunds are done today. **[AVR-10]**
- Answer: __________________________  Answered by: ____________  Date: ________

---

## Section F — Customers & Privacy

**F1. Customer data today.** Do you keep customer contact details, do you take consent before
messaging them, how long is data kept, and how are complaints handled. **[AVR-15]**
- Answer: __________________________  Answered by: ____________  Date: ________

---

## When you send it back
- I record each answer against its tag in `avr-closure.md` (with the named person), and the
  features that were waiting on it move from "blocked" to "building".
- Any answer you're unsure of, leave blank and we'll chase it — partial is still progress.
- The four that most unblock early work: **A1** (trading day), **B1** (store shape),
  **C1/C2** (GST & Tally), **D1** (current system & data rights).
