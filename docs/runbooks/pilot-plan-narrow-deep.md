# Pilot plan — narrow & deep (one department, end to end)

**Who this is for:** the owner (Mr Elanchezhian) and the store team. Plain English, no jargon.

**What this is:** the concrete plan for the **first store pilot**, in the shape the owner chose —
**narrow & deep**: one department, one or two lanes, full trading day, about **one to two weeks**. It
proves the whole trading spine — scan → sell → tender → cash-up → stock → day-close — thoroughly on a
small, low-risk slice **before** widening to the rest of the shop.

**It adds nothing new.** Every test below carries its **UAT-##** number and comes straight from
`docs/registers/uat-calendar.md` (the source of truth) and `docs/runbooks/pilot-run-sheet.md`
(the day-by-day drills). This plan only **selects and orders** the subset that applies to a single
ambient-grocery department, and says plainly what is **parked** for a later pilot and why. Keep
`docs/runbooks/store-go-live-checklist.md` open beside this — it spells out *what a good result looks
like* for each line.

**The golden rule (unchanged):** run it on the **real shop in quiet hours**, never a busy Saturday.
Tell staff plainly: *the system is being tested, not you.* **A wrong answer is a win** — a setting
fixed now instead of a surprise later.

---

## 1. Confirmed choices (owner, 24 September 2026)

The owner accepted the recommended defaults ("defaults are fine, dates TBC"). These are the **locked**
choices for this pilot; only the calendar dates remain to be filled in (§3).

| # | Choice | Confirmed | Why |
| --- | --- | --- | --- |
| A | **Which department** | ✅ **Packaged / ambient groceries** (dry goods: staples, packaged foods, household) | The simplest, lowest-risk slice to prove the spine: barcode-scanned, fixed price, standard GST, **no weighing, no cold-chain, no expiry pressure, no age limits.** If the core works cleanly here, everything harder builds on a proven base. |
| B | **How many lanes** | ✅ **Start on 1 lane; add a 2nd** once Day 1's break-things drills pass | Deep first, then a little wider. Two lanes also lets you prove the parked-bill "refused on a second lane" check (UAT-14). |
| C | **Which staff** | ✅ **2–3 named cashiers + 1 manager** who can approve exceptions | Enough to run real quiet-hours trading and to exercise the "a second, senior person approves" rules. |
| D | **How long** | ✅ ~**1–2 weeks**: 2 set-up days, then quiet-hours trading, then a review | Long enough to hit a **day-close and a cash-up** several times; short enough to stay controlled. |
| E | **Dates & the quiet slot** | ⏳ **TBC — owner to fill in** (recommended: weekday mornings) | Drop your calendar dates into the schedule table in §3 when set. |

**What the pilot runs on:** the chosen department's **real product list, prices and taxes**, loaded
with the import tools — **not** your full historical data. The big data migration (your whole
catalogue, suppliers, opening balances) is a **separate, later block** that happens *after* a
successful pilot (see §5). Payments run in **test mode** (your decision OA-4) — card/UPI go through a
safe stand-in and **no card details are ever stored**; **cash is fully real-flow**. GST is
**calculated** in-system and the month-close totals are exercised, but **nothing is filed** to the
government portal in the pilot (live filing needs your production credentials + a CA — see §6).

---

## 2. What's in this pilot, and what's parked

**In scope — the ambient-grocery trading spine:**
receiving stock into the department · shelf/price integrity · scanning and selling · cash and
test-mode card tender · returns/refunds at the desk · the offline/broken-things promise · cash-up,
day-close and the owner's figures · stock accuracy · a recall + quality-hold safety drill · staff
being able to work the screens.

**Parked for a later pilot or stage (deliberately — not forgotten):**

| Parked area | UAT items | Where it resumes |
| --- | --- | --- |
| Fresh / café / weighed / cold-chain (the hardest safety logic) | UAT-03, UAT-25, UAT-28, UAT-32 | **Fast-follow "Pilot 2 — fresh & cold-chain"** (see §4), the natural next slice |
| Online app, cancellation, picking/substitution, delivery | UAT-22, UAT-23, UAT-24 | Customer-commerce / fulfilment stages (R4/R5) |
| Self-checkout & electronic shelf labels | UAT-36, UAT-37 | Scale & innovation stage (R8) |
| Supplier portal, concessions, workforce, scrap/waste | UAT-26, UAT-27, UAT-29, UAT-30, UAT-31 | Enterprise-operations stage (R6/Stage 16) |
| AI-drafted text, two-names, kill-switch, AI cost | UAT-44…UAT-49 | Governed-AI stage (R7) — needs the AI provider account |
| SaaS / second-shop / plan-limit / full data export | UAT-33, UAT-34, UAT-35 | Scale stage (R8) |
| Tally posting & rejected-items list | UAT-40 | Integration stage (R2/R3 finance) once Tally is connected |
| Live GST filing, pen-test, privacy erasure | UAT-10, UAT-21, and M23 filing | Before **customer** launch (§6) |
| Your real data migration & the cutover GO | UAT-09, UAT-11, UAT-50…55 | The **migration & go-live block**, *after* this pilot (§5) |

