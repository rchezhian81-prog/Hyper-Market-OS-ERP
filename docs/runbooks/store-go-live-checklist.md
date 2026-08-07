# Store go-live checklist — taking SRE Retail OS into the shop

**Who this is for:** the owner and the store team. Plain English, no jargon.

**What it is:** the software is built and automatically tested. What is left before the shop
trades on it is a set of things a **person in the store** has to witness, supply, or approve —
because a test on a laptop cannot prove that the real staff can work the screens, that the real
network cable pulled mid-sale loses nothing, or that the real month's figures reconcile. This
checklist turns the formal register (`docs/registers/uat-calendar.md`, items **UAT-01…UAT-58**)
into a walk-through you can actually tick off on the day. Every line keeps its **UAT-##** number
so it ties straight back to that register.

**How to read each line:** what to do → *what a good result looks like* → **who is needed**.
Where the "good" answer is written out, that is the point of the check: the wrong answer is the
thing you are looking for.

**Order:** four phases, in the order they happen — **set-up**, **pilot**, **your real data**,
**go live**. Nothing here blocks the software; it is scheduled to the point where the store or a
named person is genuinely required.

**Want it as a timetable?** `docs/runbooks/pilot-run-sheet.md` lays these same drills out **day by
day**, with the people each one needs — a booked plan you can put your own dates on.

---

## Phase 1 — Set-up days (before the pilot)

Sit down once, work down the settings, create the logins, and get the safety net in place. There
is a **fill-in form for this** — `docs/runbooks/pilot-setup-workbook.md` turns every setting below
into a plain-English question with its default and a blank to complete.

### The configuration workshop

- [ ] **Master-data workshop (UAT-02).** Work down the Owner Configuration Register (28 items),
  accepting the sensible default or giving your own value. → *Every setting either has your value
  or a default you have seen and accepted — nothing is guessed on your behalf.* **Owner.**
- [ ] **Café set-up (UAT-03).** Recipes, yields, portion sizes, use-by periods, what is made on
  site. → *The café's own items behave like the café, not like packaged goods.* **Owner + café lead.**
- [ ] **Licence & certificate register (UAT-04).** Enter the real FSSAI, Legal Metrology, trade
  and fire documents, each with a **named** person responsible. → *Every licence has a real expiry
  date and a real person's name against it.* **Owner.**
- [ ] **Staff logins (UAT-05).** One named login per person. → *No shared accounts exist, and the
  system will not let you create one.* **Owner.**

Do these "ask a person, confirm the answer" checks in the same session — each one has a right
answer, and a wrong answer is a setting to fix now, not a surprise on a busy Saturday:

- [ ] **Blind stock-count (UAT-13).** Count one product without looking at the screen. → *The
  system refuses to correct itself until a second, more senior person approves the difference with
  a reason — and the corrected figure equals what you physically counted.* **Owner + staff.**
- [ ] **Settlement list (UAT-15).** → *The cash office shows two separate figures — not-due-yet
  vs genuinely late — and every late one has a named owner and a date.* **Owner.**
- [ ] **Erasure letter (UAT-21).** Ask the service desk what happens when a customer asks to be
  deleted. → *They can show the letter naming which records stay and which law requires them.* **Staff.**
- [ ] **Concession valuation (UAT-26).** Ask for the stock valuation. → *The concessionaire's
  stock is NOT in it* (if it were, your balance sheet, insurance and tax would all be wrong by the
  same amount). **Owner.**
- [ ] **Certification gate (UAT-28).** Ask what happens when a food-handling certificate lapses.
  → *"They can't work the deli, they can still work the shop floor" — not "they can't work" at all.* **Staff.**
- [ ] **Roster leaver (UAT-29).** Look at the Sunday-morning rota for anyone who has left. → *A
  leaver counts as nobody; the rota does not still show them covering the open.* **Owner.**
- [ ] **Waste coverage (UAT-31).** Ask why waste is down. → *If reporting coverage fell, the
  system says the number cannot be compared* — an honest "can't compare" beats a flattering figure.
  **Owner.**
- [ ] **Plan limit (UAT-34).** Ask what happens if you outgrow your plan during Diwali week. →
  *"You get an invoice." If the answer is "the tills stop", do not sign.* **Owner.**
- [ ] **Shelf-label walk (UAT-38).** Take a scanner down one aisle; compare three shelf labels
  with the till price. → *Any label showing LESS than the till charges is fixed today* — you must
  honour the shelf price, so it is a legal matter, not a margin one. **Owner + staff.**
- [ ] **Rejected-items list (UAT-40).** Ask what happens when Tally rejects something. → *"It goes
  in a list somebody works through" — never "it retries until it works", never "we clear it on
  Mondays". There is no button that empties the list.* **Owner.**
- [ ] **Where is the payment key (UAT-41).** → *A vault — not a settings screen, not a file on
  someone's machine — and someone is named responsible, with a date it was last changed.* **Owner.**
- [ ] **AI accountability (UAT-44).** Ask what happens if the AI is wrong. → *"A person had to
  approve it, and their name is on it." Never "the AI did it".* **Owner.**
- [ ] **AI cost (UAT-47).** Ask what the AI cost this month. → *A figure per assistant and a share
  of your ₹15,000 ceiling — not one single number.* **Owner.**
- [ ] **Budget exhaustion (UAT-48).** Ask what happens when an AI budget runs out. → *"The
  assistant stops and the shop carries on." Never "it keeps going and we get a bill".* **Owner.**

### Get the safety net in place

- [ ] **Incident drill (UAT-56).** Walk the first ninety seconds of the incident runbook
  (`docs/runbooks/security-incident.md`) **without reading it**: note the time, touch nothing,
  call the second custodian. → *You can do it from memory; if it needs reading, it is not usable at
  9pm.* **Owner + second custodian.**
- [ ] **Off-system contact list (UAT-57).** Write the CERT-In and payment-provider numbers
  somewhere that is **not** the system. → *A contact list stored inside the thing that is down is
  not a contact list.* **Owner.**
- [ ] **Name the security lead (UAT-58).** → *A named person is accountable for the six-hour
  breach report — not a department.* **Owner decision.**

### Schedule the two outside jobs early (they need booking)

- [ ] **Independent penetration test (UAT-10).** A paid engagement before customer launch. →
  *Booked with a date.* **Owner decision (paid).**
- [ ] **Live-AI evaluation (UAT-49).** The 8 questions in the AI "go-live" gate that need a real
  AI model — including whether expiry prediction actually beats the simple FEFO rule already
  built. → *A provider account exists first; if the model does not beat what is built, that
  assistant does not ship.* **Owner — needs a provider account first.**

---

## Phase 2 — The pilot (prove it keeps the shop safe, on the real shop)

These are the drills that matter. Most take two minutes. Group them however suits the day.

### It keeps trading when things break (this is the whole promise)

- [ ] **Unplug mid-sale (UAT-39).** Pull the internet during a sale, finish it, plug back in. →
  ***One*** *sale appears in the system, not two.* The single most important check here. **Staff.**
- [ ] **Outage mid-basket (UAT-08).** Pull the network cable mid-basket. → *The sale completes,
  prints, and later syncs exactly once.* **Staff.**
- [ ] **Cloud-down trading (UAT-43).** Ask whether the shop can sell when the cloud is down. →
  *Yes, every time — no integration can stop a till.* **Owner + staff.**
- [ ] **Parked-bill power-cut (UAT-14).** Park a bill, pull the lane's power, restart it. → *The
  bill comes back with every line; the same bill on a second lane is refused.* **Staff.**
- [ ] **Store recovery (UAT-07).** Prove the ≤30-minute recovery target in the store. → *Back
  trading inside 30 minutes with committed sales lost = 0.* **Owner + staff.**