Parking these is what makes the pilot **narrow**. Nothing here is cancelled; each has a named home.

---

## 3. The plan, in order

Dates are **relative** — drop your own into the schedule table below (and beside each block). Shift or
merge freely; a quiet week can do a "day" in an afternoon. Tick each as it passes.

**Schedule at a glance** — the booked sequence; fill the date column when you set them. Lanes are the
confirmed progression: **one lane** through the break-things day, **add the second** for the trading days.

| Step | Day | Lanes | Your date |
| --- | --- | --- | --- |
| Set-up Day 1 — settings & the safety base | S1 | — | __________ |
| Set-up Day 2 — load the shelf; ask & confirm | S2 | — | __________ |
| Pilot Day 1 — it keeps trading when things break | P1 | 1 | __________ |
| Pilot Day 2 — the money is honest, safety holds | P2 | 1 | __________ |
| Trading days 3…N — real quiet-hours trading | P3–P? | **add 2nd lane** | __________ |
| Review & decision — go / no-go | last | — | __________ |

### Set-up Day 1 — settings and the safety base *(mostly the owner)*
*Date: __________*

| UAT | What to do | Who | ✓ |
| --- | --- | --- | --- |
| UAT-02 | Master-data workshop — but **only the chosen department**: its products, prices, tax classes, and the store's basic config (`pilot-setup-workbook.md`) | Owner |  |
| UAT-04 | Enter the real licences (FSSAI, Legal Metrology, trade, fire), each with a **named** responsible person | Owner |  |
| UAT-05 | Create **one named login per person** — confirm no shared accounts exist and none can be made | Owner |  |
| UAT-42 | Connect the department's tills, scanner(s), receipt printer and cash drawer — an **unapproved** device is refused *and* told what to buy instead | Owner + staff |  |
| UAT-41 | Confirm where the payment key lives — a **vault**, with a named owner and a last-changed date (test-mode keys for the pilot) | Owner |  |

### Set-up Day 2 — load the shelf, and the "ask & confirm" checks *(owner + a staff member)*
*Date: __________*

| UAT | What to do | Who | ✓ |
| --- | --- | --- | --- |
| — | Receive an opening stock quantity for the department's products (goods-receipt), so the shelf figure is real | Owner + staff |  |
| UAT-38 | Shelf-label walk — compare three shelf labels with the till price; **any label under the till price is fixed today** (it is a legal matter, you must honour the shelf price) | Owner + staff |  |
| UAT-13 | Blind stock-count — count one product **off-screen**; confirm the system needs a **second, senior** approval (with a reason) to correct itself, and the corrected figure equals what was counted | Owner + staff |  |
| UAT-56 | Incident drill — walk the first 90 seconds of `security-incident.md` from memory: note the time, touch nothing, call the second custodian | Owner + 2nd custodian |  |
| UAT-57 | Off-system contact list — CERT-In and the payment provider's numbers written **outside** the system | Owner |  |
| UAT-58 | Name the security lead — a **person** accountable for the six-hour breach report | Owner |  |

### Pilot Day 1 — it keeps trading when things break *(the whole promise — owner present)*
*Date: __________ · break things on purpose and watch the shop keep selling.*

| UAT | What to do | Who | ✓ |
| --- | --- | --- | --- |
| UAT-39 | Unplug the internet mid-sale, finish it, plug back in — **one** sale appears, not two | Staff (owner watches) |  |
| UAT-08 | Pull the network cable mid-basket — the sale completes, prints, and later syncs **exactly once** | Staff |  |
| UAT-43 | Confirm the shop can sell with the **cloud down** — yes, every time | Owner + staff |  |
| UAT-14 | Park a bill, cut the lane's power, restart — it returns **in full**; then confirm a **second lane refuses** to recall it | Staff |  |
| UAT-07 | Prove the **≤30-minute** store recovery — back trading in 30 min, committed sales lost = **0** | Owner + staff |  |
| UAT-01 | Owner-witnessed **destroy-and-restore** (~10 min) — restore reconciles exactly; then the database **refuses** a hand-edit of a sale | Owner |  |

### Pilot Day 2 — the money is honest, and safety holds
*Date: __________ · the evening before, turn the internet off overnight for UAT-19.*

| UAT | What to do | Who | ✓ |
| --- | --- | --- | --- |
| UAT-19 | Brief without AI — with the internet off overnight, the **morning brief still arrives** (sales, margin, baskets, cash), saying only that the written summary was unavailable | Owner |  |
| UAT-16 | Refund uncertainty — if the card machine goes quiet during a refund, **nobody can mark it refunded by hand**, and the customer is told the true state | Staff |  |
| UAT-15 | Settlement/cash view — the cash office sees **not-due-yet vs genuinely late** as two figures, each late one with a named owner and a date | Owner |  |
| UAT-18 | Owner drill-through — tap any figure on your phone; it lands on the **real bills** behind it, and they add up to the figure you tapped | Owner |  |
| UAT-12 | **Safety drill** — recall a real (packaged) batch; time how fast the manager can say how much went out; confirm the lane **refuses to sell it with the cable out**. Then place a **quality hold** on a batch and confirm it **cannot be released for sale** except by an authorised person, and is **refused** on a failed check or expiry (the new M10-FR-02 hold/release) | Owner + manager |  |