- [ ] **Owner-witnessed destroy-and-restore (UAT-01).** ~10 minutes, you watching: back up, drop
  the database, restore, and see the line *"Restore reconciles exactly against the manifest"*, then
  watch the database refuse a hand-edit of a sale. → *Nothing lost; the edit refused.* **Owner.**
  (Runs the proven script in `docs/runbooks/backup-and-recovery.md` Part 4.)

### The money is honest

- [ ] **Refund uncertainty (UAT-16).** Ask what happens when the card machine does not answer
  during a refund. → *Nobody can mark it refunded by hand; the customer is told the true state.* **Staff.**
- [ ] **Owner drill-through (UAT-18).** On your phone, tap any figure. → *It lands on the actual
  bills behind it, and they add up to the figure you tapped.* **Owner.**
- [ ] **Brief without AI (UAT-19).** Turn the internet off overnight. → *The morning brief still
  arrives — sales, margin, baskets, cash — saying only that the written summary was unavailable.* **Owner.**
- [ ] **Scrap money (UAT-30).** Look at last month's cardboard, plastic and e-waste. → *The system
  says what a tonne fetched, flags any load sold cheap against your own average, and shows the money
  reaching the books.* **Owner.**

### Safety — recall, expiry, cold chain

- [ ] **Live recall drill (UAT-12).** Pick a real batch, recall it, time how long to say how much
  went out and which customers can be phoned. → *The lane refuses the recalled item with the network
  cable out.* **Owner + manager.**
- [ ] **Cold-room exposure (UAT-32).** Leave a cold-room door open past the grace period. → *The
  system holds EVERY batch in the room and names what they are worth; then unplug the probe and
  confirm silence reads as a fault, not "no alerts".* **Staff.**

### The customer and delivery side is honest

- [ ] **App honesty (UAT-22).** Search a product spelled wrong (still finds it); a recalled product
  does not appear at all; a just-sold-out item warns you at review, not at payment. **Staff.**
- [ ] **Cancellation releases stock (UAT-23).** Cancel an online order, look at the shelf figure.
  → *The stock comes straight back.* **Staff.**
- [ ] **Substitution policy (UAT-24).** Ask pickers what they do when an item is out and the
  customer does not answer. → *"Leave it out and don't charge" — never "send the closest thing".* **Pickers.**
- [ ] **Weighed line & crate (UAT-25).** Weigh a chicken pack; compare with the delivery invoice
  (must match to the paisa). Look inside a crate. → *Frozen is not travelling with dry goods, nor
  raw meat above ready-to-eat.* **Staff.**

### Compliance, isolation, dignity

- [ ] **Supplier-portal isolation (UAT-27).** Have a supplier try to open another supplier's
  invoice. → *Refused, and the attempt is a recorded security event you can see* (an empty screen is
  not enough). **Owner + supplier.**
- [ ] **Self-checkout dignity (UAT-36).** Put a bag on the scale. → *The screen says only that a
  colleague is coming — no "unexpected item", no accusation, in public.* **Staff.**
- [ ] **Self-checkout age (UAT-37).** Try to buy an age-restricted item at the lane. → *It always
  fetches a person, and no setting anywhere changes that.* **Staff.**
- [ ] **Unapproved peripheral (UAT-42).** Try to connect a scanner or printer nobody approved. →
  *Refused, and it tells you which ones to buy* (a refusal with no alternative gets overridden). **Staff.**

### AI is accountable

- [ ] **Two names (UAT-45).** Look at a markdown the AI suggested. → *The record shows the manager
  who approved it AND the assistant that drafted it — two names, in that order.* **Owner + manager.**
- [ ] **Pull the kill switch yourself (UAT-46).** → *It stops instantly, with nobody's approval,
  and your morning brief still arrives; and the person who pulled it cannot be the one to lift it.* **Owner.**

### The staff can actually work it

- [ ] **Usability testing with real staff (UAT-06).** Cashier, manager and warehouse task targets
  on the real screens. → *Real staff complete the everyday tasks.* Do this whenever staff are
  available. **Staff.**

### Two things to prepare during pilot prep

- [ ] **CA control-total rehearsal (UAT-17).** Walk the month's evidence pack with the CA. → *They
  see both sides of every figure (your ledger and what Tally received) and how each was derived; a
  pack that does not reconcile refuses to present itself as signable.* **CA.**
- [ ] **Invoice-layout freeze (UAT-20).** Change the address on the invoice template, then reprint
  last month's invoice. → *It still shows the OLD address* (else your copy and the customer's are no
  longer the same document — a tax problem, not a design one). **Owner.**
- [ ] **Second-shop demonstration (UAT-33).** Ask to see the system running as a different,
  imaginary retailer — different name, colours, modules, from the same installation. → *No one says a
  second customer needs "a copy of the code".* **Owner.**
- [ ] **Leave-tomorrow export (UAT-35).** Ask for all your data as if switching supplier. → *Every
  domain, in files another system can read, each with a checksum — not PDFs, not "in a few weeks".* **Owner.**

---

## Phase 3 — Bringing your real data across (migration)

The migration engine is built and rehearsed against a fake "old shop" with ten kinds of damage
planted — every fault caught. These are the human sign-offs on **your real data**.

> **Note on the legacy extract.** The register marks two items below as "blocked on the legacy
> extract (EX-02)". That block is lifted: on **7 August 2026 the owner decided we extract our own
> data ourselves** rather than wait for the old vendor (OB-06). So these proceed once our own
> extraction has been run against the real system.

- [ ] **Duplicate-product answer (UAT-50).** Ask what happens to a product that exists twice in
  the old system. → *"It is listed for somebody to decide, and nothing is merged automatically." If
  anyone says the system merges them, stop.* **Owner.**
- [ ] **Read the problem list yourself (UAT-51).** The exceptions found in the old data, money and
  tax first, each line saying — in words you can check — what was seen. → *You can check each line
  against the old system.* **Owner** (after our own extract is run).
- [ ] **Approve what we leave behind (UAT-55).** Anything not migrated needs your written approval
  and a number. → *"It is old" is not a reason — say no to it.* **Owner** (after our own extract).
- [ ] **Signature check (UAT-52).** Who signs the stock and tax figures. → *Two different people;
  the one who ran the load is neither; tax and finance are signed by your CA.* **Owner + CA.**

---

## Phase 4 — Going live, and after

- [ ] **Migration reconciliation sign-off (UAT-09).** Control totals for stock, financial, tax and
  loyalty, signed. → *Owner and CA signatures on figures that reconcile.* **Owner + CA.**
- [ ] **Watch the rollback performed (UAT-53).** Not the plan — the actual rollback, done, with a
  date. → *If the answer is "it is documented", the cutover is not ready.* **Owner + store, in a
  rehearsal window, before GO.**
- [ ] **Formal GO for cutover (UAT-11).** → *You give the explicit GO.* **Owner GO required.**
- [ ] **Old-system retirement answer (UAT-54), after cutover.** → *"It stays, read-only, until
  retention ends, and the data is never deleted." Not "we can cancel the licence next month".* **Owner.**

---

## When each phase happens

| Phase | Roadmap point | Who is mostly needed |
| --- | --- | --- |
| 1 — Set-up days | Stage 12 pilot preparation | Owner (a workshop), staff, second custodian |
| 2 — The pilot | Stage 12 pilot | Store staff, with the owner witnessing the key drills |
| 3 — Your real data | Real-data migration gate | Owner + CA, after our own extract |
| 4 — Go live | Stage 13 cutover | Owner GO; owner + CA sign-off |

Two things still sit with **you** and are not on any drill list: **choosing where it is hosted**
(the cloud vendor, budget already set) and **choosing the live AI provider** (everything runs on a
safe stand-in until then). Both are decisions, not code.

_This checklist is derived from `docs/registers/uat-calendar.md`, which stays the source of truth;
if the two ever disagree, the register wins._