### Trading days 3…N — real quiet-hours trading
*Dates: __________ · this is the "deep" part: actually sell, every quiet slot, and close each day.*

| Check (repeat daily) | What good looks like | Who | ✓ |
| --- | --- | --- | --- |
| Real trading | Baskets scan sub-second; the right price and tax; receipts print | Cashiers |  |
| Cash-up & day-close | The blind cash count and over/short sign-off balance; a material short **auto-opens an investigation** for a senior person | Manager |  |
| UAT-06 | Usability — real cashier, manager and stock tasks on the real screens; note anything that takes too many steps | Staff |  |
| Watch the exceptions | Sync lag, stale data and any reconciliation difference are **visible**, never silent | Owner + manager |  |

### Review & decision day — go / no-go
*Date: __________*

| Item | What to confirm | Who | ✓ |
| --- | --- | --- | --- |
| The five that matter most | UAT-39, UAT-01, UAT-07, UAT-12 all passed (UAT-46 kill-switch is parked to the AI stage) | Owner |  |
| Exit criteria (see §4) | Every "must be true" below is true for the department | Owner |  |
| UAT-17 (rehearsal) | *If the CA is free:* walk a mock month's evidence pack — a pack that does not reconcile **refuses to look signable** (full sign-off is a later cutover gate) | CA |  |
| Decision | **Widen to Pilot 2 (fresh & cold-chain)?** or fix findings and repeat? | Owner |  |

---

## 4. When is this pilot a pass? (exit criteria)

The narrow pilot passes — and you can widen — when **all** of these are true for the department:

1. **The shop never stopped selling** through every break-things drill (UAT-39, UAT-08, UAT-43, UAT-14, UAT-07) — and no sale was ever lost or duplicated.
2. **Destroy-and-restore** reconciled exactly and the ledger refused a hand-edit (UAT-01).
3. **The money reconciled every day** — cash-up/day-close balanced, over/short was signed off by a second person, and the owner's figures drilled through to real bills (UAT-18).
4. **Safety held** — the recall was refused at the lane offline, and a quality hold could not be released except by an authorised person (UAT-12 + M10-FR-02).
5. **Staff could work it** unaided in quiet hours, with no step that needed a workaround (UAT-06).
6. **Nothing failed silently** — every exception (sync lag, a variance, a refusal) was visible and had a next action.

A **no-go** on any of these is not a failure of the pilot — it is exactly what the pilot is for. Fix
the setting or the code, then re-run that drill.

**The fast-follow — "Pilot 2: fresh & cold-chain":** the natural next slice, because it exercises the
hardest safety logic this shop has — weighed items to the paisa (UAT-25), the cold-room exposure hold
(UAT-32), the certification gate on the deli (UAT-28), and the café recipes (UAT-03) — on top of a
spine already proven here.

---

## 5. After a successful pilot — your real data, then go-live

These are a **separate block**, in this order, and each needs you (and, for the figures, your CA).
They come straight from the run-sheet's migration and go-live blocks:

1. **Migration** (once our own extract is ready — your decision OB-06): duplicate-product decisions
   (UAT-50), read the problem list yourself (UAT-51), approve what's left behind (UAT-55), two-person
   + CA signatures on the loaded figures (UAT-52).
2. **Go-live cutover** (your explicit GO): watch a **real rollback** performed (UAT-53), the
   reconciliation sign-off with the CA (UAT-09), your **formal GO** (UAT-11), and the old system kept
   **read-only** until retention ends (UAT-54).

---

## 6. What to start now (outside-party clocks — they have lead times)

None of these blocks a **test-mode pilot**, but each gates full production, so starting them now runs
their clocks in parallel:

- **Payment provider** — an RBI-authorised, tokenising provider for live card/UPI, refunds and
  settlement (register EX-03). *Pilot runs in test mode without it.*
- **GST production credentials + a CA sign-off** — for live e-invoice / e-way-bill / GSTR filing
  (EX-07 / UAT-10 context). *Pilot calculates GST but does not file.*
- **Independent penetration test** — a paid external vendor, before **customer** launch (UAT-10 / EX-13).
- **Hardware & licences** — confirm the department's tills/scanners/printers/scales (EX-09) and enter
  the real FSSAI / Legal Metrology / trade / fire certificates (EX-08).

---

_Derived from `docs/registers/uat-calendar.md` and `docs/runbooks/pilot-run-sheet.md`, which stay the
source of truth; if they ever disagree, the register wins. Companion: `docs/release-plan.md` (the path
to this milestone) and `docs/runbooks/store-go-live-checklist.md` (what a good result looks like)._
